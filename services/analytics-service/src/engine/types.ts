// Types mirror schema/schema-new.json. Only fields the service uses are typed in detail.

export type TxType = 'INCOME' | 'EXPENSE' | 'TRANSFER';

export interface Account {
  id: string;
  name: string;
  currency?: string | null;
  includeInBalance?: boolean;
  isDeleted?: boolean;
}

export interface Category {
  id: string;
  name: string;
  isDeleted?: boolean;
}

export interface Budget {
  id: string;
  name: string;
  amount: number;
  /** Comma-separated category UUIDs. Empty/null = shell budget (ignored). */
  categoryIdsSerialized?: string | null;
  /** Vestigial. Never read by this service. */
  accountIdsSerialized?: string | null;
  isDeleted?: boolean;
}

export interface Transaction {
  id: string;
  accountId: string;
  type: TxType;
  amount: number;
  toAccountId?: string | null;
  toAmount?: number | null;
  title?: string | null;
  description?: string | null;
  /** Epoch ms. When the transaction was executed. */
  dateTime?: number | null;
  categoryId?: string | null;
  /** Epoch ms. When the transaction was planned for. */
  dueDate?: number | null;
  recurringRuleId?: string | null;
  // loanId / loanRecordId exist in the schema but are deliberately ignored.
  isDeleted?: boolean;
}

export interface Settings {
  id: string;
  theme: string;
  currency: string;
  bufferAmount: number;
  name: string;
  isDeleted?: boolean;
}

export interface Tag {
  id: string;
  name: string;
  isDeleted?: boolean;
}

export interface TagAssociation {
  tagId: string;
  associatedId: string;
  isDeleted?: boolean;
}

export interface PlannedPaymentRule {
  id: string;
  type: string;
  accountId: string;
  amount?: number;
  categoryId?: string | null;
  isDeleted?: boolean;
}

/** Raw backup shape. loans/loanRecords are required by the schema but ignored. */
export interface Backup {
  accounts: Account[];
  budgets: Budget[];
  categories: Category[];
  loanRecords: unknown[];
  loans: unknown[];
  plannedPaymentRules: PlannedPaymentRule[];
  settings: Settings[];
  transactions: Transaction[];
  sharedPrefs: Record<string, string>;
  tags?: Tag[];
  tagAssociations?: TagAssociation[];
}

export interface Warning {
  code: string;
  message: string;
  count?: number;
  examples?: string[];
}
