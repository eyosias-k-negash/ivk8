import type { Budget, Transaction } from './types';

/**
 * Day 0 decisions live here so each rule has exactly one home.
 *
 * - dueDate != null  -> transaction is PLANNED (not executed), regardless of dateTime.
 *   (dueDate = when it was planned for; dateTime = when it was executed.)
 *   `plannedWins` exists so this can be flipped in one place if real data
 *   shows transactions carrying both fields are actually executed.
 * - dueDate == null && dateTime != null -> EXECUTED.
 * - neither -> INVALID (excluded, surfaced as a warning).
 * - loanId / loanRecordId are ignored: those transactions are normal.
 */
export interface RuleConfig {
  plannedWins: boolean;
}

export const DEFAULT_RULES: RuleConfig = { plannedWins: true };

export type TxStatus = 'DELETED' | 'EXECUTED' | 'PLANNED' | 'INVALID';

export function classify(t: Transaction, cfg: RuleConfig = DEFAULT_RULES): TxStatus {
  if (t.isDeleted) return 'DELETED';
  const hasDue = t.dueDate != null;
  const hasDate = t.dateTime != null;
  if (hasDue && hasDate && !cfg.plannedWins) return 'EXECUTED';
  if (hasDue) return 'PLANNED';
  if (hasDate) return 'EXECUTED';
  return 'INVALID';
}

export type PlannedState = 'OVERDUE' | 'UPCOMING';

/** Only call for transactions classified PLANNED. */
export function plannedState(t: Transaction, nowMs: number): PlannedState {
  return (t.dueDate as number) < nowMs ? 'OVERDUE' : 'UPCOMING';
}

/** Comma-separated id list -> trimmed, non-empty ids. Null/undefined/"" -> []. */
export function parseIds(serialized?: string | null): string[] {
  if (!serialized) return [];
  return serialized
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A budget with no categories includes nothing: a useless shell, ignored. */
export function isShellBudget(b: Budget): boolean {
  return parseIds(b.categoryIdsSerialized).length === 0;
}
