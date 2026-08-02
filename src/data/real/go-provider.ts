import type { ProviderMeta, ProviderUsage, UsageLimit } from "../types";
import { formatCountdown, seriesFromBuckets, tokensPerHour, type HourBuckets } from "./aggregate";
import type { GoLimitsSource } from "./go-limits-source";
import type { OpencodeAuth } from "./opencode-auth";
import type { OpencodeSessionStats } from "./opencode-db";
import type { GoSpend, SpendWindow } from "./opencode-go-spend";
import type { GoServerLimits } from "./opencode-server";
import { capLessLimit, formatTokenCount, localBurn, resetText } from "./provider-helpers";

const GO_LIMIT_FOOTNOTE = "local estimate - cookie unlocks exact %";

export function createGoMeta(auth: OpencodeAuth): ProviderMeta {
  return {
    id: "go",
    name: "opencode go",
    plan: "local usage only",
    planShort: "Go · estimate",
    planDetail: "Go · spend estimate",
    requirement: "opencode go api key",
    source: "~/.local/share/opencode/opencode.db",
    fake: auth.opencodeGo?.maskedKey ?? "api key",
  };
}

function formatUsd(usd: number): string {
  return usd >= 10 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

/** Rolling windows free up gradually; a billing cycle resets outright. */
function spendResetText(window: SpendWindow, nowMs: number, isRolling = true): string {
  if (window.resetAtMs === null) return "no spend in window";
  const verb = isRolling && window.usd > 0 ? "frees up in" : "resets in";
  return `${verb} ${formatCountdown(window.resetAtMs - nowMs)}`;
}

function spendLimit(
  id: string,
  label: string,
  detailLabel: string,
  window: SpendWindow,
  nowMs: number,
  isRolling = true,
): UsageLimit {
  return {
    id,
    label,
    detailLabel,
    percent: Math.round(window.percent),
    reset: spendResetText(window, nowMs, isRolling),
    detailValueLabel: `${formatUsd(window.usd)} of ${formatUsd(window.capUsd)}`,
    footnote: GO_LIMIT_FOOTNOTE,
  };
}

/** Server percentages replace the estimate for each published window. */
function serverGoLimits(server: GoServerLimits, spend: GoSpend | null, nowMs: number): UsageLimit[] {
  const limits: UsageLimit[] = [
    {
      id: "session",
      label: "rolling 5h",
      detailLabel: "rolling 5h limit",
      percent: Math.round(server.rollingPercent),
      reset: resetText(server.rollingResetAtMs, nowMs),
    },
  ];
  if (server.weeklyPercent !== null) {
    limits.push({
      id: "weekly",
      label: "rolling 7d",
      detailLabel: "rolling 7d limit",
      percent: Math.round(server.weeklyPercent),
      reset: resetText(server.weeklyResetAtMs, nowMs),
    });
  } else if (spend) {
    limits.push(spendLimit("weekly", "rolling 7d", "rolling 7d limit", spend.weekly, nowMs));
  }
  if (server.monthlyPercent !== null) {
    limits.push({
      id: "monthly",
      label: "this cycle",
      detailLabel: "monthly limit",
      percent: Math.round(server.monthlyPercent),
      reset: resetText(server.monthlyResetAtMs, nowMs),
    });
  } else if (spend) {
    limits.push(spendLimit("monthly", "this cycle", "monthly limit", spend.monthly, nowMs, false));
  }
  return limits;
}

function sessionsFooter(stats: OpencodeSessionStats | undefined): string | undefined {
  if (!stats || stats.sessions <= 0) return undefined;
  return `sessions 30d ${stats.sessions} ▏ avg per session ${formatTokenCount(stats.tokens / stats.sessions)} ▏ tokens from opencode.db`;
}

interface GoProviderInput {
  meta: ProviderMeta;
  buckets: HourBuckets;
  stats: OpencodeSessionStats | undefined;
  spend: GoSpend | null;
  limitsSource: GoLimitsSource;
  dates: string[];
  now: Date;
}

interface GoProviderResult {
  provider: ProviderUsage;
  usesEstimate: boolean;
}

export function buildGoProvider(input: GoProviderInput): GoProviderResult {
  const { meta, buckets, stats, spend, limitsSource, dates, now } = input;
  const nowMs = now.getTime();
  const server = limitsSource.read();
  const note = limitsSource.note();
  const usesEstimate =
    !server || (spend !== null && (server.weeklyPercent === null || server.monthlyPercent === null));
  return {
    usesEstimate,
    provider: {
      id: "go",
      meta: usesEstimate ? meta : { ...meta, plan: "Go", planShort: "Go", planDetail: "Go" },
      series: seriesFromBuckets(buckets, dates, now),
      limits: server
        ? serverGoLimits(server, spend, nowMs)
        : spend
          ? [
              spendLimit("session", "rolling 5h", "rolling 5h limit", spend.session, nowMs),
              spendLimit("weekly", "rolling 7d", "rolling 7d limit", spend.weekly, nowMs),
              spendLimit("monthly", "this cycle", "monthly limit", spend.monthly, nowMs, false),
            ]
          : [capLessLimit("usage", "plan usage", "plan usage", note ?? "no local usage", GO_LIMIT_FOOTNOTE)],
      scopes: {
        session: server
          ? {
              percent: Math.round(server.rollingPercent),
              window: "5h rolling · opencode",
              reset: resetText(server.rollingResetAtMs, nowMs),
            }
          : spend
            ? {
                percent: Math.round(spend.session.percent),
                window: "5h rolling · spend estimate",
                reset: spendResetText(spend.session, nowMs),
              }
            : { percent: null, window: "no data", reset: note ?? "no local usage" },
        weekly:
          server && server.weeklyPercent !== null
            ? {
                percent: Math.round(server.weeklyPercent),
                window: "7d · opencode",
                reset: resetText(server.weeklyResetAtMs, nowMs),
              }
            : spend
              ? {
                  percent: Math.round(spend.weekly.percent),
                  window: "7d rolling · spend estimate",
                  reset: spendResetText(spend.weekly, nowMs),
                }
              : { percent: null, window: "no data", reset: note ?? GO_LIMIT_FOOTNOTE },
      },
      burn: localBurn(tokensPerHour(buckets, now)),
      detailFooter: sessionsFooter(stats),
    },
  };
}
