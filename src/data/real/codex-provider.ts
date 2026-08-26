import { COLORS } from "../../theme";
import type { DetailRow, DetailSection, LimitAlert, ProviderMeta, ProviderUsage, UsageLimit } from "../types";
import { formatAge, formatClock, formatCountdown, seriesFromBuckets, tokensPerHour, type HourBuckets } from "./aggregate";
import type { CodexAccountLimits, CodexWindow } from "./codex-app-server";
import type { CodexLimitsSource } from "./codex-limits";
import type { OpencodeSessionStats } from "./opencode-db";
import { capLessLimit, formatTokenCount, localBurn, resetText } from "./provider-helpers";

const CODEX_NO_LIMITS = "codex limits unavailable";
/** A limit id can contribute both a short and a long window, so budget two each. */
const MAX_EXTRA_LIMIT_ROWS = 10;

export function createCodexMeta(): ProviderMeta {
  return {
    id: "cx",
    name: "codex",
    plan: "local usage only",
    planShort: "via codex cli",
    planDetail: "via codex cli",
    requirement: "codex cli installed and signed in",
    source: "codex app-server + local rollouts",
  };
}

function compactDuration(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m${remainder > 0 ? ` ${remainder}s` : ""}`;
  return `${remainder}s`;
}

/**
 * Account-wide figures live here rather than in `series` because they count
 * cached input, which the charts do not. Labelling them keeps the larger number
 * available without letting it be read as the same quantity as the bars.
 */
function accountUsageRows(limits: CodexAccountLimits, dates: string[]): DetailRow[] {
  const usage = limits.usage;
  if (!usage) return [];
  const windowTotal = dates.reduce((sum, date) => sum + (usage.dailyTokens.get(date) ?? 0), 0);
  return windowTotal > 0
    ? [{ label: "account 30d · incl. cached", value: formatTokenCount(windowTotal) }]
    : [];
}

function codexDetails(limits: CodexAccountLimits, dates: string[]): DetailSection[] | undefined {
  const sections: DetailSection[] = [];
  const summary = limits.usage?.summary;
  const accountRows = accountUsageRows(limits, dates);
  if (summary || accountRows.length > 0) {
    const rows = [
      ...accountRows,
      ...(summary && summary.lifetimeTokens > 0
        ? [{ label: "lifetime tokens", value: formatTokenCount(summary.lifetimeTokens) }]
        : []),
      ...(summary && summary.peakDailyTokens > 0
        ? [{ label: "peak day", value: formatTokenCount(summary.peakDailyTokens) }]
        : []),
      ...(summary && summary.longestRunningTurnSec > 0
        ? [{ label: "longest turn", value: compactDuration(summary.longestRunningTurnSec) }]
        : []),
      ...(summary && summary.currentStreakDays > 0
        ? [{ label: "current streak", value: `${summary.currentStreakDays}d` }]
        : []),
      ...(summary && summary.longestStreakDays > 0
        ? [{ label: "longest streak", value: `${summary.longestStreakDays}d` }]
        : []),
    ];
    if (rows.length > 0) sections.push({ title: "records", rows });
  }
  if (limits.additionalRateLimits.length > 0) {
    sections.push({
      title: "per-model limits",
      rows: limits.additionalRateLimits.slice(0, MAX_EXTRA_LIMIT_ROWS).map((limit) => ({
        label: limit.name,
        value: `${Math.round(limit.usedPercent)}%`,
        percent: limit.usedPercent,
      })),
    });
  }
  const credits = limits.credits;
  if (credits && (credits.unlimited || (credits.balance ?? 0) > 0)) {
    sections.push({
      title: "credits",
      rows: [{
        label: "balance",
        value: credits.unlimited ? "unlimited" : `$${credits.balance?.toFixed(2)}`,
      }],
    });
  }
  return sections.length > 0 ? sections : undefined;
}

/** Turns the CLI's wire enum into a plan label rather than exposing underscores. */
function withPlan(meta: ProviderMeta, planType: string): ProviderMeta {
  const known: Record<string, string> = {
    ent26: "Enterprise",
    self_serve_business_prolite: "Business Pro Lite",
    self_serve_business_usage_based: "Business",
    enterprise_cbp_automation: "Enterprise",
    enterprise_cbp_usage_based: "Enterprise",
    edu: "Education",
    edu_plus: "Education Plus",
    edu_pro: "Education Pro",
    prolite: "Pro Lite",
  };
  const plan = known[planType] ?? planType
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return { ...meta, plan, planShort: plan, planDetail: plan };
}

/** Names a window by the duration codex reports rather than by assumption. */
function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return `${fallback} · codex`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d · codex`;
  if (minutes % 60 === 0) return `${minutes / 60}h · codex`;
  return `${minutes}m · codex`;
}

function codexLimitLines(limits: CodexAccountLimits, nowMs: number): UsageLimit[] {
  const lines: UsageLimit[] = [];
  const windows: Array<[string, CodexWindow | null]> = [
    ["session", limits.session],
    ["weekly", limits.weekly],
  ];
  for (const [id, window] of windows) {
    if (!window) continue;
    const label = windowLabel(window.windowMinutes, id).replace(" · codex", " limit");
    lines.push({
      id,
      label,
      detailLabel: label,
      percent: Math.round(window.usedPercent),
      reset: resetText(window.resetsAtMs, nowMs),
      ...(window.resetsAtMs !== null
        ? { resetLong: `${resetText(window.resetsAtMs, nowMs)} · ${formatClock(window.resetsAtMs)}` }
        : {}),
    });
  }
  const spend = limits.spendControl;
  if (spend) {
    lines.push({
      id: "monthly-credit",
      label: "monthly credits",
      detailLabel: "monthly workspace credits",
      percent: Math.round(spend.usedPercent),
      reset: resetText(spend.resetsAtMs, nowMs),
      ...(spend.resetsAtMs !== null
        ? { resetLong: `${resetText(spend.resetsAtMs, nowMs)} · ${formatClock(spend.resetsAtMs)}` }
        : {}),
    });
  }
  const first = lines[0];
  if (first) first.alert = codexAlert(limits, nowMs);
  return lines;
}

