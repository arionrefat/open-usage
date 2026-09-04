import { COLORS } from "../../theme";
import type {
  DetailSection,
  ProviderMeta,
  ProviderUsage,
  ScopeSummary,
  SpendSummary,
  UsageLimit,
} from "../types";
import { DAY_MS, formatCountdown, seriesFromBuckets, toMillions, tokensPerHour, type HourBuckets } from "./aggregate";
import type { GoActivity } from "./go-activity";
import type { GoLimitsSource } from "./go-limits-source";
import type { OpencodeSessionStats } from "./opencode-db";
import type { GoSpend, SpendWindow } from "./opencode-go-spend";
import type { GoServerLimits } from "./opencode-server";
import type { GoBilling } from "./opencode-usage";
import { capLessLimit, formatTokenCount, localBurn, resetText } from "./provider-helpers";

const GO_LIMIT_FOOTNOTE = "model-weighted local estimate - API key or cookie unlocks exact %";
const COOKIE_WARNING_MS = 7 * DAY_MS;

export function createGoMeta(): ProviderMeta {
  return {
    id: "go",
    name: "opencode go",
    plan: "local usage only",
    planShort: "Go · estimate",
    planDetail: "Go · spend estimate",
    requirement: "opencode go configured in opencode",
    source: "~/.local/share/opencode/opencode.db",
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
      ...(server.rollingUsd !== null && server.rollingUsd !== undefined &&
        server.rollingCapUsd !== null && server.rollingCapUsd !== undefined
        ? { detailValueLabel: `${formatUsd(server.rollingUsd)} of ${formatUsd(server.rollingCapUsd)}` }
        : {}),
    },
  ];
  if (server.weeklyPercent !== null) {
    limits.push({
      id: "weekly",
      label: "rolling 7d",
      detailLabel: "rolling 7d limit",
      percent: Math.round(server.weeklyPercent),
      reset: resetText(server.weeklyResetAtMs, nowMs),
      ...(server.weeklyUsd !== null && server.weeklyUsd !== undefined &&
        server.weeklyCapUsd !== null && server.weeklyCapUsd !== undefined
        ? { detailValueLabel: `${formatUsd(server.weeklyUsd)} of ${formatUsd(server.weeklyCapUsd)}` }
        : {}),
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
      ...(server.monthlyUsd !== null && server.monthlyUsd !== undefined &&
        server.monthlyCapUsd !== null && server.monthlyCapUsd !== undefined
        ? { detailValueLabel: `${formatUsd(server.monthlyUsd)} of ${formatUsd(server.monthlyCapUsd)}` }
        : {}),
    });
  } else if (spend) {
    limits.push(spendLimit("monthly", "trailing 30d", "trailing 30d limit", spend.monthly, nowMs));
  }
  return limits;
}

/** Exact limits carry no activity series, so an empty local chart is expected. */
function sessionsFooter(
  stats: OpencodeSessionStats | undefined,
  server: GoServerLimits | null,
): string | undefined {
  if (!stats || stats.sessions <= 0) {
    if (!server) return undefined;
    return `no local history ▏ limits from ${server.source === "api" ? "API" : "dashboard"}`;
  }
  return `sessions 30d ${stats.sessions} ▏ avg per session ${formatTokenCount(stats.tokens / stats.sessions)} ▏ tokens from opencode.db`;
}

/**
 * Money actually charged, kept in its own section so it can never be read as
 * part of the allowance figures above it.
 */
function billedSection(billing: GoBilling | null): DetailSection | null {
  if (!billing) return null;
  const money = (usd: number) => `$${usd.toFixed(2)}`;
  return {
    title: "billed",
    rows: [
      { label: "balance", value: money(billing.balanceUsd) },
      ...(billing.monthlyUsageUsd !== null
        ? [{ label: "metered this month", value: money(billing.monthlyUsageUsd) }]
        : []),
      ...(billing.monthlyLimitUsd !== null
        ? [{ label: "monthly limit", value: money(billing.monthlyLimitUsd) }]
        : []),
      {
        label: "auto-reload",
        value: billing.isAutoReloadOn ? `on · ${money(billing.reloadAmountUsd ?? 0)}` : "off",
      },
    ],
  };
}

function detailSections(
  stats: OpencodeSessionStats | undefined,
  useBalance: boolean | null,
  billing: GoBilling | null,
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
  // These dollars measure allowance drawn against a plan already paid for, so
  // they are never labelled spend. Money charged lives in the billed section.
  const usageRows = [];
  if (stats?.cost30d) {
    usageRows.push(
      { label: "total", value: `$${stats.cost30d.totalUsd.toFixed(2)}` },
      { label: "avg per day", value: `$${(stats.cost30d.totalUsd / 30).toFixed(2)}` },
      { label: "peak day", value: `$${stats.cost30d.peakDayUsd.toFixed(2)}` },
    );
  }
  if (useBalance !== null) usageRows.push({ label: "balance fallback", value: useBalance ? "on" : "off" });
  if (usageRows.length > 0) sections.push({ title: "usage value 30d", rows: usageRows });

  const billed = billedSection(billing);
  if (billed) sections.push(billed);
  return sections.length > 0 ? sections : undefined;
}

