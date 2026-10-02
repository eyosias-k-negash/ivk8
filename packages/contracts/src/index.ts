/**
 * API contracts shared by all three services. Types only: no runtime code, so
 * importing this package never adds bytes to a bundle.
 *
 * Request flow: web-dashboard -> drive-sync-service (/api/*, the only public API)
 *               -> analytics-service (cluster-internal).
 * The analytics paths below are mirrored 1:1 under /api/backups/:fileId/* by drive-sync.
 */

// ---------- common ----------

export type RateSource = 'manual' | 'live' | 'fallback' | 'unavailable';

export interface RateUsed {
  currency: string;
  /** Base units per 1 unit of `currency`. null when unavailable. */
  rateToBase: number | null;
  source: RateSource;
  fetchedAt?: string;
  stale?: boolean;
}

export interface DataWarning {
  code: string;
  message: string;
  count?: number;
  examples?: string[];
}

/** Every analytics response carries these so the UI can render the rates table and warnings. */
export interface AnalyticsEnvelope<T> {
  baseCurrency: string;
  tz: string;
  ratesUsed: RateUsed[];
  warnings: DataWarning[];
  data: T;
}

/** Query params accepted by every analytics endpoint. */
export interface AnalyticsParams {
  /** Fixed UTC offset, default "+03:00". */
  tz?: string;
  /** JSON-encoded Record<currency, rateToBase>, e.g. {"USD":130.5}. Never stored. */
  rateOverrides?: string;
}

export type Granularity = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
export type GroupBy = 'none' | 'category' | 'account';

export interface ApiError {
  error: {
    code:
      | 'UNAUTHENTICATED'
      | 'REAUTH_REQUIRED'
      | 'FOLDER_NOT_SET'
      | 'NOT_FOUND'
      | 'BACKUP_TOO_LARGE'
      | 'SCHEMA_INVALID'
      | 'NO_SETTINGS'
      | 'BAD_REQUEST'
      | 'DRIVE_RATE_LIMITED'
      | 'DRIVE_UNAVAILABLE'
      | 'NOT_IMPLEMENTED'
      | 'INTERNAL';
    message: string;
    details?: string[];
  };
}

// ---------- drive-sync (public BFF) ----------

export interface Me {
  signedIn: boolean;
  email?: string;
  folderId?: string;
  folderName?: string;
}

export interface DriveFolder {
  id: string;
  name: string;
}

export interface BackupFile {
  fileId: string;
  name: string;
  modifiedTime: string;
  sizeBytes: number;
}

// ---------- analytics ----------

export interface IngestResult {
  datasetKey: string;
  baseCurrency: string;
  counts: Record<string, number>;
  warnings: DataWarning[];
}

export interface TransactionRow {
  id: string;
  type: 'INCOME' | 'EXPENSE' | 'TRANSFER';
  status: 'EXECUTED' | 'PLANNED' | 'INVALID';
  dateTime: number | null;
  dueDate: number | null;
  title: string | null;
  accountId: string;
  accountName: string;
  toAccountName: string | null;
  categoryName: string | null;
  tags: string[];
  amount: number;
  currency: string;
  amountBase: number | null;
}

export interface AccountBalance {
  accountId: string;
  name: string;
  currency: string;
  includeInBalance: boolean;
  native: number;
  base: number | null;
}

export interface BalancesData {
  asOf: number;
  accounts: AccountBalance[];
  netWorth: number;
  /** Currencies left out of netWorth because no rate was available. */
  unconverted: string[];
}

export interface BreakdownRow {
  id: string;
  name: string;
  income: number;
  expense: number;
  net: number;
}

export interface SummaryData {
  from: number;
  to: number;
  income: number;
  expense: number;
  net: number;
  byCategory: BreakdownRow[];
  byAccount: (BreakdownRow & { currency: string; incomeNative: number; expenseNative: number })[];
  /** Transactions counted in the range (executed INCOME/EXPENSE only). */
  count: number;
  /** Currencies whose amounts are left out of base totals because no rate was available. */
  unconverted: string[];
}

export interface TimeseriesPoint {
  bucket: string;
  /** Present when groupBy != none. */
  groupId?: string;
  groupName?: string;
  income: number;
  expense: number;
}

export interface TimeseriesData {
  from: number;
  to: number;
  granularity: Granularity;
  groupBy: GroupBy;
  /** Sorted by bucket, then groupName. With groupBy=none every bucket in the range is present (zeros included). */
  points: TimeseriesPoint[];
  unconverted: string[];
}

export interface BudgetStatus {
  id: string;
  name: string;
  amount: number;
  spent: number;
  remaining: number;
  /** null until day 8 of the month. */
  projected: number | null;
  categoryNames: string[];
}

export interface BudgetsData {
  month: string;
  budgets: BudgetStatus[];
}

export interface PlannedItem {
  id: string;
  title: string | null;
  type: 'INCOME' | 'EXPENSE' | 'TRANSFER';
  dueDate: number;
  state: 'OVERDUE' | 'UPCOMING';
  accountName: string;
  categoryName: string | null;
  amount: number;
  currency: string;
  amountBase: number | null;
}

export interface PlannedData {
  overdue: PlannedItem[];
  upcoming: PlannedItem[];
  totals: { overdue: number; upcoming: number };
}

export interface TagRow {
  tag: string;
  income: number;
  expense: number;
  count: number;
}

export interface TagsData {
  /** Always true: multi-tagged transactions count under each tag. */
  overlapping: true;
  tags: TagRow[];
}

export interface PayeeRow {
  title: string;
  expense: number;
  count: number;
}

export interface PayeesData {
  payees: PayeeRow[];
}