/**
 * A spend control outranks a grant: it blocks the account at any percentage,
 * so the meter beside it cannot explain why codex refuses to run.
 */
function codexAlert(limits: CodexAccountLimits, nowMs: number): LimitAlert | undefined {
  if (limits.isSpendControlReached) {
    return { text: "▲ spend control reached", color: COLORS.danger, isOnCard: true };
  }
  // Only the classifications that actually mean "blocked". An unrecognized
  // value is far more likely to be a not-reached sentinel than a new block,
  // and a false red banner on a healthy account is the worse mistake.
  const reachedType = limits.rateLimitReachedType;
  if (reachedType?.includes("credits_depleted")) {
    return { text: "▲ workspace credits depleted", color: COLORS.danger, isOnCard: true };
  }
  if (reachedType?.includes("usage_limit_reached")) {
    return { text: "▲ workspace usage limit reached", color: COLORS.danger, isOnCard: true };
  }
  if (limits.resetCredits <= 0) return undefined;
  const count = limits.resetCredits;
  const grants = `✓ ${count} free reset${count > 1 ? "s" : ""}`;
  const expiresAtMs = limits.resetCreditsExpireAtMs;
  const deadline =
    expiresAtMs !== null && expiresAtMs > nowMs
      ? ` · ${count > 1 ? "next expires" : "expires"} in ${formatCountdown(expiresAtMs - nowMs)}`
      : "";
  return { text: `${grants}${deadline}`, color: COLORS.ok, isOnCard: true };
}

/** Last-active explains a flat local chart at a glance. */
function localStatsFooter(stats: OpencodeSessionStats | undefined, nowMs: number): string | undefined {
  if (!stats || stats.sessions <= 0) return undefined;
  const parts = [
    `${formatTokenCount(stats.tokens)} tokens 30d`,
    `sessions ${stats.sessions}`,
    ...(stats.topModel ? [stats.topModel] : []),
    ...(stats.latestMs > 0 ? [`last active ${formatAge(nowMs - stats.latestMs)} ago`] : []),
  ];
  return parts.join(" ▏ ");
}

interface CodexProviderInput {
  meta: ProviderMeta;
  buckets: HourBuckets;
  stats: OpencodeSessionStats | undefined;
  limitsSource: CodexLimitsSource;
  dates: string[];
  now: Date;
}

export function buildCodexProvider(input: CodexProviderInput): ProviderUsage {
  const { meta, buckets, stats, limitsSource, dates, now } = input;
  const nowMs = now.getTime();
  const limits = limitsSource.read();
  const limitsNote = limitsSource.note();
  return {
    id: "cx",
    // Codex reports the real plan; the opencode-derived label is only a stand-in.
    meta: limits?.planType ? withPlan(meta, limits.planType) : meta,
    // Local rollouts, blended, always. The server's own daily history is wider
    // but cache-inclusive, so it cannot share an axis with the other providers
    // or even with this provider's hourly view and burn rate, which are local.
    // It is reported as its own labelled figure instead - see docs/PROVIDERS.md.
    series: seriesFromBuckets(buckets, dates, now),
    limits: limits
      ? codexLimitLines(limits, nowMs)
      : [
          capLessLimit(
            "weekly",
            "weekly limit",
             "weekly usage limit",
             limitsNote ?? CODEX_NO_LIMITS,
             limitsNote ?? CODEX_NO_LIMITS,
          ),
        ],
    scopes: {
      session: limits?.session
        ? {
            percent: Math.round(limits.session.usedPercent),
            window: windowLabel(limits.session.windowMinutes, "session"),
            reset: resetText(limits.session.resetsAtMs, nowMs),
          }
        : { percent: null, window: "no session data", reset: "session limit not reported" },
      weekly: limits?.weekly
        ? {
            percent: Math.round(limits.weekly.usedPercent),
            window: windowLabel(limits.weekly.windowMinutes, "weekly"),
            reset: resetText(limits.weekly.resetsAtMs, nowMs),
          }
        : {
            percent: null,
            window: "no data",
            reset: limitsSource.note() ?? CODEX_NO_LIMITS,
          },
    },
    burn: localBurn(tokensPerHour(buckets, now)),
    ...(input.stats?.sessions !== undefined ? { sessions30d: input.stats.sessions } : {}),
    details: limits ? codexDetails(limits, dates) : undefined,
    // The chart is local now, so the local footer describes it rather than
    // contradicting an account-wide series above it.
    detailFooter: localStatsFooter(stats, nowMs),
    ...(limits && limitsNote
      ? {
          notice: {
            icon: "ⓘ",
            iconColor: COLORS.info,
            segments: [{ text: limitsNote }],
          },
        }
      : {}),
  };
}

export function codexWindowNote(limitsSource: CodexLimitsSource): string | null {
  return limitsSource.read() ? null : (limitsSource.note() ?? CODEX_NO_LIMITS);
}
