import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatTokens } from "../lib/chart";
import type { ProviderMode } from "../lib/args";
import { COLORS } from "../theme";
import { maskCredential } from "./mask";
import { mockUsageProvider } from "./mock-provider";
import {
  DAY_MS,
  HOUR_MS,
  dailyDateKeys,
  formatAge,
  formatClock,
  formatCountdown,
  formatRate,
  seriesFromBuckets,
  toMillions,
  tokensPerHour,
  type HourBuckets,
} from "./real/aggregate";
import { readHistoryStats } from "./real/claude-history";
import { readClaudeTranscripts } from "./real/claude-transcripts";
import { createCodexLimitsSource, type CodexLimitsSource } from "./real/codex-limits";
import type {
  CodexAccountLimits,
  CodexUsageSummary,
  CodexWindow,
} from "./real/codex-app-server";
import { readOpencodeAuth, type OpencodeAuth } from "./real/opencode-auth";
import { readOpencodeUsage, type OpencodeSessionStats } from "./real/opencode-db";
import { readGoSpend, type GoSpend, type SpendWindow } from "./real/opencode-go-spend";
import { createGoLimitsSource, type GoLimitsSource } from "./real/go-limits-source";
import type { GoServerLimits } from "./real/opencode-server";
import {
  SNAPSHOT_FRESH_MS,
  createWeeklyTrend,
  readUsageSnapshot,
  type RateWindowReading,
  type SnapshotFile,
  type WeeklyTrend,
} from "./real/statusline-snapshot";
import type {
  BurnRate,
  ProviderConnection,
  ProviderId,
  ProviderMeta,
  ProviderUsage,
  UsageLimit,
  UsageProvider,
  UsageSnapshot,
} from "./types";

export interface RealProviderPaths {
  opencodeDb: string;
  opencodeAuth: string;
  opencodeCookie: string;
  claudeProjects: string;
  claudeHistory: string;
  usageSnapshot: string;
}

export function defaultRealProviderPaths(): RealProviderPaths {
  const home = homedir();
  return {
    opencodeDb: join(home, ".local", "share", "opencode", "opencode.db"),
    opencodeAuth: join(home, ".local", "share", "opencode", "auth.json"),
    opencodeCookie: join(home, ".config", "limitless", "opencode-cookie"),
    claudeProjects: join(home, ".claude", "projects"),
    claudeHistory: join(home, ".claude", "history.jsonl"),
    usageSnapshot: join(home, ".claude", "usage-snapshot.json"),
  };
}

export function hasRealSources(paths: RealProviderPaths): boolean {
  return existsSync(paths.opencodeDb) || existsSync(paths.claudeProjects);
}

const OPENCODE_PROVIDER_IDS: Partial<Record<ProviderId, string>> = {
  cx: "openai",
  go: "opencode-go",
};

const GO_LIMIT_FOOTNOTE = "estimated from local spend - opencode publishes no usage api";
/** Limits come from the codex cli now, so the source explains its own absence. */
const CODEX_NO_LIMITS = "codex limits unavailable";

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
const NO_CAP_DATA = "no cap data";
const STATS_WINDOW_DAYS = 30;

function buildMeta(auth: OpencodeAuth): Record<ProviderId, ProviderMeta> {
  return {
    cl: {
      id: "cl",
      name: "claude code",
      plan: "local data",
      planShort: "local data",
      planDetail: "local data",
      requirement: "claude code installed (oauth)",
      source: "~/.claude",
      fake: "oauth · claude code",
    },
    cx: {
      id: "cx",
      name: "codex",
      plan: "local usage only",
      planShort: "via opencode",
      planDetail: "via opencode",
      requirement: "openai oauth via opencode",
      source: "~/.local/share/opencode/opencode.db",
      fake: "oauth · openai",
    },
    go: {
      id: "go",
      name: "opencode go",
      plan: "local usage only",
      planShort: "Go · estimate",
      planDetail: "Go · spend estimate",
      requirement: "opencode go api key",
      source: "~/.local/share/opencode/opencode.db",
      fake: auth.opencodeGo?.maskedKey ?? "api key",
    },
  };
}

function claudeConnectionNote(snapshotFile: SnapshotFile | null): string {
  if (!snapshotFile) return "no statusline snapshot yet";
  const age = formatAge(snapshotFile.ageMs);
  return snapshotFile.ageMs < SNAPSHOT_FRESH_MS
    ? `statusline snapshot ${age === "just now" ? "just written" : `${age} old`}`
    : `snapshot ${age} old - open a claude code session`;
}

