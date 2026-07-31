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
  tokensPerHour,
  type HourBuckets,
} from "./real/aggregate";
import { readHistoryStats } from "./real/claude-history";
import { readClaudeTranscripts } from "./real/claude-transcripts";
import { stubCodexLimitsSource, type CodexLimitsSource } from "./real/codex-limits";
import { readOpencodeAuth, type OpencodeAuth } from "./real/opencode-auth";
import { readOpencodeUsage, type OpencodeSessionStats } from "./real/opencode-db";
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
  claudeProjects: string;
  claudeHistory: string;
  usageSnapshot: string;
}

export function defaultRealProviderPaths(): RealProviderPaths {
  const home = homedir();
  return {
    opencodeDb: join(home, ".local", "share", "opencode", "opencode.db"),
    opencodeAuth: join(home, ".local", "share", "opencode", "auth.json"),
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

const GO_LIMIT_FOOTNOTE = "no usage api yet - opencode.ai dashboard";
const NO_CAP_DATA = "no cap data";
const STATS_WINDOW_DAYS = 30;

function buildMeta(auth: OpencodeAuth): Record<ProviderId, ProviderMeta> {
  return {
    cl: {
      id: "cl",
      name: "claude code",
      plan: "local data",
      planShort: "local data",
      planDetail: "statusline snapshot + local transcripts",
      requirement: "claude code installed (oauth)",
      source: "~/.claude",
      fake: "oauth · claude code",
    },
    cx: {
      id: "cx",
      name: "codex",
      plan: "local usage only",
      planShort: "local usage",
      planDetail: "usage from opencode.db · limits not connected",
      requirement: "openai oauth via opencode",
      source: "~/.local/share/opencode/opencode.db",
      fake: "oauth · openai",
    },
    go: {
      id: "go",
      name: "opencode go",
      plan: "local usage only",
      planShort: "local usage",
      planDetail: "usage from opencode.db · no usage api",
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
}

function buildSnapshot(
  paths: RealProviderPaths,
  meta: Record<ProviderId, ProviderMeta>,
  codexLimits: CodexLimitsSource,
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
  const cx: ProviderUsage = {
    id: "cx",
    meta: meta.cx,
    series: seriesFromBuckets(cxBuckets, dates, now),
    limits: [
      codex
        ? {
            id: "weekly",
            label: "weekly limit",
            detailLabel: "weekly usage limit",
            percent: Math.round(codex.weeklyPercent),
            reset: resetText(codex.resetsAtMs, nowMs),
          }
        : capLessLimit("weekly", "weekly limit", "weekly usage limit", codexLimits.note, codexLimits.note),
    ],
    scopes: {
      session: { percent: null, window: "no session cap", reset: "counted in the weekly pool" },
      weekly: {
        percent: codex ? Math.round(codex.weeklyPercent) : null,
        window: "7d · openai plan",
        reset: codex ? resetText(codex.resetsAtMs, nowMs) : codexLimits.note,
      },
    },
    burn: localBurn(tokensPerHour(cxBuckets, now)),
    detailFooter: sessionsFooter(cxStats, "tokens from opencode.db"),
  };

  // opencode go
  const goBuckets: HourBuckets = opencode?.buckets.get(OPENCODE_PROVIDER_IDS.go ?? "") ?? new Map();
  const goStats = opencode?.stats.get(OPENCODE_PROVIDER_IDS.go ?? "");
  const go: ProviderUsage = {
    id: "go",
    meta: meta.go,
    series: seriesFromBuckets(goBuckets, dates, now),
    limits: [
      capLessLimit("usage", "plan usage", "plan usage", "no usage api yet", GO_LIMIT_FOOTNOTE),
    ],
    scopes: {
      session: { percent: null, window: "no data", reset: "no usage api yet" },
      weekly: { percent: null, window: "no data", reset: GO_LIMIT_FOOTNOTE },
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
    windowNote:
      "claude limits come from the statusline snapshot - codex and opencode go limits are not connected yet",
  };
}

export function createRealUsageProvider(options: RealProviderOptions = {}): UsageProvider {
  const paths = options.paths ?? defaultRealProviderPaths();
  const codexLimits = options.codexLimits ?? stubCodexLimitsSource;
  const trend = createWeeklyTrend();
  const meta = buildMeta(readOpencodeAuth(paths.opencodeAuth));
  let snapshot = buildSnapshot(paths, meta, codexLimits, trend);

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
    refresh: (signal) =>
      Promise.resolve().then(() => {
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Refresh aborted", "AbortError");
        }
        snapshot = buildSnapshot(paths, meta, codexLimits, trend);
        return snapshot;
      }),
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
