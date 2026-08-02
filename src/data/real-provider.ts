import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderMode } from "../lib/args";
import { COLORS } from "../theme";
import { maskCredential } from "./mask";
import { mockUsageProvider } from "./mock-provider";
import { DAY_MS, dailyDateKeys, formatAge, formatCountdown, type HourBuckets } from "./real/aggregate";
import { buildClaudeProvider, createClaudeMeta } from "./real/claude-provider";
import { readHistoryStats } from "./real/claude-history";
import { hasStatuslineConfigured } from "./real/claude-settings";
import { readClaudeTranscripts } from "./real/claude-transcripts";
import { buildCodexProvider, codexWindowNote, createCodexMeta } from "./real/codex-provider";
import { createCodexLimitsSource, type CodexLimitsSource } from "./real/codex-limits";
import { buildGoProvider, createGoMeta } from "./real/go-provider";
import { createGoLimitsSource, type GoLimitsSource } from "./real/go-limits-source";
import { readOpencodeAuth, type OpencodeAuth } from "./real/opencode-auth";
import { readOpencodeUsage } from "./real/opencode-db";
import { readGoSpend } from "./real/opencode-go-spend";
import {
  SNAPSHOT_FRESH_MS,
  createWeeklyTrend,
  readUsageSnapshot,
  type SnapshotFile,
  type WeeklyTrend,
} from "./real/statusline-snapshot";
import type {
  ProviderConnection,
  ProviderId,
  ProviderMeta,
  UsageProvider,
  UsageSnapshot,
} from "./types";

export interface RealProviderPaths {
  opencodeDb: string;
  opencodeAuth: string;
  configFile: string;
  claudeProjects: string;
  claudeHistory: string;
  claudeSettings: string;
  usageSnapshot: string;
}

export function defaultRealProviderPaths(): RealProviderPaths {
  const home = homedir();
  return {
    opencodeDb: join(home, ".local", "share", "opencode", "opencode.db"),
    opencodeAuth: join(home, ".local", "share", "opencode", "auth.json"),
    configFile: join(home, ".config", "limitless", "config.json"),
    claudeProjects: join(home, ".claude", "projects"),
    claudeHistory: join(home, ".claude", "history.jsonl"),
    claudeSettings: join(home, ".claude", "settings.json"),
    usageSnapshot: join(home, ".claude", "usage-snapshot.json"),
  };
}

export function hasRealSources(paths: RealProviderPaths): boolean {
  return existsSync(paths.opencodeDb) || existsSync(paths.claudeProjects);
}

const STATS_WINDOW_DAYS = 30;

function buildMeta(auth: OpencodeAuth): Record<ProviderId, ProviderMeta> {
  return {
    cl: createClaudeMeta(),
    cx: createCodexMeta(),
    go: createGoMeta(auth),
  };
}

function claudeConnectionNote(snapshotFile: SnapshotFile | null, hasStatusline: boolean): string {
  if (!snapshotFile) return hasStatusline ? "no statusline snapshot yet" : "no statusline configured";
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
          note: claudeConnectionNote(snapshotFile, hasStatuslineConfigured(paths.claudeSettings)),
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

interface RealProviderOptions {
  paths?: RealProviderPaths;
  codexLimits?: CodexLimitsSource;
  goLimits?: GoLimitsSource;
}

function providerBuckets(
  opencode: ReturnType<typeof readOpencodeUsage>,
  providerId: string,
): HourBuckets {
  return opencode?.buckets.get(providerId) ?? new Map();
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
  const cl = buildClaudeProvider({
    meta: meta.cl,
    transcripts,
    history,
    snapshotFile,
    hasStatusline: hasStatuslineConfigured(paths.claudeSettings),
    trend,
    dates,
    now,
  });
  const cx = buildCodexProvider({
    meta: meta.cx,
    buckets: providerBuckets(opencode, "openai"),
    stats: opencode?.stats.get("openai"),
    limitsSource: codexLimits,
    dates,
    now,
  });
  const goSpend = readGoSpend(paths.opencodeDb, now);
  const goResult = buildGoProvider({
    meta: meta.go,
    buckets: providerBuckets(opencode, "opencode-go"),
    stats: opencode?.stats.get("opencode-go"),
    spend: goSpend,
    limitsSource: goLimits,
    dates,
    now,
  });
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
    providers: { cl, cx, go: goResult.provider },
    dailyDates: dates,
    hourlyAxis: ["00:00", "12:00", "23:00"],
    fetchedAt,
    // Only caveats that still apply; a connected provider says nothing.
    windowNote: [
      codexWindowNote(codexLimits),
      goResult.usesEstimate && goSpend ? "opencode go is a local spend estimate" : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
  };
}

export function createRealUsageProvider(options: RealProviderOptions = {}): UsageProvider {
  const paths = options.paths ?? defaultRealProviderPaths();
  const codexLimits = options.codexLimits ?? createCodexLimitsSource();
  const goLimits = options.goLimits ?? createGoLimitsSource(paths.configFile);
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
