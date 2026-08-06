import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configPath } from "../config";
import type { ProviderMode } from "../lib/args";
import { COLORS } from "../theme";
import { mockUsageProvider } from "./mock-provider";
import { DAY_MS, dailyDateKeys, formatAge, type HourBuckets } from "./real/aggregate";
import { buildClaudeProvider, createClaudeMeta } from "./real/claude-provider";
import { createClaudeAuthSource, type ClaudeAuthSource } from "./real/claude-auth";
import { readHistoryStats } from "./real/claude-history";
import { hasStatuslineConfigured } from "./real/claude-settings";
import { readClaudeTranscripts } from "./real/claude-transcripts";
import { createClaudeLimitsSource, type ClaudeLimitsSource } from "./real/claude-usage";
import { buildCodexProvider, codexWindowNote, createCodexMeta } from "./real/codex-provider";
import { readCodexSessions } from "./real/codex-sessions";
import { createCodexLimitsSource, type CodexLimitsSource } from "./real/codex-limits";
import { buildGoProvider, createGoMeta } from "./real/go-provider";
import { createGoLimitsSource, readCookie, type GoLimitsSource } from "./real/go-limits-source";
import { readOpencodeAuth, type OpencodeAuth } from "./real/opencode-auth";
import { readOpencodeUsage } from "./real/opencode-db";
import { readGoSpend } from "./real/opencode-go-spend";
import { readUsageCache, updateUsageCache, type UsageCache } from "./real/usage-cache";
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
  RefreshRequest,
  UsageProvider,
  UsageSnapshot,
} from "./types";
import { PROVIDER_IDS } from "./types";

export interface RealProviderPaths {
  opencodeDb: string;
  opencodeAuth: string;
  configFile: string;
  claudeProjects: string;
  claudeHistory: string;
  claudeSettings: string;
  usageSnapshot: string;
  usageCache: string;
  codexHome: string;
  claudeExecutable?: string | null;
  codexExecutable?: string | null;
  opencodeExecutable?: string | null;
}

export function defaultRealProviderPaths(): RealProviderPaths {
  const home = homedir();
  const opencodeData = join(home, ".local", "share", "opencode");
  // Both CLIs document these overrides; relative OPENCODE_DB names resolve
  // under the opencode data directory.
  const opencodeDbEnv = process.env.OPENCODE_DB?.trim();
  const codexHomeEnv = process.env.CODEX_HOME?.trim();
  return {
    opencodeDb: opencodeDbEnv
      ? opencodeDbEnv.startsWith("/")
        ? opencodeDbEnv
        : join(opencodeData, opencodeDbEnv)
      : join(opencodeData, "opencode.db"),
    opencodeAuth: join(opencodeData, "auth.json"),
    configFile: configPath("config.json"),
    claudeProjects: join(home, ".claude", "projects"),
    claudeHistory: join(home, ".claude", "history.jsonl"),
    claudeSettings: join(home, ".claude", "settings.json"),
    usageSnapshot: join(home, ".claude", "usage-snapshot.json"),
    usageCache: configPath("usage-cache.json"),
    codexHome: codexHomeEnv || join(home, ".codex"),
    claudeExecutable: Bun.which("claude"),
    codexExecutable: Bun.which("codex"),
    opencodeExecutable: Bun.which("opencode"),
  };
}

export function detectAgentInstallations(
  paths: RealProviderPaths,
): Record<ProviderId, boolean> {
  return {
    cl:
      Boolean(paths.claudeExecutable) ||
      existsSync(paths.claudeProjects) ||
      existsSync(paths.claudeHistory),
    cx: Boolean(paths.codexExecutable) || existsSync(paths.codexHome),
    go:
      Boolean(paths.opencodeExecutable) ||
      existsSync(paths.opencodeDb) ||
      existsSync(paths.opencodeAuth),
  };
}

/**
 * A dashboard cookie is a go source in its own right: it reports exact limits
 * with no opencode install. It never carries history, so it complements
 * opencode.db rather than replacing it.
 */
export function hasOpencodeCookie(
  paths: RealProviderPaths,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readCookie(paths.configFile, env) !== null;
}

export function hasRealSources(
  paths: RealProviderPaths,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const installations = detectAgentInstallations(paths);
  return (
    PROVIDER_IDS.some((id) => installations[id]) ||
    hasOpencodeCookie(paths, env) ||
    hasCachedProviderValues(paths.usageCache)
  );
}

function hasCachedProviderValues(path: string): boolean {
  const cache = readUsageCache(path);
  return cache.claude !== null || cache.codex !== null || cache.go !== null;
}

const STATS_WINDOW_DAYS = 30;

function buildMeta(): Record<ProviderId, ProviderMeta> {
  return {
    cl: createClaudeMeta(),
    cx: createCodexMeta(),
    go: createGoMeta(),
  };
}

