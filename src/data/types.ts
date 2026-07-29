export type ProviderId = "cl" | "cx" | "go";

export const PROVIDER_IDS: readonly ProviderId[] = ["cl", "cx", "go"] as const;

/** Whether a stored credential can currently be used to read limits. */
export type ConnectionStatus = "active" | "expired" | "none";

export type ScopeKey = "session" | "weekly";

export type RangeKey = "today" | "7d" | "30d" | "month" | "all";

export const RANGE_KEYS: readonly RangeKey[] = ["today", "7d", "30d", "month", "all"] as const;

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
  capsOutAt: string;
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
  /** One value per day, oldest first — 30 days of history. */
  daily: number[];
  /** One value per hour of today, 24 entries. */
  hourly: number[];
}

export interface ProviderUsage {
  id: ProviderId;
  meta: ProviderMeta;
  limits: UsageLimit[];
  scopes: Record<ScopeKey, ScopeSummary>;
  burn: BurnRate;
  series: UsageSeries;
  notice?: ProviderNotice;
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

/**
 * Everything the UI needs from a backend. The mock adapter ships the design's
 * sample figures; a live adapter would poll each vendor and fill the same shape.
 */
export interface UsageProvider {
  readonly scopeTitles: Record<ScopeKey, string>;
  listMeta(): Record<ProviderId, ProviderMeta>;
  initialConnections(): Record<ProviderId, ProviderConnection>;
  readSnapshot(): UsageSnapshot;
  refresh(signal?: AbortSignal): Promise<UsageSnapshot>;
  /** Masks a pasted secret before it is retained for display. */
  maskCredential(raw: string): string;
}

export const STATUS_PRESENTATION: Record<
  ConnectionStatus,
  { label: string; color: string; dot: string }
> = {
  active: { label: "active", color: "#3fb950", dot: "●" },
  expired: { label: "subscription ended", color: "#d29922", dot: "◍" },
  none: { label: "not connected", color: "#5c5c5c", dot: "○" },
};