function buildConnections(
  paths: RealProviderPaths,
  auth: OpencodeAuth,
  snapshotFile: SnapshotFile | null,
  nowMs: number,
): Record<ProviderId, ProviderConnection> {
  const hasClaude = existsSync(paths.claudeProjects) || existsSync(paths.claudeHistory);
  const openaiNote = auth.openai
    ? auth.openai.expiresMs !== null && auth.openai.expiresMs < nowMs
      ? "access token expired - refreshes on next opencode run"
      : auth.openai.expiresMs !== null
        ? `access token expires in ${formatCountdown(auth.openai.expiresMs - nowMs)}`
        : "oauth token on file"
    : "no openai oauth in opencode auth.json";

  return {
    cl: hasClaude
      ? {
          isEnabled: true,
          status: "active",
          credential: "oauth · claude code",
          note: claudeConnectionNote(snapshotFile),
        }
      : { isEnabled: true, status: "none", credential: "", note: "claude code not found" },
    cx: auth.openai
      ? { isEnabled: true, status: "active", credential: "oauth · openai", note: openaiNote }
      : { isEnabled: true, status: "none", credential: "", note: openaiNote },
    go: auth.opencodeGo
      ? {
          isEnabled: true,
          status: "active",
          credential: auth.opencodeGo.maskedKey,
          note: "api key on file",
        }
      : { isEnabled: true, status: "none", credential: "", note: "no opencode go key stored" },
  };
}

function capLessLimit(id: string, label: string, detailLabel: string, note: string, footnote: string): UsageLimit {
  return {
    id,
    label,
    detailLabel,
    percent: null,
    valueLabel: "n/a",
    valueColor: COLORS.textGhost,
    reset: note,
    footnote,
  };
}

