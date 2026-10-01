import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { Account, Backup, Budget, Category, Transaction, Warning } from './types';
import { DEFAULT_RULES, classify, isShellBudget, type RuleConfig } from './rules';
import schema from '../../schema/schema-new.json' with { type: 'json' };

// ESM/CJS interop for ajv packages
const AjvCtor = ((Ajv as unknown as { default?: typeof Ajv }).default ?? Ajv) as typeof Ajv;
const addFormatsFn = ((addFormats as unknown as { default?: typeof addFormats }).default ??
  addFormats) as typeof addFormats;

export class IngestError extends Error {
  constructor(
    public code: 'SCHEMA_INVALID' | 'NO_SETTINGS',
    message: string,
    public details: string[] = [],
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

let validator: ReturnType<InstanceType<typeof Ajv>['compile']> | undefined;

function getValidator() {
  if (!validator) {
    const ajv = new AjvCtor({ allErrors: true, strict: false, allowUnionTypes: true });
    addFormatsFn(ajv);
    validator = ajv.compile(schema);
  }
  return validator;
}

export interface Dataset {
  baseCurrency: string;
  rules: RuleConfig;
  /** Non-deleted entities, indexed by id. */
  accounts: Map<string, Account>;
  categories: Map<string, Category>;
  /** Non-deleted transactions (any status: executed, planned, invalid). */
  transactions: Transaction[];
  /** Non-deleted budgets that include at least one category. Shell budgets are dropped. */
  budgets: Budget[];
  /** transactionId -> tag names (missing tags/associations => empty). */
  tagsByTransaction: Map<string, string[]>;
  warnings: Warning[];
}

export interface IngestOptions {
  rules?: RuleConfig;
}

function sample<T>(items: T[], pick: (t: T) => string, n = 5): string[] {
  return items.slice(0, n).map(pick);
}

export function ingest(raw: unknown, opts: IngestOptions = {}): Dataset {
  const validate = getValidator();
  if (!validate(raw)) {
    const details = (validate.errors ?? [])
      .slice(0, 20)
      .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
    throw new IngestError('SCHEMA_INVALID', 'Backup does not match schema', details);
  }
  const data = raw as Backup;
  const rules = opts.rules ?? DEFAULT_RULES;
  const warnings: Warning[] = [];

  // Base currency from settings
  const settings = data.settings.filter((s) => !s.isDeleted);
  if (settings.length === 0) {
    throw new IngestError('NO_SETTINGS', 'No settings record found; cannot determine base currency');
  }
  if (settings.length > 1) {
    warnings.push({
      code: 'MULTIPLE_SETTINGS',
      message: 'Multiple settings records; using the first',
      count: settings.length,
    });
  }
  const baseCurrency = (settings[0] as { currency: string }).currency;

  const accounts = new Map<string, Account>();
  for (const a of data.accounts) if (!a.isDeleted) accounts.set(a.id, a);
  const categories = new Map<string, Category>();
  for (const c of data.categories) if (!c.isDeleted) categories.set(c.id, c);

  const transactions = data.transactions.filter((t) => !t.isDeleted);

  // Integrity warnings
  const invalid = transactions.filter((t) => classify(t, rules) === 'INVALID');
  if (invalid.length)
    warnings.push({
      code: 'NO_DATES',
      message: 'Transactions with neither dateTime nor dueDate were excluded',
      count: invalid.length,
      examples: sample(invalid, (t) => t.id),
    });

  const both = transactions.filter((t) => t.dueDate != null && t.dateTime != null);
  if (both.length)
    warnings.push({
      code: 'PLANNED_WITH_DATETIME',
      message: rules.plannedWins
        ? 'Transactions with both dueDate and dateTime are treated as planned (excluded from balances and totals)'
        : 'Transactions with both dueDate and dateTime are treated as executed',
      count: both.length,
      examples: sample(both, (t) => t.id),
    });

  const dangling = transactions.filter((t) => !accounts.has(t.accountId));
  if (dangling.length)
    warnings.push({
      code: 'DANGLING_ACCOUNT',
      message: 'Transactions reference an unknown or deleted account and are skipped in balances',
      count: dangling.length,
      examples: sample(dangling, (t) => t.id),
    });

  const danglingCat = transactions.filter((t) => t.categoryId && !categories.has(t.categoryId));
  if (danglingCat.length)
    warnings.push({
      code: 'DANGLING_CATEGORY',
      message: 'Transactions reference an unknown or deleted category',
      count: danglingCat.length,
      examples: sample(danglingCat, (t) => t.id),
    });

  // Budgets: drop deleted and shell budgets
  const liveBudgets = data.budgets.filter((b) => !b.isDeleted);
  const budgets = liveBudgets.filter((b) => !isShellBudget(b));
  const shells = liveBudgets.length - budgets.length;
  if (shells)
    warnings.push({
      code: 'SHELL_BUDGETS',
      message: 'Budgets with no categories were ignored',
      count: shells,
    });

  // Tags (both arrays optional; missing = empty)
  const tagNames = new Map<string, string>();
  for (const t of data.tags ?? []) if (!t.isDeleted) tagNames.set(t.id, t.name);
  const tagsByTransaction = new Map<string, string[]>();
  for (const assoc of data.tagAssociations ?? []) {
    if (assoc.isDeleted) continue;
    const name = tagNames.get(assoc.tagId);
    if (!name) continue;
    const list = tagsByTransaction.get(assoc.associatedId) ?? [];
    list.push(name);
    tagsByTransaction.set(assoc.associatedId, list);
  }

  return {
    baseCurrency,
    rules,
    accounts,
    categories,
    transactions,
    budgets,
    tagsByTransaction,
    warnings,
  };
}
