import { COLORS } from "../theme";

export type ProviderId = "cl" | "cx" | "go";

export const PROVIDER_IDS: readonly ProviderId[] = ["cl", "cx", "go"] as const;

/** Result of the provider's most recent limits read, or its startup cache state. */
export type ConnectionStatus = "active" | "cached" | "local" | "expired" | "none";

export type ScopeKey = "session" | "weekly";

export type RangeKey = "today" | "7d" | "30d" | "month";

export const RANGE_KEYS: readonly RangeKey[] = ["today", "7d", "30d", "month"] as const;

export interface ProviderMeta {
  id: ProviderId;
  /** Lowercase display name, e.g. "claude code". */
  name: string;
  /** Plan line in settings, e.g. "Plus · shared with Work". */
  plan: string;
  /** Plan line on the compact overview card, e.g. "Plus · shared w/ Work". */
  planShort: string;
  /** Plan line on the provider detail screen. */
  planDetail: string;
  /** What the user has to supply to connect, shown during onboarding. */
  requirement: string;
  /** Where limits are read from once connected. */
  source: string;
}

export interface ProviderConnection {
  /** false hides the provider from aggregate views without dropping its credential. */
  isEnabled: boolean;
  /** Whether the provider's coding agent was found on PATH or in its local data directory. */
  isAgentInstalled?: boolean;
  status: ConnectionStatus;
  /** Masked credential, or an empty string when nothing is stored. */
  credential: string;
  note: string;
}

export interface LimitAlert {
  text: string;
  color: string;
}

export interface UsageLimit {
  id: string;
  /** Label on the compact overview card. */
  label: string;
  /** Label on the provider detail screen; falls back to `label`. */
  detailLabel?: string;
  /** null means the provider publishes no cap for this line. */
  percent: number | null;
  /** Replaces the "NN%" readout, e.g. "0" credits or "shared pool". */
  valueLabel?: string;
  valueColor?: string;
  /** Right-hand readout on the detail screen, e.g. "66% remaining". */
  detailValueLabel?: string;
  reset: string;
  /** Longer reset text used where there is room for it. */
  resetLong?: string;
  footnote?: string;
  alert?: LimitAlert;
  /** Card-only lines are omitted from the provider detail screen. */
  isCardOnly?: boolean;
}

export interface ScopeSummary {
  /** null means this provider has no cap in this window. */
  percent: number | null;
  window: string;
  reset: string;
}

export interface BurnRate {
  limit: string;
  timeToReset: string;
  rate: string;
  projectedPercent: number;
  /**
   * null when there is no cap to run out against, which makes
   * `projectedPercent` meaningless too - the measured rate is still real.
   */
  capsOutAt: string | null;
}

export interface NoticeSegment {
  text: string;
  isEmphasis?: boolean;
}

export interface ProviderNotice {
  icon?: string;
  iconColor?: string;
  segments: NoticeSegment[];
}

export interface UsageSeries {
  /** One value per day, oldest first - 30 days of history. */
  daily: number[];
  /** One value per hour of today, 24 entries. */
  hourly: number[];
}

export interface DetailRow {
  label: string;
  value: string;
  /** 0-100 renders a small share bar next to the value; null/absent renders none. */
  percent?: number | null;
  color?: string;
}

export interface DetailSection {
  title: string;
  rows: DetailRow[];
}

/**
 * Whether a figure is the provider's own number or one we derived. Rendered
 * next to every money value, so an estimate can never read as a bill.
 */
export type Exactness = "exact" | "estimated" | "unavailable";

/**
 * Whether a figure is money the user was charged, or value consumed against a
 * plan already paid for at a flat rate.
 *
 * These must never be summed. A Go subscriber can burn $40 of allowance in a
 * month and be billed nothing, so presenting the two as one total misreports
 * their spend by the entire amount.
 */
export type SpendKind = "billed" | "allowance";

export interface Money {
  /** Amount in the currency's minor unit, e.g. cents. */
  amountMinor: number;
  currency: string;
  /** Minor units per major unit, as a power of ten. 2 means cents. */
  exponent: number;
}

