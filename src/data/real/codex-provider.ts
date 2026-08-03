import { COLORS } from "../../theme";
import type { DetailSection, ProviderMeta, ProviderUsage, UsageLimit } from "../types";
import { formatAge, formatClock, seriesFromBuckets, toMillions, tokensPerHour, type HourBuckets } from "./aggregate";
import type { CodexAccountLimits, CodexWindow } from "./codex-app-server";
import type { CodexLimitsSource } from "./codex-limits";
import type { OpencodeSessionStats } from "./opencode-db";
import { capLessLimit, formatTokenCount, localBurn, resetText } from "./provider-helpers";

const CODEX_NO_LIMITS = "codex limits unavailable";

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

function codexDetails(limits: CodexAccountLimits): DetailSection[] | undefined {
  const sections: DetailSection[] = [];
  const summary = limits.usage?.summary;
  if (summary) {
    const rows = [
      ...(summary.lifetimeTokens > 0
        ? [{ label: "lifetime tokens", value: formatTokenCount(summary.lifetimeTokens) }]
        : []),
      ...(summary.peakDailyTokens > 0
        ? [{ label: "peak day", value: formatTokenCount(summary.peakDailyTokens) }]
        : []),
      ...(summary.longestRunningTurnSec > 0
        ? [{ label: "longest turn", value: compactDuration(summary.longestRunningTurnSec) }]
        : []),
      ...(summary.currentStreakDays > 0
        ? [{ label: "current streak", value: `${summary.currentStreakDays}d` }]
        : []),
      ...(summary.longestStreakDays > 0
        ? [{ label: "longest streak", value: `${summary.longestStreakDays}d` }]
        : []),
    ];
    if (rows.length > 0) sections.push({ title: "records", rows });
  }
  if (limits.additionalRateLimits.length > 0) {
    sections.push({
      title: "per-model limits",
      rows: limits.additionalRateLimits.slice(0, 5).map((limit) => ({
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

/** "plus" reads as a plan name, not a sentence, so only the case changes. */
function withPlan(meta: ProviderMeta, planType: string): ProviderMeta {
  const plan = planType.charAt(0).toUpperCase() + planType.slice(1);
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
  // A free reset grant is worth surfacing: it is the way out of a capped week.
  if (lines.length > 0 && limits.resetCredits > 0) {
    const first = lines[0];
    if (first) {
      first.alert = {
        text: `✓ ${limits.resetCredits} free limit reset available`,
        color: COLORS.ok,
      };
    }
  }
  return lines;
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
  // Server-side daily history is account-wide; local buckets only cover this device.
  const usage = limits?.usage ?? null;
  return {
    id: "cx",
    // Codex reports the real plan; the opencode-derived label is only a stand-in.
    meta: limits?.planType ? withPlan(meta, limits.planType) : meta,
    series: usage
      ? {
          daily: dates.map((date) => toMillions(usage.dailyTokens.get(date) ?? 0)),
          hourly: seriesFromBuckets(buckets, dates, now).hourly,
        }
      : seriesFromBuckets(buckets, dates, now),
    limits: limits
      ? codexLimitLines(limits, nowMs)
      : [
          capLessLimit(
            "weekly",
            "weekly limit",
            "weekly usage limit",
            limitsSource.note() ?? CODEX_NO_LIMITS,
            limitsSource.note() ?? CODEX_NO_LIMITS,
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
    activityScope: limits?.usage ? "account" : "local",
    ...(input.stats?.sessions !== undefined ? { sessions30d: input.stats.sessions } : {}),
    details: limits ? codexDetails(limits) : undefined,
    detailFooter: usage ? undefined : localStatsFooter(stats, nowMs),
  };
}

export function codexWindowNote(limitsSource: CodexLimitsSource): string | null {
  return limitsSource.read() ? null : (limitsSource.note() ?? CODEX_NO_LIMITS);
}
