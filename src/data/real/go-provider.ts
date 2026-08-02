import { COLORS } from "../../theme";
import type { DetailSection, ProviderMeta, ProviderUsage, ScopeSummary, UsageLimit } from "../types";
import { DAY_MS, formatCountdown, seriesFromBuckets, tokensPerHour, type HourBuckets } from "./aggregate";
import type { GoLimitsSource } from "./go-limits-source";
import type { OpencodeAuth } from "./opencode-auth";
import type { OpencodeSessionStats } from "./opencode-db";
import type { GoSpend, SpendWindow } from "./opencode-go-spend";
import type { GoServerLimits } from "./opencode-server";
import { capLessLimit, formatTokenCount, localBurn, resetText } from "./provider-helpers";

const GO_LIMIT_FOOTNOTE = "local estimate - cookie unlocks exact %";
const COOKIE_WARNING_MS = 7 * DAY_MS;

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

function detailSections(
  stats: OpencodeSessionStats | undefined,
  useBalance: boolean | null,
): DetailSection[] | undefined {
  const sections: DetailSection[] = [];
  if (stats?.modelTokens30d) {
    const models = Object.entries(stats.modelTokens30d)
      .filter(([, tokens]) => tokens > 0)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3);
    const total = Object.values(stats.modelTokens30d).reduce((sum, tokens) => sum + tokens, 0);
    if (models.length > 0 && total > 0) {
      sections.push({
        title: "models 30d",
        rows: models.map(([model, tokens]) => ({
          label: model,
          value: formatTokenCount(tokens),
          percent: (tokens / total) * 100,
        })),
      });
    }
  }
  if (stats?.tokenSplit30d) {
    const split = stats.tokenSplit30d;
    const values: Array<[string, number]> = [
      ["input", split.input],
      ["output", split.output],
      ["reasoning", split.reasoning],
      ["cache read", split.cacheRead],
      ["cache write", split.cacheWrite],
    ];
    const total = values.reduce((sum, [, tokens]) => sum + tokens, 0);
    const rows = values
      .filter(([, tokens]) => tokens > 0)
      .map(([label, tokens]) => ({ label, value: formatTokenCount(tokens), percent: (tokens / total) * 100 }));
    if (rows.length > 0) sections.push({ title: "tokens 30d", rows });
  }
  const spendRows = [];
  if (stats?.cost30d) {
    spendRows.push(
      { label: "total", value: `$${stats.cost30d.totalUsd.toFixed(2)}` },
      { label: "avg per day", value: `$${(stats.cost30d.totalUsd / 30).toFixed(2)}` },
      { label: "peak day", value: `$${stats.cost30d.peakDayUsd.toFixed(2)}` },
    );
  }
  if (useBalance !== null) spendRows.push({ label: "balance fallback", value: useBalance ? "on" : "off" });
  if (spendRows.length > 0) sections.push({ title: "spend 30d", rows: spendRows });
  return sections.length > 0 ? sections : undefined;
}

function goNoticeText(
  note: string | null,
  cookieExpiresAtMs: number | null,
  nowMs: number,
): string | null {
  if (note) return note;
  if (cookieExpiresAtMs === null) return null;

  const timeLeftMs = cookieExpiresAtMs - nowMs;
  if (timeLeftMs > COOKIE_WARNING_MS) return null;
  if (timeLeftMs < 0) return "opencode cookie expired - paste a fresh one";
  return `opencode cookie expires in ${formatCountdown(timeLeftMs)} - paste a fresh one`;
}

function goLimits(
  server: GoServerLimits | null,
  spend: GoSpend | null,
  note: string | null,
  nowMs: number,
): UsageLimit[] {
  if (server) return serverGoLimits(server, spend, nowMs);
  if (!spend) {
    return [
      capLessLimit(
        "usage",
        "plan usage",
        "plan usage",
        note ?? "no local usage",
        GO_LIMIT_FOOTNOTE,
      ),
    ];
  }
  return [
    spendLimit("session", "rolling 5h", "rolling 5h limit", spend.session, nowMs),
    spendLimit("weekly", "rolling 7d", "rolling 7d limit", spend.weekly, nowMs),
    spendLimit("monthly", "this cycle", "monthly limit", spend.monthly, nowMs, false),
  ];
}

function sessionScope(
  server: GoServerLimits | null,
  spend: GoSpend | null,
  note: string | null,
  nowMs: number,
): ScopeSummary {
  if (server) {
    return {
      percent: Math.round(server.rollingPercent),
      window: "5h rolling · opencode",
      reset: resetText(server.rollingResetAtMs, nowMs),
    };
  }
  if (spend) {
    return {
      percent: Math.round(spend.session.percent),
      window: "5h rolling · spend estimate",
      reset: spendResetText(spend.session, nowMs),
    };
  }
  return { percent: null, window: "no data", reset: note ?? "no local usage" };
}

function weeklyScope(
  server: GoServerLimits | null,
  spend: GoSpend | null,
  note: string | null,
  nowMs: number,
): ScopeSummary {
  if (server && server.weeklyPercent !== null) {
    return {
      percent: Math.round(server.weeklyPercent),
      window: "7d · opencode",
      reset: resetText(server.weeklyResetAtMs, nowMs),
    };
  }
  if (spend) {
    return {
      percent: Math.round(spend.weekly.percent),
      window: "7d rolling · spend estimate",
      reset: spendResetText(spend.weekly, nowMs),
    };
  }
  return { percent: null, window: "no data", reset: note ?? GO_LIMIT_FOOTNOTE };
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
  const noticeText = goNoticeText(note, limitsSource.cookieExpiresAtMs(), nowMs);
  const usesEstimate =
    !server || (spend !== null && (server.weeklyPercent === null || server.monthlyPercent === null));
  return {
    usesEstimate,
    provider: {
      id: "go",
      meta: usesEstimate ? meta : { ...meta, plan: "Go", planShort: "Go", planDetail: "Go" },
      series: seriesFromBuckets(buckets, dates, now),
      limits: goLimits(server, spend, note, nowMs),
      scopes: {
        session: sessionScope(server, spend, note, nowMs),
        weekly: weeklyScope(server, spend, note, nowMs),
      },
      burn: localBurn(tokensPerHour(buckets, now)),
      details: detailSections(stats, server?.useBalance ?? null),
      ...(noticeText
        ? {
            notice: {
              icon: "▲",
              iconColor: COLORS.warn,
              segments: [{ text: noticeText }],
            },
          }
        : {}),
      detailFooter: sessionsFooter(stats),
    },
  };
}
