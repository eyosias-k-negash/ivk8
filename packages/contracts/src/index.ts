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
      | 'INVALID_BACKUP_ZIP'
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
  /** Per account included in the balance; a transfer to or from an excluded account counts on its included side. */
  byAccount: (BreakdownRow & { currency: string; incomeNative: number; expenseNative: number })[];
  /**
   * Transactions counted in the range: executed income and expense on accounts included in the balance, and transfers
   * to or from an excluded account. Transfers between included accounts never count.
   */
  count: number;
  /** Currencies whose amounts are left out of base totals because no rate was available. */
  unconverted: string[];
}

export interface TimeseriesPoint {
  bucket: string;
  /**
   * Present when groupBy != none. By category: a category id, "uncategorized", or "transfer:<from>><to>" for an
   * uncategorized transfer to or from an excluded account. By account: the account included in the balance.
   */
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

export interface BudgetInfo {
  id: string;
  name: string;
  /** Allotted amount for one calendar month, in base currency. */
  amount: number;
  categories: { id: string; name: string }[];
}

export interface BudgetsData {
  budgets: BudgetInfo[];
}

export interface BudgetBucket {
  bucket: string;
  /** Budget scaled to this bucket by exact calendar days: each day carries amount / days-in-its-month. */
  threshold: number;
  /** Money out per budget category id: expense, and categorized transfers to an excluded account. Nothing = absent. */
  spent: Record<string, number>;
}

export interface BudgetTimeseriesData {
  budget: BudgetInfo;
  from: number;
  to: number;
  granularity: Granularity;
  /** Every bucket in the range, zeros included. */
  buckets: BudgetBucket[];
  unconverted: string[];
}

export interface PlannedBucket {
  bucket: string;
  /**
   * Planned money into net worth due in the bucket (base currency): income on accounts included in the balance, and
   * transfers from excluded accounts. Keyed by category id, or "transfer:<from>><to>" for an uncategorized transfer.
   * Absent = nothing.
   */
  income: Record<string, number>;
  /** Planned money out of net worth due in the bucket; same ids as `income`. */
  expense: Record<string, number>;
  /** Projected net worth at the end of the bucket (clipped to `to`): executed history plus every planned item due by then. */
  netWorth: number;
}

export interface PlannedData {
  from: number;
  to: number;
  granularity: Granularity;
  /** Names for every id used in the buckets. Uncategorized items use id "uncategorized". */
  categories: { id: string; name: string }[];
  /** Net worth at `from`: executed transactions before it, plus planned items already due. */
  startingNetWorth: number;
  /** Every bucket in the range, zeros included. */
  buckets: PlannedBucket[];
  /** Currencies left out because no rate was available. */
  unconverted: string[];
}

export interface ProjectionBucket {
  bucket: string;
  /** actual: a complete past bucket the average is taken over; current: holds `asOf`; projected: wholly after it. */
  phase: 'actual' | 'current' | 'projected';
  /**
   * Executed money into net worth in the bucket (clipped to `to`), whatever its date relative to `asOf`, per flow id
   * (base currency). Flow ids are category ids (transfers to or from an excluded account included), "uncategorized",
   * or "transfer:<from>><to>" for an uncategorized one. Transfers between two included accounts never appear.
   */
  income: Record<string, number>;
  /** Executed money out of net worth in the bucket (clipped to `to`), per flow id; same ids as `income`. */
  expense: Record<string, number>;
  /**
   * What each inflow still lacks to reach its average, never negative; shrunk by time when `to` cuts short the part
   * of the bucket after `asOf`. Empty for actual buckets.
   */
  projectedIncome: Record<string, number>;
  /** Same as `projectedIncome`, for outflows. */
  projectedExpense: Record<string, number>;
  /**
   * Net worth at the end of the bucket (clipped to `to`): executed transactions, plus the top-ups from `asOf` on.
   * Valued like the Balances tab, so a transfer between included accounts in different currencies can move it.
   */
  netWorth: number;
}

export interface ProjectionData {
  /** The instant the projection starts from. */
  asOf: number;
  to: number;
  granularity: Granularity;
  /** Complete buckets before the current one that the average is asked to cover. */
  window: number;
  /** How many of those have any history; fewer than `window` when the data is younger. 0 = nothing to average. */
  windowUsed: number;
  /** Names for every flow id used below (categories and transfers). */
  categories: { id: string; name: string }[];
  /** Mean money in per bucket over the used window, per flow id (base currency). */
  averageIncome: Record<string, number>;
  /** Mean money out per bucket over the used window, per flow id (base currency). */
  averageExpense: Record<string, number>;
  /** Net worth at `asOf`: executed transactions up to then. Later-dated ones count in their own bucket. */
  currentNetWorth: number;
  /** The used window's buckets, then the current one, then every bucket up to `to`. */
  buckets: ProjectionBucket[];
  /** Currencies left out because no rate was available. */
  unconverted: string[];
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