function resetText(resetsAtMs: number | null, nowMs: number): string {
  return resetsAtMs !== null ? `resets in ${formatCountdown(resetsAtMs - nowMs)}` : "reset unknown";
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

/**
 * Server percentages replace the estimate for the windows opencode publishes;
 * the monthly line has no server equivalent so the local estimate carries it.
 */
function serverGoLimits(
  server: GoServerLimits,
  spend: GoSpend | null,
  nowMs: number,
): UsageLimit[] {
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
  }
  if (spend) {
    limits.push(spendLimit("monthly", "this cycle", "monthly limit", spend.monthly, nowMs, false));
  }
  return limits;
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

interface ClaudeProjection {
  projectedPercent: number;
  capsOutAt: string;
}

function projectWeekly(
  seven: RateWindowReading | null,
  trendRate: number | null,
  nowMs: number,
): ClaudeProjection {
  if (!seven) return { projectedPercent: 0, capsOutAt: NO_CAP_DATA };
  const current = Math.round(seven.percent);
  if (trendRate === null || seven.resetsAtMs === null) {
    // No usable snapshot delta yet - the projection is just the current figure.
    return {
      projectedPercent: current,
      capsOutAt: current > 100 ? "already capped" : "not before reset",
    };
  }
  const hoursToReset = Math.max(0, (seven.resetsAtMs - nowMs) / HOUR_MS);
  const projectedPercent = Math.round(seven.percent + trendRate * hoursToReset);
  if (projectedPercent <= 100) return { projectedPercent, capsOutAt: "not before reset" };
  const hoursToCap = (100 - seven.percent) / trendRate;
  return { projectedPercent, capsOutAt: formatClock(nowMs + hoursToCap * HOUR_MS) };
}

function claudeLimits(
  snapshotFile: SnapshotFile | null,
  projection: ClaudeProjection,
  rateLabel: string,
  nowMs: number,
): UsageLimit[] {
  const staleNote =
    snapshotFile === null
      ? "statusline snapshot missing - open a claude code session to refresh"
      : `statusline snapshot stale (${formatAge(snapshotFile.ageMs)} old) - open a claude code session to refresh`;
  const isFresh = snapshotFile !== null && snapshotFile.ageMs < SNAPSHOT_FRESH_MS;
  const five = snapshotFile?.reading.fiveHour ?? null;
  const seven = snapshotFile?.reading.sevenDay ?? null;

  const session: UsageLimit = five
    ? {
        id: "session",
        label: "current session",
        percent: Math.round(five.percent),
        reset: resetText(five.resetsAtMs, nowMs),
        ...(isFresh ? {} : { footnote: staleNote }),
      }
    : capLessLimit("session", "current session", "current session", "no snapshot", staleNote);

  const weekly: UsageLimit = seven
    ? {
        id: "weekly",
        label: "weekly · all models",
        percent: Math.round(seven.percent),
        reset: resetText(seven.resetsAtMs, nowMs),
        resetLong:
          seven.resetsAtMs !== null
            ? `${resetText(seven.resetsAtMs, nowMs)} · ${formatClock(seven.resetsAtMs)}`
            : undefined,
        ...(projection.projectedPercent > 100
          ? {
              alert: {
                text: `▲ burn ${rateLabel} → projected ${projection.projectedPercent}% before reset`,
                color: COLORS.danger,
              },
            }
          : {}),
      }
    : capLessLimit("weekly", "weekly · all models", "weekly · all models", "no snapshot", staleNote);

  return [session, weekly];
}

/** Like formatTokens but keeps sub-million counts readable ("442K", "1.9M"). */
function formatTokenCount(tokens: number): string {
  if (tokens >= 10_000_000) return formatTokens(tokens / 1_000_000);
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${Math.round(tokens)}`;
}

function sessionsFooter(stats: OpencodeSessionStats | undefined, suffix: string): string | undefined {
  if (!stats || stats.sessions <= 0) return undefined;
  return `sessions 30d ${stats.sessions} ▏ avg per session ${formatTokenCount(stats.tokens / stats.sessions)} ▏ ${suffix}`;
}

/**
 * Opencode records no limit data, so the codex line carries everything it does
 * hold. Last-active matters most: it explains a flat chart at a glance.
 */
function localStatsFooter(
  stats: OpencodeSessionStats | undefined,
  nowMs: number,
): string | undefined {
  if (!stats || stats.sessions <= 0) return undefined;
  const parts = [
    `${formatTokenCount(stats.tokens)} tokens 30d`,
    `sessions ${stats.sessions}`,
    ...(stats.topModel ? [stats.topModel] : []),
    ...(stats.latestMs > 0 ? [`last active ${formatAge(nowMs - stats.latestMs)} ago`] : []),
  ];
  return parts.join(" ▏ ");
}

function localBurn(rate: number): BurnRate {
  return {
    limit: "local burn only",
    timeToReset: NO_CAP_DATA,
    rate: formatRate(rate),
    projectedPercent: 0,
    capsOutAt: NO_CAP_DATA,
  };
}

interface RealProviderOptions {
  paths?: RealProviderPaths;
  codexLimits?: CodexLimitsSource;
  goLimits?: GoLimitsSource;
}

function buildSnapshot(
  paths: RealProviderPaths,
  meta: Record<ProviderId, ProviderMeta>,
  codexLimits: CodexLimitsSource,
  goLimits: GoLimitsSource,
  trend: WeeklyTrend,
): UsageSnapshot {
  const now = new Date();
  const nowMs = now.getTime();
  const dates = dailyDateKeys(now);

  const opencode = readOpencodeUsage(paths.opencodeDb, now);
  const transcripts = readClaudeTranscripts(paths.claudeProjects);
  const history = readHistoryStats(paths.claudeHistory, nowMs - STATS_WINDOW_DAYS * DAY_MS);
  const snapshotFile = readUsageSnapshot(paths.usageSnapshot, now);

  // claude
  const clRate = tokensPerHour(transcripts.buckets, now);
  const seven = snapshotFile?.reading.sevenDay ?? null;
  const isFresh = snapshotFile !== null && snapshotFile.ageMs < SNAPSHOT_FRESH_MS;
  const trendRate =
    isFresh && seven !== null ? trend.observe(snapshotFile.writtenAtMs, seven.percent) : null;
  const projection = projectWeekly(seven, trendRate, nowMs);
  const rateLabel = formatRate(clRate);
  const five = snapshotFile?.reading.fiveHour ?? null;

  const cl: ProviderUsage = {
    id: "cl",
    meta: meta.cl,
    series: seriesFromBuckets(transcripts.buckets, dates, now),
    limits: claudeLimits(snapshotFile, projection, rateLabel, nowMs),
    scopes: {
      session: {
        percent: five ? Math.round(five.percent) : null,
        window: "5h rolling",
        reset: five ? resetText(five.resetsAtMs, nowMs) : "no snapshot",
      },
      weekly: {
        percent: seven ? Math.round(seven.percent) : null,
        window: "7d · all models",
        reset: seven ? resetText(seven.resetsAtMs, nowMs) : "no snapshot",
      },
    },
    burn: seven
      ? {
          limit: "weekly · all models",
          timeToReset:
            seven.resetsAtMs !== null
              ? `${formatCountdown(seven.resetsAtMs - nowMs)} to reset`
              : "reset unknown",
          rate: rateLabel,
          projectedPercent: projection.projectedPercent,
          capsOutAt: projection.capsOutAt,
        }
      : localBurn(clRate),
    ...(isFresh
      ? {}
      : {
          notice: {
            icon: "ⓘ",
            iconColor: COLORS.info,
            segments: [
              {
                text:
                  snapshotFile === null
                    ? "statusline snapshot missing - open a claude code session to refresh limits"
                    : "statusline snapshot stale - open a claude code session to refresh limits",
              },
            ],
          },
        }),
    detailFooter:
      history.prompts > 0
        ? `prompts 30d ${history.prompts} ▏ sessions ${history.sessions} ▏ tokens from local transcripts (pruned periodically)`
        : undefined,
  };

  // codex
  const cxBuckets: HourBuckets = opencode?.buckets.get(OPENCODE_PROVIDER_IDS.cx ?? "") ?? new Map();
  const cxStats = opencode?.stats.get(OPENCODE_PROVIDER_IDS.cx ?? "");
  const codex = codexLimits.read();
  // Codex's own server history covers every route into the account, while
  // opencode.db only sees what opencode itself sent, so it wins when present.
  const codexUsage = codex?.usage ?? null;
  const cx: ProviderUsage = {
    id: "cx",
    // Codex reports the real plan; the opencode-derived label is only a stand-in.
    meta: codex?.planType ? withPlan(meta.cx, codex.planType) : meta.cx,
    series: codexUsage
      ? {
          daily: dates.map((date) => toMillions(codexUsage.dailyTokens.get(date) ?? 0)),
          hourly: seriesFromBuckets(cxBuckets, dates, now).hourly,
        }
      : seriesFromBuckets(cxBuckets, dates, now),
    limits: codex
      ? codexLimitLines(codex, nowMs)
      : [
          capLessLimit(
            "weekly",
            "weekly limit",
            "weekly usage limit",
            codexLimits.note() ?? CODEX_NO_LIMITS,
            codexLimits.note() ?? CODEX_NO_LIMITS,
          ),
        ],
    scopes: {
      session: codex?.session
        ? {
            percent: Math.round(codex.session.usedPercent),
            window: windowLabel(codex.session.windowMinutes, "session"),
            reset: resetText(codex.session.resetsAtMs, nowMs),
          }
        : { percent: null, window: "no session cap", reset: "counted in the weekly pool" },
      weekly: codex?.weekly
        ? {
            percent: Math.round(codex.weekly.usedPercent),
            window: windowLabel(codex.weekly.windowMinutes, "weekly"),
            reset: resetText(codex.weekly.resetsAtMs, nowMs),
          }
        : {
            percent: null,
            window: "no data",
            reset: codexLimits.note() ?? CODEX_NO_LIMITS,
          },
    },
    burn: localBurn(tokensPerHour(cxBuckets, now)),
    detailFooter: codexUsage?.summary
      ? codexSummaryFooter(codexUsage.summary)
      : localStatsFooter(cxStats, nowMs),
  };

  // opencode go
  const goBuckets: HourBuckets = opencode?.buckets.get(OPENCODE_PROVIDER_IDS.go ?? "") ?? new Map();
  const goStats = opencode?.stats.get(OPENCODE_PROVIDER_IDS.go ?? "");
  const goSpend = readGoSpend(paths.opencodeDb, now);
  const goServer = goLimits.read();
  const goNote = goLimits.note();
  const go: ProviderUsage = {
    id: "go",
    meta: meta.go,
    series: seriesFromBuckets(goBuckets, dates, now),
    limits: goServer
      ? serverGoLimits(goServer, goSpend, nowMs)
      : goSpend
        ? [
            spendLimit("session", "rolling 5h", "rolling 5h limit", goSpend.session, nowMs),
            spendLimit("weekly", "rolling 7d", "rolling 7d limit", goSpend.weekly, nowMs),
            spendLimit("monthly", "this cycle", "monthly limit", goSpend.monthly, nowMs, false),
          ]
        : [capLessLimit("usage", "plan usage", "plan usage", goNote ?? "no local usage", GO_LIMIT_FOOTNOTE)],
    scopes: {
      session: goServer
        ? {
            percent: Math.round(goServer.rollingPercent),
            window: "5h rolling · opencode",
            reset: resetText(goServer.rollingResetAtMs, nowMs),
          }
        : goSpend
          ? {
              percent: Math.round(goSpend.session.percent),
              window: "5h rolling · spend estimate",
              reset: spendResetText(goSpend.session, nowMs),
            }
          : { percent: null, window: "no data", reset: goNote ?? "no local usage" },
      weekly:
        goServer && goServer.weeklyPercent !== null
          ? {
              percent: Math.round(goServer.weeklyPercent),
              window: "7d · opencode",
              reset: resetText(goServer.weeklyResetAtMs, nowMs),
            }
          : goSpend
            ? {
                percent: Math.round(goSpend.weekly.percent),
                window: "7d rolling · spend estimate",
                reset: spendResetText(goSpend.weekly, nowMs),
              }
            : { percent: null, window: "no data", reset: goNote ?? GO_LIMIT_FOOTNOTE },
    },
    burn: localBurn(tokensPerHour(goBuckets, now)),
    detailFooter: sessionsFooter(goStats, "tokens from opencode.db"),
  };

  const fetchedAt = Math.min(
    nowMs,
    Math.max(
      opencode?.latestMs ?? 0,
      transcripts.latestMs,
      history.latestMs,
      snapshotFile?.writtenAtMs ?? 0,
    ) || nowMs,
  );

  return {
    providers: { cl, cx, go },
    dailyDates: dates,
    hourlyAxis: ["00:00", "12:00", "23:00"],
    fetchedAt,
    // Only caveats that still apply; a connected provider says nothing.
    windowNote: [
      codex ? null : (codexLimits.note() ?? "codex limits unavailable"),
      goServer ? null : goSpend ? "opencode go is a local spend estimate" : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
  };
}

export function createRealUsageProvider(options: RealProviderOptions = {}): UsageProvider {
  const paths = options.paths ?? defaultRealProviderPaths();
  const codexLimits = options.codexLimits ?? createCodexLimitsSource();
  const goLimits = options.goLimits ?? createGoLimitsSource(paths.opencodeCookie);
  const trend = createWeeklyTrend();
  const meta = buildMeta(readOpencodeAuth(paths.opencodeAuth));
  let snapshot = buildSnapshot(paths, meta, codexLimits, goLimits, trend);

  return {
    scopeTitles: { session: "current session", weekly: "weekly limit" },
    listMeta: () => meta,
    initialConnections: () =>
      buildConnections(
        paths,
        readOpencodeAuth(paths.opencodeAuth),
        readUsageSnapshot(paths.usageSnapshot, new Date()),
        Date.now(),
      ),
    readSnapshot: () => snapshot,
    refresh: async (signal) => {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Refresh aborted", "AbortError");
      }
      // Network limits refresh their cache first; a failure there must not
      // sink the local read, which is the source of truth for everything else.
      const at = new Date();
      await Promise.all([
        goLimits.poll(at, signal).catch(() => undefined),
        codexLimits.poll(at, signal).catch(() => undefined),
      ]);
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Refresh aborted", "AbortError");
      }
      snapshot = buildSnapshot(paths, meta, codexLimits, goLimits, trend);
      return snapshot;
    },
    maskCredential,
  };
}

const FALLBACK_NOTE = "no local usage sources found - showing sample data";

/** Mock, but stamped so nobody mistakes sample figures for live ones. */
function withFallbackNote(base: UsageProvider): UsageProvider {
  const patch = (snapshot: UsageSnapshot): UsageSnapshot => ({
    ...snapshot,
    windowNote: FALLBACK_NOTE,
    providers: {
      ...snapshot.providers,
      cl: {
        ...snapshot.providers.cl,
        notice: {
          icon: "ⓘ",
          iconColor: COLORS.warn,
          segments: [{ text: FALLBACK_NOTE }],
        },
      },
    },
  });
  return {
    ...base,
    readSnapshot: () => patch(base.readSnapshot()),
    refresh: (signal) => base.refresh(signal).then(patch),
  };
}

/** Real by default; --mock keeps the sample data; no sources falls back visibly. */
export function selectUsageProvider(
  mode: ProviderMode,
  paths = defaultRealProviderPaths(),
): UsageProvider {
  if (mode === "mock") return mockUsageProvider;
  if (hasRealSources(paths)) return createRealUsageProvider({ paths });
  return withFallbackNote(mockUsageProvider);
}