function claudeConnectionNote(snapshotFile: SnapshotFile | null, hasStatusline: boolean): string {
  if (!snapshotFile) {
    return hasStatusline
      ? "live limits via claude cli; no statusline snapshot yet"
      : "live limits via claude cli";
  }
  const age = formatAge(snapshotFile.ageMs);
  return snapshotFile.ageMs < SNAPSHOT_FRESH_MS
    ? `statusline snapshot ${age === "just now" ? "just written" : `${age} old`}`
    : `live limits via claude cli; statusline snapshot ${age} old`;
}

const GO_COOKIE_CREDENTIAL = "cookie · opencode.ai";

function goCredential(auth: OpencodeAuth, hasCookie: boolean, hasLocalData: boolean): string {
  // The cookie is what authorizes the figures on screen, so it outranks the
  // stored api key, which nothing here ever spends.
  if (hasCookie) return GO_COOKIE_CREDENTIAL;
  return auth.opencodeGo?.maskedKey ?? (hasLocalData ? "local · opencode.db" : "");
}

function goNote(hasCookie: boolean, hasLocalData: boolean): string {
  if (hasCookie) {
    return hasLocalData
      ? "exact limits via dashboard cookie"
      : "exact limits via cookie; no local history";
  }
  return hasLocalData
    ? "local estimate; dashboard cookie is optional"
    : "opencode found; use Go once to create local usage data";
}

/** Visible when opencode is installed or a cookie is configured; either alone is enough. */
function goConnection(
  paths: RealProviderPaths,
  auth: OpencodeAuth,
  isAgentInstalled: boolean,
  hasCookie: boolean,
): ProviderConnection {
  if (!isAgentInstalled && !hasCookie) {
    return {
      isEnabled: false,
      isAgentInstalled: false,
      status: "none",
      credential: "",
      note: "opencode not found",
    };
  }
  const hasLocalData = existsSync(paths.opencodeDb);
  return {
    isEnabled: true,
    isAgentInstalled,
    status: hasCookie || hasLocalData || auth.opencodeGo ? "active" : "none",
    credential: goCredential(auth, hasCookie, hasLocalData),
    note: goNote(hasCookie, hasLocalData),
  };
}

function buildConnections(
  paths: RealProviderPaths,
  auth: OpencodeAuth,
  snapshotFile: SnapshotFile | null,
  hasCookie: boolean,
): Record<ProviderId, ProviderConnection> {
  const installations = detectAgentInstallations(paths);
  const hasClaudeData = existsSync(paths.claudeProjects) || existsSync(paths.claudeHistory);
  const hasCodexData = existsSync(paths.codexHome);

  return {
    cl: installations.cl
      ? {
          isEnabled: true,
          isAgentInstalled: true,
          status: hasClaudeData ? "active" : "none",
          credential: hasClaudeData ? "oauth · claude code" : "",
          note: hasClaudeData
            ? claudeConnectionNote(snapshotFile, hasStatuslineConfigured(paths.claudeSettings))
            : "claude code found; sign in with its CLI",
        }
      : {
          isEnabled: false,
          isAgentInstalled: false,
          status: "none",
          credential: "",
          note: "claude code not found",
        },
    cx: installations.cx
      ? {
          isEnabled: true,
          isAgentInstalled: true,
          status: hasCodexData ? "active" : "none",
          credential: hasCodexData ? "oauth · codex cli" : "",
          note: hasCodexData
            ? "live account data refreshes with the app poll"
            : "codex found; sign in with its CLI",
        }
      : {
          isEnabled: false,
          isAgentInstalled: false,
          status: "none",
          credential: "",
          note: "codex not found",
        },
    go: goConnection(paths, auth, installations.go, hasCookie),
  };
}

interface RealProviderOptions {
  paths?: RealProviderPaths;
  env?: Record<string, string | undefined>;
  codexLimits?: CodexLimitsSource;
  goLimits?: GoLimitsSource;
  claudeLimits?: ClaudeLimitsSource;
  claudeAuth?: ClaudeAuthSource;
}

function providerBuckets(
  opencode: ReturnType<typeof readOpencodeUsage>,
  providerId: string,
): HourBuckets {
  return opencode?.buckets.get(providerId) ?? new Map();
}

function latestSourceTimestamp(nowMs: number, timestamps: number[]): number {
  const latestTimestamp = Math.max(...timestamps);
  if (latestTimestamp === 0) return nowMs;
  return Math.min(nowMs, latestTimestamp);
}