/**
 * The billing record is the only place a lapsed plan is stated outright, and it
 * carries the balance that decides whether opencode will still serve a request.
 * Without a plan and without credit, opencode answers with a 401 rather than
 * usage, which is worth saying plainly instead of leaving the card blank.
 */
function unsubscribedNotice(billing: GoBilling | null): string | null {
  if (!billing || billing.hasSubscription || billing.hasLiteSubscription) return null;
  return billing.balanceUsd > 0
    ? `no opencode go subscription - paying from $${billing.balanceUsd.toFixed(2)} balance`
    : "no opencode go subscription and no balance - opencode will refuse requests";
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

function displayedSourceNote(
  note: string | null,
  server: GoServerLimits | null,
  spend: GoSpend | null,
): string | null {
  if (!note) return null;
  const base = note.replace(/ - showing (?:local estimate|previous values|cached server limits)$/, "");
  if (server) return `${base} - showing cached server limits`;
  if (spend) return `${base} - showing local estimate`;
  return base;
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
    spendLimit("monthly", "trailing 30d", "trailing 30d limit", spend.monthly, nowMs),
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
  /** Server-side month history; absent without a cookie or on a failed read. */
  history?: SpendSummary | null;
  /** Workspace-wide activity from the dashboard; outranks the local buckets. */
  activity?: GoActivity | null;
  billing?: GoBilling | null;
}

interface GoProviderResult {
  provider: ProviderUsage;
  usesEstimate: boolean;
}

/** The stated source follows whichever authoritative quota path produced the reading. */
function goMetaFor(meta: ProviderMeta, server: GoServerLimits | null, usesEstimate: boolean): ProviderMeta {
  if (!server) return meta;
  const fromServer = {
    ...meta,
    source: server.source === "api" ? "opencode go usage API" : "opencode.ai dashboard",
  };
  return usesEstimate
    ? fromServer
    : { ...fromServer, plan: "Go", planShort: "Go", planDetail: "Go" };
}

export function buildGoProvider(input: GoProviderInput): GoProviderResult {
  const { meta, spend, limitsSource, dates, now, history, billing } = input;
  const nowMs = now.getTime();
  // The dashboard sees every device on the workspace, opencode.db only this one,
  // and both report each token kind, so the wider source wins outright rather
  // than being merged - summing the two would count shared sessions twice.
  const workspace = input.activity ?? null;
  const buckets = workspace?.buckets ?? input.buckets;
  const stats = workspace?.stats ?? input.stats;
  const server = limitsSource.read(now);
  const note = displayedSourceNote(limitsSource.note(now), server, spend);
  // Only when there are no server limits to show: a workspace still reporting
  // its windows has a plan, whatever a cached billing record says.
  const planNotice = server ? null : unsubscribedNotice(billing ?? null);
  const noticeText = planNotice ?? goNoticeText(note, limitsSource.cookieExpiresAtMs(), nowMs);
  const usesEstimate =
    !server || (spend !== null && (server.weeklyPercent === null || server.monthlyPercent === null));
  return {
    usesEstimate,
    provider: {
      id: "go",
      meta: goMetaFor(meta, server, usesEstimate),
      series: seriesFromBuckets(buckets, dates, now),
      ...(workspace ? { seriesScope: "workspace" as const } : {}),
      // The server keeps its own month history, so a cookie alone is enough.
      hasHistory: stats !== undefined || history != null,
      limits: goLimits(server, spend, note, nowMs),
      scopes: {
        session: sessionScope(server, spend, note, nowMs),
        weekly: weeklyScope(server, spend, note, nowMs),
      },
      burn: localBurn(tokensPerHour(buckets, now)),
      ...(stats?.sessions !== undefined ? { sessions30d: stats.sessions } : {}),
      ...(stats?.tokenSplit30d ? { cacheRead30d: toMillions(stats.tokenSplit30d.cacheRead) } : {}),
      ...(history ? { spend: history } : {}),
      details: detailSections(stats, server?.useBalance ?? null, billing ?? null),
      ...(noticeText
        ? {
            notice: {
              icon: "▲",
              iconColor: COLORS.warn,
              segments: [{ text: noticeText }],
            },
          }
        : {}),
      detailFooter: sessionsFooter(stats, server),
    },
  };
}
