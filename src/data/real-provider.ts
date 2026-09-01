import { existsSync, statSync } from "node:fs";
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
import { emptyTranscriptAggregate, readClaudeTranscripts } from "./real/claude-transcripts";
import { readClaudeAccountUsage } from "./real/claude-account-usage";
import { buildClaudeSpend, recordClaudeSpend } from "./real/claude-spend";
import { loadPriceTable } from "./real/pricing";
import { createClaudeLimitsSource, type ClaudeLimitsSource } from "./real/claude-usage";
import { buildCodexProvider, codexWindowNote, createCodexMeta } from "./real/codex-provider";
import { readCodexSessions } from "./real/codex-sessions";
import { createCodexLimitsSource, type CodexLimitsSource } from "./real/codex-limits";
import { buildGoProvider, createGoMeta } from "./real/go-provider";
import {
  createGoLimitsSource,
  readApiKey,
  readCookie,
  type GoCredentialKind,
  type GoLimitsSource,
} from "./real/go-limits-source";
import { createGoHistorySource, type GoHistorySource } from "./real/go-history-source";
import { readOpencodeAuth, type OpencodeAuth } from "./real/opencode-auth";
import { readOpencodeUsage } from "./real/opencode-db";
import { readGoSpend } from "./real/opencode-go-spend";
import { readGoHistoryCache, writeGoHistoryCache } from "./real/go-history-cache";
import { readUsageCache, updateUsageCache, type UsageCache } from "./real/usage-cache";
import {
  SNAPSHOT_FRESH_MS,
  createWeeklyTrend,
  readUsageSnapshot,
  type SnapshotFile,
  type WeeklyTrend,
} from "./real/statusline-snapshot";
import type {
  ConnectionStatus,
  ProviderConnection,
  ProviderId,
  ProviderMeta,
  ProviderUsage,
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
  /** The Go month history and usage table, apart from the limits because of its size. */
  goHistoryCache: string;
  /** `~/.claude.json` - the only local source of real credit spend. */
  claudeConfig: string;
  /** Our own append-only record of spend and per-day tokens. */
  spendHistory: string;
  /** Optional user overrides for the shipped price table. */
  pricingOverrides: string;
  codexHome: string;
  claudeExecutable?: string | null;
  codexExecutable?: string | null;
  opencodeExecutable?: string | null;
}

export interface DefaultRealProviderPathOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  which?: (command: string, path: string | undefined) => string | null;
}