function buildSnapshot(
  paths: RealProviderPaths,
  meta: Record<ProviderId, ProviderMeta>,
  claudeLimits: ClaudeLimitsSource,
  codexLimits: CodexLimitsSource,
  goLimits: GoLimitsSource,
  trend: WeeklyTrend,
  claudeAuth: ClaudeAuthSource,
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
    limitsSource: claudeLimits,
    hasStatusline: hasStatuslineConfigured(paths.claudeSettings),
    trend,
    dates,
    now,
    authSource: claudeAuth,
  });
  // Native rollout files see every codex session on this device; opencode.db
  // only sees what opencode itself sent to an "openai" provider, so it is
  // merely a fallback.
  const codexLocal = readCodexSessions(paths.codexHome, now);
  const cx = buildCodexProvider({
    meta: meta.cx,
    buckets: codexLocal?.buckets ?? providerBuckets(opencode, "openai"),
    stats: codexLocal
      ? {
          sessions: codexLocal.sessions,
          tokens: codexLocal.tokens,
          latestMs: codexLocal.latestMs,
          topModel: codexLocal.topModel,
        }
      : opencode?.stats.get("openai"),
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
  const fetchedAt = latestSourceTimestamp(nowMs, [
    claudeLimits.read()?.fetchedAtMs ?? 0,
    codexLimits.read()?.fetchedAtMs ?? 0,
    goLimits.read()?.fetchedAtMs ?? 0,
    opencode?.latestMs ?? 0,
    transcripts.latestMs,
    history.latestMs,
    snapshotFile?.writtenAtMs ?? 0,
  ]);

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
  const env = options.env ?? process.env;
  const cached = readUsageCache(paths.usageCache);
  const persist = (key: keyof UsageCache, value: UsageCache[typeof key]) => {
    updateUsageCache(paths.usageCache, key, value);
  };
  const codexLimits = options.codexLimits ?? createCodexLimitsSource(undefined, {
    initial: cached.codex,
    onUpdate: (value) => persist("codex", value),
  });
  const goLimits = options.goLimits ?? createGoLimitsSource(paths.configFile, env, undefined, {
    initial: cached.go,
    onUpdate: (value) => persist("go", value),
  });
  const claudeLimits = options.claudeLimits ?? createClaudeLimitsSource(undefined, {
    initial: cached.claude,
    onUpdate: (value) => persist("claude", value),
    // Claude Code writes the statusline snapshot itself, at no cost to the
    // account. While it is fresh it already carries the session and weekly
    // windows, so the CLI only needs to keep the Fable window current.
    isCoveredBySnapshot: () => {
      const now = new Date();
      const snapshotFile = readUsageSnapshot(paths.usageSnapshot, now);
      return snapshotFile !== null && snapshotFile.ageMs < SNAPSHOT_FRESH_MS;
    },
  });
  const claudeAuth = options.claudeAuth ?? createClaudeAuthSource();
  const trend = createWeeklyTrend();
  const meta = buildMeta();
  let snapshot = buildSnapshot(paths, meta, claudeLimits, codexLimits, goLimits, trend, claudeAuth);

  return {
    scopeTitles: { session: "current session", weekly: "weekly limit" },
    listMeta: () => meta,
    initialConnections: () =>
      buildConnections(
        paths,
        readOpencodeAuth(paths.opencodeAuth),
        readUsageSnapshot(paths.usageSnapshot, new Date()),
        hasOpencodeCookie(paths, env),
      ),
    readSnapshot: () => snapshot,
    refresh: async (request: RefreshRequest) => {
      const signal = request.signal;
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Refresh aborted", "AbortError");
      }
      // Network limits refresh their cache first; a failure there must not
      // sink the local read, which is the source of truth for everything else.
      const at = new Date();
      const providerIds = new Set(request.providerIds);
      const pollOptions = { signal, force: request.reason === "manual" };
      await Promise.all(
        [
          providerIds.has("cl") ? claudeLimits.poll(at, pollOptions) : null,
          providerIds.has("cl") ? claudeAuth.poll(at, pollOptions) : null,
          providerIds.has("go") ? goLimits.poll(at, pollOptions) : null,
          providerIds.has("cx") ? codexLimits.poll(at, pollOptions) : null,
        ].map((poll) => poll?.catch(() => undefined)),
      );
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Refresh aborted", "AbortError");
      }
      snapshot = buildSnapshot(paths, meta, claudeLimits, codexLimits, goLimits, trend, claudeAuth);
      return snapshot;
    },
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
    refresh: (request) => base.refresh(request).then(patch),
  };
}

/** Real by default; --mock keeps the sample data; no sources falls back visibly. */
export function selectUsageProvider(
  mode: ProviderMode,
  paths = defaultRealProviderPaths(),
  env: Record<string, string | undefined> = process.env,
): UsageProvider {
  if (mode === "mock") return mockUsageProvider;
  if (hasRealSources(paths, env)) return createRealUsageProvider({ paths, env });
  return withFallbackNote(mockUsageProvider);
}
