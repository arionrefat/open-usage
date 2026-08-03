import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DAY_MS, addToBucket, type HourBuckets } from "./aggregate";
import { isRecord } from "./json";

/** Token usage summed from rollout files under codex sessions and archives. */
export interface CodexLocalUsage {
  buckets: HourBuckets;
  /** Sessions with usage in the trailing 30 days. */
  sessions: number;
  /** Tokens in the trailing 30 days. */
  tokens: number;
  latestMs: number;
  topModel: string | null;
}

interface RolloutEvent {
  epochMs: number;
  tokens: number;
  model: string | null;
}

interface FileCacheEntry {
  size: number;
  mtimeMs: number;
  events: RolloutEvent[];
  latestMs: number;
}

const TOKEN_COUNT_MARKER = '"type":"token_count"';
const TURN_CONTEXT_MARKER = '"type":"turn_context"';
const STATS_WINDOW_MS = 30 * DAY_MS;

const fileCache = new Map<string, FileCacheEntry>();

function parseRolloutLines(lines: Iterable<string>): { events: RolloutEvent[]; latestMs: number } {
  const events: RolloutEvent[] = [];
  let latestMs = 0;
  // turn_context precedes its token events, so the last seen model applies.
  let currentModel: string | null = null;
  for (const line of lines) {
    const isTokenCount = line.includes(TOKEN_COUNT_MARKER);
    if (!isTokenCount && !line.includes(TURN_CONTEXT_MARKER)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.payload)) continue;
    const payload = parsed.payload;

    if (parsed.type === "turn_context") {
      if (typeof payload.model === "string" && payload.model.length > 0) {
        currentModel = payload.model;
      }
      continue;
    }
    if (!isTokenCount || parsed.type !== "event_msg" || payload.type !== "token_count") continue;

    const info = isRecord(payload.info) ? payload.info : null;
    const last = info && isRecord(info.last_token_usage) ? info.last_token_usage : null;
    const tokens = last?.total_tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) continue;
    const epochMs = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
    if (!Number.isFinite(epochMs)) continue;

    events.push({ epochMs, tokens, model: currentModel });
    latestMs = Math.max(latestMs, epochMs);
  }
  return { events, latestMs };
}

function collectRolloutPaths(root: string): string[] {
  const paths: string[] = [];
  for (const dir of [join(root, "sessions"), join(root, "archived_sessions")]) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const relative of entries) {
      if (relative.endsWith(".jsonl")) paths.push(join(dir, relative));
    }
  }
  return paths;
}

/** Sums token deltas across every rollout under the codex home directory. */
export function readCodexSessions(codexHome: string, now: Date = new Date()): CodexLocalUsage | null {
  const paths = collectRolloutPaths(codexHome);
  if (paths.length === 0) return null;

  const buckets: HourBuckets = new Map();
  const modelTokens = new Map<string, number>();
  const cutoffMs = now.getTime() - STATS_WINDOW_MS;
  const seen = new Set<string>();
  let sessions = 0;
  let tokens30d = 0;
  let latestMs = 0;

  for (const path of paths) {
    seen.add(path);
    try {
      const stats = statSync(path);
      const cached = fileCache.get(path);
      const cacheMatchesFile =
        cached !== undefined && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs;
      let entry = cacheMatchesFile ? cached : null;
      if (!entry) {
        const parsed = parseRolloutLines(readFileSync(path, "utf8").split("\n"));
        entry = { size: stats.size, mtimeMs: stats.mtimeMs, ...parsed };
        fileCache.set(path, entry);
      }

      let sessionActiveInWindow = false;
      for (const event of entry.events) {
        addToBucket(buckets, event.epochMs, event.tokens);
        if (event.epochMs < cutoffMs) continue;
        tokens30d += event.tokens;
        sessionActiveInWindow = true;
        if (event.model !== null) {
          modelTokens.set(event.model, (modelTokens.get(event.model) ?? 0) + event.tokens);
        }
      }
      if (sessionActiveInWindow) sessions += 1;
      latestMs = Math.max(latestMs, entry.latestMs);
    } catch {
      // A rollout can be rotated between readdir and stat; skip the gap.
    }
  }
  for (const path of fileCache.keys()) if (!seen.has(path)) fileCache.delete(path);

  let topModel: string | null = null;
  let topTokens = 0;
  for (const [model, tokens] of modelTokens) {
    if (tokens > topTokens) {
      topModel = model;
      topTokens = tokens;
    }
  }
  return { buckets, sessions, tokens: tokens30d, latestMs, topModel };
}
