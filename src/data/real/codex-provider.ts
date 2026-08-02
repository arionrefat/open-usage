import { COLORS } from "../../theme";
import type { ProviderMeta, ProviderUsage, UsageLimit } from "../types";
import { formatAge, formatClock, seriesFromBuckets, toMillions, tokensPerHour, type HourBuckets } from "./aggregate";
import type { CodexAccountLimits, CodexUsageSummary, CodexWindow } from "./codex-app-server";
import type { CodexLimitsSource } from "./codex-limits";
import type { OpencodeSessionStats } from "./opencode-db";
import { capLessLimit, formatTokenCount, localBurn, resetText } from "./provider-helpers";

const CODEX_NO_LIMITS = "codex limits unavailable";

export function createCodexMeta(): ProviderMeta {
  return {
    id: "cx",
    name: "codex",
    plan: "local usage only",
    planShort: "via opencode",
    planDetail: "via opencode",
    requirement: "openai oauth via opencode",
    source: "~/.local/share/opencode/opencode.db",
    fake: "oauth · openai",
  };
}

function codexSummaryFooter(summary: CodexUsageSummary): string | undefined {
  if (summary.lifetimeTokens <= 0) return undefined;
  const parts = [
    `lifetime ${formatTokenCount(summary.lifetimeTokens)}`,
    `peak day ${formatTokenCount(summary.peakDailyTokens)}`,
    ...(summary.longestStreakDays > 0 ? [`longest streak ${summary.longestStreakDays}d`] : []),
    "from codex",
  ];
  return parts.join(" ▏ ");
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
  // Codex's own server history covers every route into the account, while
  // opencode.db only sees what opencode itself sent, so it wins when present.
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
        : { percent: null, window: "no session cap", reset: "counted in the weekly pool" },
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
    detailFooter: usage?.summary ? codexSummaryFooter(usage.summary) : localStatsFooter(stats, nowMs),
  };
}

export function codexWindowNote(limitsSource: CodexLimitsSource): string | null {
  return limitsSource.read() ? null : (limitsSource.note() ?? CODEX_NO_LIMITS);
}
