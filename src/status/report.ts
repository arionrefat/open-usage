import {
  PROVIDER_IDS,
  type ConnectionStatus,
  type ProviderConnection,
  type ProviderId,
  type ProviderUsage,
  type UsageLimit,
  type UsageSnapshot,
} from "../data/types";

/** Bumped only for a breaking change; new fields may appear within a version. */
export const STATUS_SCHEMA_VERSION = "open-usage.v1";

/** The names `--view` already takes, rather than the internal two-letter ids. */
export type PublicProviderId = "claude" | "codex" | "go";

const PUBLIC_PROVIDER_IDS: Record<ProviderId, PublicProviderId> = { cl: "claude", cx: "codex", go: "go" };

export interface StatusLimit {
  id: string;
  label: string;
  /** null when the provider publishes no cap for this line. */
  usedPercent: number | null;
  remainingPercent: number | null;
  /** null for a billing cycle or a window the provider does not state. */
  windowMinutes: number | null;
  /** ISO 8601, or null when the provider states no time. */
  resetsAt: string | null;
  /** The reset time has passed since the reading, so `usedPercent` is out of date. */
  hasResetSinceRead: boolean;
  /** The dashboard's own wording, e.g. "resets in 2h 14m". */
  reset: string;
}

export interface StatusProvider {
  id: PublicProviderId;
  name: string;
  plan: string;
  /** Where the limits were read from, e.g. "codex app-server". */
  source: string;
  status: ConnectionStatus;
  /** When the reading behind `limits` was taken, ISO 8601. */
  updatedAt: string | null;
  /** The provider's own reason for refusing usage, which can hold below every cap. */
  blockedReason: string | null;
  limits: StatusLimit[];
}

export interface StatusError {
  provider: PublicProviderId;
  message: string;
}

export interface StatusReport {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  generatedAt: string;
  isSampleData: boolean;
  providers: StatusProvider[];
  /** Providers whose last read failed. Their cached figures still appear above. */
  errors: StatusError[];
}

function isoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function statusLimit(limit: UsageLimit, nowMs: number): StatusLimit {
  const resetsAtMs = limit.resetsAtMs ?? null;
  return {
    id: limit.id,
    label: limit.detailLabel ?? limit.label,
    usedPercent: limit.percent,
    remainingPercent: limit.percent === null ? null : Math.max(0, 100 - limit.percent),
    windowMinutes: limit.windowMinutes ?? null,
    resetsAt: isoOrNull(resetsAtMs),
    hasResetSinceRead: resetsAtMs !== null && resetsAtMs <= nowMs,
    reset: limit.reset,
  };
}

function statusProvider(provider: ProviderUsage, connection: ProviderConnection, nowMs: number): StatusProvider {
  return {
    id: PUBLIC_PROVIDER_IDS[provider.id],
    name: provider.meta.name,
    plan: provider.meta.plan,
    source: provider.meta.source,
    status: connection.status,
    updatedAt: isoOrNull(provider.limitsFetchedAtMs),
    blockedReason: provider.usageBlock?.isBlocked ? provider.usageBlock.reason : null,
    // Card-only lines summarize others for the compact card and would repeat them here.
    limits: provider.limits.filter((limit) => !limit.isCardOnly).map((limit) => statusLimit(limit, nowMs)),
  };
}

/**
 * The machine-readable twin of the overview: the same providers the dashboard
 * shows, so a script never sees a provider the user switched off or one this
 * machine has no way to read.
 */
export function buildStatusReport(
  snapshot: UsageSnapshot,
  connections: Record<ProviderId, ProviderConnection>,
  now: Date,
  isSampleData: boolean,
): StatusReport {
  const nowMs = now.getTime();
  const shown = PROVIDER_IDS.filter((id) => connections[id].isAvailable && connections[id].isEnabled);
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    isSampleData,
    providers: shown.map((id) => statusProvider(snapshot.providers[id], connections[id], nowMs)),
    errors: shown
      .filter((id) => connections[id].status === "expired")
      .map((id) => ({ provider: PUBLIC_PROVIDER_IDS[id], message: connections[id].note })),
  };
}

export function formatStatusJson(report: StatusReport, isPretty: boolean): string {
  return JSON.stringify(report, null, isPretty ? 2 : undefined);
}
