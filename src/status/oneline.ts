import type { ProviderConnection, ProviderId, ProviderUsage, UsageLimit, UsageSnapshot } from "../data/types";
import { THRESHOLDS } from "../theme";
import { PUBLIC_PROVIDER_IDS, hasResetSinceRead, reportedLimits, shownProviderIds } from "./report";

const SEPARATOR = " │ ";
const RESET_MARK = "↺";
const WEEK_MINUTES = 7 * 24 * 60;

const ANSI_RESET = "\x1b[0m";
const ANSI_RED = "\x1b[31m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_DIM = "\x1b[2m";

export interface OneLineOptions {
  /** The dashboard's danger line, so the two agree on what reads as red. */
  warnThreshold: number;
  isColored: boolean;
  isSampleData: boolean;
}

function isPrimary(limit: UsageLimit): boolean {
  return limit.id === "session" || limit.id === "weekly";
}

/** Names a window by the length the provider reports, since codex's session is not always five hours. */
function primaryLabel(limit: UsageLimit): string {
  const minutes = limit.windowMinutes ?? null;
  if (minutes === null) return limit.id === "session" ? "session" : "wk";
  if (minutes === WEEK_MINUTES) return "wk";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function extraLabel(limit: UsageLimit): string {
  if (limit.id === "monthly") return "mo";
  if (limit.id === "monthly-credit") return "credits";
  return limit.id.replace(/^surface-/, "");
}

function paint(text: string, color: string, isColored: boolean): string {
  return isColored ? `${color}${text}${ANSI_RESET}` : text;
}

function percentColor(percent: number, warnThreshold: number): string {
  if (percent >= warnThreshold) return ANSI_RED;
  if (percent >= THRESHOLDS.warn) return ANSI_YELLOW;
  return ANSI_GREEN;
}

function reading(label: string, limit: UsageLimit, nowMs: number, options: OneLineOptions): string | null {
  if (limit.percent === null) return null;
  if (hasResetSinceRead(limit, nowMs)) return `${label} ${paint(RESET_MARK, ANSI_DIM, options.isColored)}`;
  const color = percentColor(limit.percent, options.warnThreshold);
  return `${label} ${paint(`${limit.percent}%`, color, options.isColored)}`;
}

/**
 * Session and weekly always, plus whichever other lane is tighter than both:
 * a Go month at 91% must not hide behind a quiet week, and a quiet model lane
 * is not worth the width on a status bar.
 */
function chosenReadings(provider: ProviderUsage, nowMs: number, options: OneLineOptions): string[] {
  const limits = reportedLimits(provider);
  const primaries = limits.filter(isPrimary);
  const isCurrent = (limit: UsageLimit) => limit.percent !== null && !hasResetSinceRead(limit, nowMs);
  const tightestPrimary = Math.max(0, ...primaries.filter(isCurrent).map((limit) => limit.percent ?? 0));
  const tighter = limits
    .filter((limit) => !isPrimary(limit) && isCurrent(limit) && (limit.percent ?? 0) > tightestPrimary)
    .sort((left, right) => (right.percent ?? 0) - (left.percent ?? 0))[0];
  return [
    ...primaries.map((limit) => reading(primaryLabel(limit), limit, nowMs, options)),
    tighter ? reading(extraLabel(tighter), tighter, nowMs, options) : null,
  ].filter((text): text is string => text !== null);
}

function providerSegment(
  provider: ProviderUsage,
  connection: ProviderConnection,
  nowMs: number,
  options: OneLineOptions,
): string {
  // Marks a failed read, whose cached figures would otherwise pass for current.
  const name = `${PUBLIC_PROVIDER_IDS[provider.id]}${connection.status === "expired" ? "!" : ""}`;
  if (provider.usageBlock?.isBlocked) return `${name} ${paint("blocked", ANSI_RED, options.isColored)}`;
  const readings = chosenReadings(provider, nowMs, options);
  return readings.length > 0 ? `${name} ${readings.join(" ")}` : `${name} n/a`;
}

export function formatOneLine(
  snapshot: UsageSnapshot,
  connections: Record<ProviderId, ProviderConnection>,
  now: Date,
  options: OneLineOptions,
): string {
  const nowMs = now.getTime();
  const line = shownProviderIds(connections)
    .map((id) => providerSegment(snapshot.providers[id], connections[id], nowMs, options))
    .join(SEPARATOR);
  return options.isSampleData ? `(sample) ${line}` : line;
}