export function defaultRealProviderPaths(
  options: DefaultRealProviderPathOptions = {},
): RealProviderPaths {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const which = options.which ?? ((command: string, path: string | undefined) =>
    Bun.which(command, { PATH: path }));
  const opencodeData = join(home, ".local", "share", "opencode");
  // Both CLIs document these overrides; relative OPENCODE_DB names resolve
  // under the opencode data directory.
  const opencodeDbEnv = env.OPENCODE_DB?.trim();
  const codexHomeEnv = env.CODEX_HOME?.trim();
  return {
    opencodeDb: opencodeDbEnv
      ? opencodeDbEnv.startsWith("/")
        ? opencodeDbEnv
        : join(opencodeData, opencodeDbEnv)
      : join(opencodeData, "opencode.db"),
    opencodeAuth: join(opencodeData, "auth.json"),
    configFile: configPath("config.json", env, home),
    claudeProjects: join(home, ".claude", "projects"),
    claudeHistory: join(home, ".claude", "history.jsonl"),
    claudeSettings: join(home, ".claude", "settings.json"),
    usageSnapshot: join(home, ".claude", "usage-snapshot.json"),
    usageCache: configPath("usage-cache.json", env, home),
    goHistoryCache: configPath("go-history.json", env, home),
    claudeConfig: join(home, ".claude.json"),
    spendHistory: configPath("spend-history.json", env, home),
    pricingOverrides: configPath("pricing.json", env, home),
    codexHome: codexHomeEnv || join(home, ".codex"),
    claudeExecutable: which("claude", env.PATH),
    codexExecutable: which("codex", env.PATH),
    opencodeExecutable: which("opencode", env.PATH),
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
 * A dashboard cookie is a go source in its own right, and the fuller of the
 * two: it reports exact limits plus workspace-wide activity with no opencode
 * install at all, where opencode.db only ever sees this device.
 */
export function hasOpencodeCookie(
  paths: RealProviderPaths,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readCookie(paths.configFile, env) !== null;
}

export function hasOpencodeApiKey(
  paths: RealProviderPaths,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readApiKey(paths.configFile, env) !== null;
}

export function hasRealSources(
  paths: RealProviderPaths,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const installations = detectAgentInstallations(paths);
  return (
    PROVIDER_IDS.some((id) => installations[id]) ||
    hasOpencodeApiKey(paths, env) ||
    hasOpencodeCookie(paths, env) ||
    hasCachedProviderValues(paths.usageCache)
  );
}

function hasCachedProviderValues(path: string): boolean {
  const cache = readUsageCache(path);
  return cache.claude !== null || cache.codex !== null || cache.go !== null;
}

const STATS_WINDOW_DAYS = 30;

/**
 * Re-reads a file only when its size or mtime has moved. The shared caches are
 * re-read by every source on every tick, and parsing the same bytes four times
 * a minute is not the point of a cache.
 */
function memoizedByStamp<T>(path: string, read: (path: string) => T): () => T {
  let memo: { stamp: string; value: T } | null = null;
  return () => {
    let stamp: string;
    try {
      const stats = statSync(path);
      stamp = `${stats.mtimeMs}:${stats.size}`;
    } catch {
      stamp = "missing";
    }
    if (memo?.stamp !== stamp) memo = { stamp, value: read(path) };
    return memo.value;
  };
}

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
const GO_API_CREDENTIAL = "api key · opencode go";

function goCredential(
  auth: OpencodeAuth,
  remoteKind: GoCredentialKind | null,
  hasLocalData: boolean,
): string {
  if (remoteKind === "api-key") return GO_API_CREDENTIAL;
  if (remoteKind === "cookie") return GO_COOKIE_CREDENTIAL;
  return auth.opencodeGo?.maskedKey ?? (hasLocalData ? "local · opencode.db" : "");
}

function goNote(
  remoteKind: GoCredentialKind | null,
  hasCookie: boolean,
  hasLocalData: boolean,
  status: ConnectionStatus,
): string {
  if (remoteKind) {
    if (status === "active") {
      const history = hasCookie ? " ▏ workspace history" : hasLocalData ? " ▏ local history" : "";
      return `live limits via ${remoteKind === "api-key" ? "API" : "dashboard"}${history}`;
    }
    if (status === "cached") return "cached exact limits";
    const ready = remoteKind === "api-key" ? "API key ready" : "cookie ready";
    return hasLocalData ? `${ready}; local history` : ready;
  }
  return hasLocalData
    ? "local estimate; API key is optional"
    : "opencode found; use Go once to create local usage data";
}

function limitsStatus(
  source: { status?(): ConnectionStatus; read(): unknown; note(): string | null },
): ConnectionStatus {
  if (source.status) return source.status();
  if (source.note()) return "expired";
  return source.read() ? "cached" : "none";
}

/** Visible when opencode is installed or a cookie is configured; either alone is enough. */
function goConnection(
  paths: RealProviderPaths,
  auth: OpencodeAuth,
  isAgentInstalled: boolean,
  hasCookie: boolean,
  limits: GoLimitsSource,
  hasLocalLimits: boolean,
): ProviderConnection {
  const remoteKind = limits.credentialKind?.() ?? (hasCookie ? "cookie" : null);
  if (!isAgentInstalled && !remoteKind) {
    return {
      isEnabled: false,
      isAgentInstalled: false,
      status: "none",
      credential: "",
      note: "opencode not found",
    };
  }
  const hasLocalData = existsSync(paths.opencodeDb);
  const remoteStatus = limitsStatus(limits);
  const status = remoteStatus === "none" && hasLocalLimits ? "local" : remoteStatus;
  return {
    isEnabled: true,
    isAgentInstalled,
    status,
    credential: goCredential(auth, remoteKind, hasLocalData),
    note:
      status === "expired"
        ? (limits.note() ?? "limits unavailable")
        : status === "local"
          ? "local estimate"
          : goNote(remoteKind, hasCookie, hasLocalData && hasLocalLimits, status),
  };
}

function buildConnections(
  paths: RealProviderPaths,
  auth: OpencodeAuth,
  snapshotFile: SnapshotFile | null,
  hasCookie: boolean,
  claudeLimits: ClaudeLimitsSource,
  codexLimits: CodexLimitsSource,
  goLimits: GoLimitsSource,
  claudeAuth: ClaudeAuthSource,
  hasGoLocalLimits: boolean,
): Record<ProviderId, ProviderConnection> {
  const installations = detectAgentInstallations(paths);
  const claudeAuthInfo = claudeAuth.read();
  const claudeStatus = claudeAuthInfo?.loggedIn === false ? "expired" : limitsStatus(claudeLimits);
  const codexStatus = limitsStatus(codexLimits);
  const hasClaude = installations.cl || claudeStatus !== "none";
  const hasCodex = installations.cx || codexStatus !== "none";

  return {
    cl: hasClaude
      ? {
          isEnabled: true,
          isAgentInstalled: installations.cl,
          status: claudeStatus,
          credential: claudeStatus === "none" ? "" : "oauth · claude code",
          note:
            claudeStatus === "active"
              ? claudeConnectionNote(snapshotFile, hasStatuslineConfigured(paths.claudeSettings))
              : claudeStatus === "cached"
                ? "cached limits"
                : claudeStatus === "expired"
                  ? (claudeLimits.note() ?? "claude not signed in")
                  : "claude code found; sign in with its CLI",
        }
      : {
          isEnabled: false,
          isAgentInstalled: false,
          status: "none",
          credential: "",
          note: "claude code not found",
        },
    cx: hasCodex
      ? {
          isEnabled: true,
          isAgentInstalled: installations.cx,
          status: codexStatus,
          credential: codexStatus === "none" ? "" : "oauth · codex cli",
          note:
            codexStatus === "active"
              ? "live account limits"
              : codexStatus === "cached"
                ? "cached limits"
                : codexStatus === "expired"
                  ? (codexLimits.note() ?? "codex limits unavailable")
                  : "codex found; sign in with its CLI",
        }
      : {
          isEnabled: false,
          isAgentInstalled: false,
          status: "none",
          credential: "",
          note: "codex not found",
        },
    go: goConnection(paths, auth, installations.go, hasCookie, goLimits, hasGoLocalLimits),
  };
}

interface RealProviderOptions {
  paths?: RealProviderPaths;
  env?: Record<string, string | undefined>;
  codexLimits?: CodexLimitsSource;
  goLimits?: GoLimitsSource;
  goHistory?: GoHistorySource;
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

const UNREADABLE_NOTICE = "usage source unreadable";

function withUnreadableNotice(provider: ProviderUsage): ProviderUsage {
  return {
    ...provider,
    hasHistory: false,
    notice: provider.notice
      ? {
          ...provider.notice,
          icon: "▲",
          iconColor: COLORS.warn,
          segments: [...provider.notice.segments, { text: ` · ${UNREADABLE_NOTICE}` }],
        }
      : {
          icon: "▲",
          iconColor: COLORS.warn,
          segments: [{ text: UNREADABLE_NOTICE }],
        },
  };
}

interface BuiltSnapshot {
  snapshot: UsageSnapshot;
  hasGoLocalLimits: boolean;
}

function buildSnapshot(
  paths: RealProviderPaths,
  meta: Record<ProviderId, ProviderMeta>,
  claudeLimits: ClaudeLimitsSource,
  codexLimits: CodexLimitsSource,
  goLimits: GoLimitsSource,
  goHistory: GoHistorySource,
  trend: WeeklyTrend,
  claudeAuth: ClaudeAuthSource,
): BuiltSnapshot {
  const now = new Date();
  const nowMs = now.getTime();
  const dates = dailyDateKeys(now);
  const unreadable = new Set<ProviderId>();
  let opencode: ReturnType<typeof readOpencodeUsage> = null;
  try {
    opencode = readOpencodeUsage(paths.opencodeDb, now);
  } catch {
    unreadable.add("cx");
    unreadable.add("go");
  }
  let transcripts: ReturnType<typeof readClaudeTranscripts>;
  try {
    transcripts = readClaudeTranscripts(paths.claudeProjects);
  } catch {
    unreadable.add("cl");
    transcripts = emptyTranscriptAggregate();
  }
  const history = readHistoryStats(paths.claudeHistory, nowMs - STATS_WINDOW_DAYS * DAY_MS);
  const snapshotFile = readUsageSnapshot(paths.usageSnapshot, now);
  // Money and long-range history: Claude's own account figures for spend, our
  // own record for tokens, since Claude keeps neither past the current window.
  const priceTable = loadPriceTable(paths.pricingOverrides);
  const account = readClaudeAccountUsage(paths.claudeConfig);
  const spendStore = recordClaudeSpend({
    path: paths.spendHistory,
    account,
    transcripts,
    nowMs,
  });
  const spend = buildClaudeSpend({ account, store: spendStore, table: priceTable, now });
  const cl = buildClaudeProvider({
    meta: meta.cl,
    transcripts,
    history,
    snapshotFile,
    spend,
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
  let codexLocal: ReturnType<typeof readCodexSessions> = null;
  try {
    codexLocal = readCodexSessions(paths.codexHome, now);
  } catch {
    unreadable.add("cx");
  }
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
  let goSpend: ReturnType<typeof readGoSpend> = null;
  try {
    goSpend = readGoSpend(paths.opencodeDb, now);
  } catch {
    unreadable.add("go");
  }
  const goResult = buildGoProvider({
    meta: meta.go,
    buckets: providerBuckets(opencode, "opencode-go"),
    stats: opencode?.stats.get("opencode-go"),
    spend: goSpend,
    limitsSource: goLimits,
    dates,
    now,
    history: goHistory.read(),
    billing: goHistory.billing(),
    activity: goHistory.activity(),
  });
  const fetchedAt = latestSourceTimestamp(nowMs, [
    claudeLimits.read()?.fetchedAtMs ?? 0,
    codexLimits.read()?.fetchedAtMs ?? 0,
    goLimits.read(now)?.fetchedAtMs ?? 0,
    opencode?.latestMs ?? 0,
    transcripts.latestMs,
    history.latestMs,
    snapshotFile?.writtenAtMs ?? 0,
  ]);

  return {
    hasGoLocalLimits: goSpend !== null,
    snapshot: {
      providers: {
        cl: unreadable.has("cl") ? withUnreadableNotice(cl) : cl,
        cx: unreadable.has("cx") ? withUnreadableNotice(cx) : cx,
        go: unreadable.has("go") ? withUnreadableNotice(goResult.provider) : goResult.provider,
      },
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
    },
  };
}

export function createRealUsageProvider(options: RealProviderOptions = {}): UsageProvider {
  const paths = options.paths ?? defaultRealProviderPaths();
  const env = options.env ?? process.env;
  const cached = readUsageCache(paths.usageCache);
  const persist = (key: keyof UsageCache, value: UsageCache[typeof key]) => {
    updateUsageCache(paths.usageCache, key, value);
  };
  // Re-read on every tick: the daemon and the dashboard share these files, and
  // a reading one of them has just made is one the other need not make again.
  const readPersistedCache = memoizedByStamp(paths.usageCache, readUsageCache);
  const persisted = <K extends keyof UsageCache>(key: K) => () => readPersistedCache()[key];
  const readPersistedHistory = memoizedByStamp(paths.goHistoryCache, readGoHistoryCache);
  const codexLimits = options.codexLimits ?? createCodexLimitsSource(undefined, {
    initial: cached.codex,
    onUpdate: (value) => persist("codex", value),
    readPersisted: persisted("codex"),
  });
  const goLimits = options.goLimits ?? createGoLimitsSource(paths.configFile, env, undefined, {
    initial: cached.go,
    onUpdate: (value) => persist("go", value),
    readPersisted: persisted("go"),
  });
  const claudeLimits = options.claudeLimits ?? createClaudeLimitsSource(undefined, {
    initial: cached.claude,
    onUpdate: (value) => persist("claude", value),
    readPersisted: persisted("claude"),
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
  // Shares the limits source's cookie and workspace: history is dormant
  // without the one, and need not rediscover the other.
  const goHistory =
    options.goHistory ??
    createGoHistorySource(() => readCookie(paths.configFile, env), {
      initial: readGoHistoryCache(paths.goHistoryCache),
      onUpdate: (value) => writeGoHistoryCache(paths.goHistoryCache, value),
      readPersisted: readPersistedHistory,
      knownWorkspaceId: () => goLimits.workspaceId?.(),
    });
  const trend = createWeeklyTrend();
  const meta = buildMeta();
  let built = buildSnapshot(paths, meta, claudeLimits, codexLimits, goLimits, goHistory, trend, claudeAuth);

  return {
    scopeTitles: { session: "current session", weekly: "weekly limit" },
    listMeta: () => meta,
    initialConnections: () =>
      buildConnections(
        paths,
        readOpencodeAuth(paths.opencodeAuth),
        readUsageSnapshot(paths.usageSnapshot, new Date()),
        hasOpencodeCookie(paths, env),
        claudeLimits,
        codexLimits,
        goLimits,
        claudeAuth,
        built.hasGoLocalLimits,
      ),
    readSnapshot: () => built.snapshot,
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
      const settle = (poll: Promise<void> | null) => poll?.catch(() => undefined);
      const limits = Promise.all(
        [
          providerIds.has("cl") ? claudeLimits.poll(at, pollOptions) : null,
          providerIds.has("cl") ? claudeAuth.poll(at, pollOptions) : null,
          providerIds.has("go") ? goLimits.poll(at, pollOptions) : null,
          providerIds.has("cx") ? codexLimits.poll(at, pollOptions) : null,
        ].map(settle),
      );
      // The month history is a walk of thirty-odd requests, and nothing on the
      // overview waits on it. It runs alongside the limits, and if it is still
      // out when they land the snapshot goes up without it and again with it.
      let isHistorySettled = false;
      const history = Promise.resolve(
        settle(providerIds.has("go") ? goHistory.poll(at, pollOptions) : null),
      ).finally(() => {
        isHistorySettled = true;
      });
      const rebuild = () => {
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Refresh aborted", "AbortError");
        }
        built = buildSnapshot(paths, meta, claudeLimits, codexLimits, goLimits, goHistory, trend, claudeAuth);
        return built.snapshot;
      };
      await limits;
      // A history that had nothing to do settled in a microtask; a real walk
      // is still out. One turn of the event loop tells the two apart, so a
      // refresh with nothing slow in flight never pays for a second build.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!isHistorySettled && request.onSnapshot) request.onSnapshot(rebuild());
      await history;
      return rebuild();
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