export interface TokenSplit {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelSpend {
  /** Canonical model id, e.g. "claude-opus-5". */
  model: string;
  /** True when this row is fast-mode usage, which bills at its own rate. */
  isFast?: boolean;
  tokens: TokenSplit;
  /** null when the model has no published price and nothing exact to apportion. */
  cost: Money | null;
  exactness: Exactness;
  /** Defaults to "billed" when absent, which is what every priced provider reports. */
  kind?: SpendKind;
}

export interface SpendPeriod {
  /** e.g. "august 2026", "this cycle". */
  label: string;
  /** Money actually charged. null when nothing is known for the period. */
  total: Money | null;
  /**
   * Value consumed against a prepaid plan, which is not a charge and is kept
   * apart from `total` rather than added to it.
   */
  allowanceUsed?: Money | null;
  /**
   * Set when the money covers a different window than the period - a billing
   * cycle rarely starts on the 1st, so the two must be labelled apart rather
   * than silently presented as the same window.
   */
  totalWindowLabel?: string;
  /** Spend cap for the period, when the provider publishes one. */
  limit: Money | null;
  exactness: Exactness;
  /** Highest spend first. */
  models: ModelSpend[];
  /**
   * True when the period predates our own records, so a missing figure means
   * "never measured" rather than "measured zero".
   */
  isBeforeRecordsBegan: boolean;
}

export interface SpendSummary {
  current: SpendPeriod;
  /** Completed periods, newest first. */
  history: SpendPeriod[];
  /** Date stamp of the shipped price table, shown wherever an estimate appears. */
  pricesAsOf: string;
  /** Models seen with no published price, so a gap is visible rather than silent. */
  unpricedModels: string[];
}

export interface ProviderUsage {
  id: ProviderId;
  meta: ProviderMeta;
  limits: UsageLimit[];
  scopes: Record<ScopeKey, ScopeSummary>;
  burn: BurnRate;
  series: UsageSeries;
  /** Whether the provider's activity series covers an account or this device. */
  activityScope?: "account" | "local";
  /**
   * false when no history source exists at all, which is not the same as a
   * measured zero and must not be rendered as one. Absent means history exists.
   */
  hasHistory?: boolean;
  /** Distinct local sessions in the raw 30-day activity window, when available. */
  sessions30d?: number;
  /**
   * Cache-read tokens over the 30-day window, in millions to match `series`.
   * Held apart from the series rather than added to it - see docs/PROVIDERS.md.
   * Absent when the source reports no cache breakdown at all, which is not the
   * same as a measured zero and must not be rendered as one.
   */
  cacheRead30d?: number;
  /** Money and per-model token history; absent when the provider exposes none. */
  spend?: SpendSummary;
  notice?: ProviderNotice;
  details?: DetailSection[];
  /** Extra stat line under the detail chart, e.g. codex code-review runs. */
  detailFooter?: string;
}

export interface UsageSnapshot {
  providers: Record<ProviderId, ProviderUsage>;
  /** ISO dates aligned with every entry in `series.daily`, oldest first. */
  dailyDates: string[];
  hourlyAxis: [string, string, string];
  fetchedAt: number;
  /** Explains why the per-provider windows are not directly comparable. */
  windowNote: string;
}

export type RefreshReason = "startup" | "interval" | "manual";

export interface RefreshRequest {
  reason: RefreshReason;
  providerIds: readonly ProviderId[];
  signal?: AbortSignal;
}

export interface PollOptions {
  signal?: AbortSignal;
  /** Manual refreshes bypass normal interval and backoff throttles. */
  force?: boolean;
}

/**
 * Everything the UI needs from a backend. The mock adapter ships the design's
 * sample figures; a live adapter would poll each vendor and fill the same shape.
 */
export interface UsageProvider {
  readonly scopeTitles: Record<ScopeKey, string>;
  listMeta(): Record<ProviderId, ProviderMeta>;
  initialConnections(): Record<ProviderId, ProviderConnection>;
  readSnapshot(): UsageSnapshot;
  refresh(request: RefreshRequest): Promise<UsageSnapshot>;
}

export const STATUS_PRESENTATION: Record<
  ConnectionStatus,
  { label: string; color: string; dot: string }
> = {
  active: { label: "active", color: COLORS.ok, dot: "●" },
  cached: { label: "cached", color: COLORS.info, dot: "◐" },
  local: { label: "local", color: COLORS.info, dot: "◐" },
  expired: { label: "failed", color: COLORS.warn, dot: "◍" },
  none: { label: "not connected", color: COLORS.textFaint, dot: "○" },
};
