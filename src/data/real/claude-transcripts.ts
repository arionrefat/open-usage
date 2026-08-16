import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { addToBucket, mergeBuckets, type HourBuckets } from "./aggregate";
import { isRecord } from "./json";

export interface TranscriptEvent {
  epochMs: number;
  tokens: number;
  /** Assistant message id; the same message is logged more than once. */
  id: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TranscriptTokenSplit {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TranscriptAggregate {
  buckets: HourBuckets;
  latestMs: number;
  modelTokens: Map<string, number>;
  tokenSplit: TranscriptTokenSplit;
}

const ASSISTANT_MARKER = '"type":"assistant"';

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Fresh tokens (input + output + cache writes); cache reads are excluded. */
export function parseTranscriptLine(line: string): TranscriptEvent | null {
  if (!line.includes(ASSISTANT_MARKER)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "assistant") return null;
  if (typeof parsed.timestamp !== "string") return null;
  const epochMs = Date.parse(parsed.timestamp);
  if (!Number.isFinite(epochMs)) return null;

  const message = parsed.message;
  if (!isRecord(message)) return null;
  const usage = message.usage;
  if (!isRecord(usage)) return null;

  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const cacheReadTokens = tokenCount(usage.cache_read_input_tokens);
  const cacheWriteTokens = tokenCount(usage.cache_creation_input_tokens);
  /**
   * Cache reads are deliberately excluded, which keeps this comparable to Codex:
   * its `TokenUsage::blended_total` - the "primary count for display as a single
   * absolute value" - is `non_cached_input + output`, the same shape. Anthropic
   * also bills cache reads at 10% of input and excludes them from ITPM entirely,
   * so counting them whole would overstate this figure against both.
   * `tokenSplit` below still reports all four kinds for the detail screen.
   */
  const tokens = inputTokens + outputTokens + cacheWriteTokens;
  // An event carrying only cache reads has no blended tokens, but its reads are
  // still measured volume behind `cacheRead30d`. Dropping it here would undercount
  // that figure silently. Callers below hold `tokens === 0` out of the headline.
  if (tokens <= 0 && cacheReadTokens <= 0) return null;
  const id = typeof message.id === "string" ? message.id : null;
  const model = typeof message.model === "string" ? message.model : null;
  return { epochMs, tokens, id, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

export interface PerFileEvents {
  events: TranscriptEvent[];
  buckets: HourBuckets;
  latestMs: number;
}

/** Deduplicates by message id (Claude re-logs as it streams) and stores per-file events so the 30d cutoff is applied at merge time rather than frozen into cached aggregates. */
export function aggregateTranscriptLines(
  lines: Iterable<string>,
): PerFileEvents {
  const events: TranscriptEvent[] = [];
  const buckets: HourBuckets = new Map();
  const seen = new Set<string>();
  let latestMs = 0;
  for (const line of lines) {
    const event = parseTranscriptLine(line);
    if (!event) continue;
    if (event.id !== null) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
    }
    // Cache-only events carry no blended tokens, so they stay out of the activity
    // histogram and the burn rate; `tokenSplit` still banks their reads.
    if (event.tokens > 0) addToBucket(buckets, event.epochMs, event.tokens);
    events.push(event);
    latestMs = Math.max(latestMs, event.epochMs);
  }
  return { events, buckets, latestMs };
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface FileCacheEntry extends PerFileEvents {
  size: number;
  mtimeMs: number;
}

// Per-file aggregates keyed by path; a size/mtime match skips the re-parse
// so a 60s poll over tens of MB of transcripts stays effectively free.
const fileCache = new Map<string, FileCacheEntry>();

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function clearProjectCache(projectsDir: string): void {
  const prefix = `${projectsDir}/`;
  for (const path of fileCache.keys()) if (path.startsWith(prefix)) fileCache.delete(path);
}

/** Sums assistant token usage across every transcript under `projectsDir`.
 *  The 30-day cutoff is applied at merge time so cached per-file events do not
 *  permanently retain data that has aged past the stats window. */
export function readClaudeTranscripts(
  projectsDir: string,
  now: Date = new Date(),
): TranscriptAggregate {
  const combined: HourBuckets = new Map();
  const modelTokens = new Map<string, number>();
  const tokenSplit: TranscriptTokenSplit = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cutoffMs = now.getTime() - THIRTY_DAYS_MS;
  let latestMs = 0;
  try {
    statSync(projectsDir);
  } catch (error) {
    clearProjectCache(projectsDir);
    if (isMissing(error)) return { buckets: combined, latestMs, modelTokens, tokenSplit };
    throw error;
  }

  let entries: string[];
  try {
    entries = readdirSync(projectsDir, { recursive: true, encoding: "utf8" });
  } catch (error) {
    clearProjectCache(projectsDir);
    if (isMissing(error)) return { buckets: combined, latestMs, modelTokens, tokenSplit };
    throw error;
  }

  const seen = new Set<string>();
  let unreadable: unknown;
  for (const relative of entries) {
    if (!relative.endsWith(".jsonl")) continue;
    const path = join(projectsDir, relative);
    seen.add(path);
    try {
      const stats = statSync(path);
      const cached = fileCache.get(path);
      const cacheMatchesFile =
        cached !== undefined && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs;
      const entry: FileCacheEntry =
        cacheMatchesFile && cached
          ? cached
          : {
              size: stats.size,
              mtimeMs: stats.mtimeMs,
              ...aggregateTranscriptLines(readFileSync(path, "utf8").split("\n")),
            };
      if (!cacheMatchesFile) fileCache.set(path, entry);
      mergeBuckets(combined, entry.buckets);
      for (const event of entry.events) {
        if (event.epochMs < cutoffMs) continue;
        // Same blended figure as `event.tokens`, so the per-model bars sum to the
        // headline total instead of contradicting it by the cache-read volume.
        if (event.model !== null && event.tokens > 0) {
          modelTokens.set(event.model, (modelTokens.get(event.model) ?? 0) + event.tokens);
        }
        tokenSplit.input += event.inputTokens;
        tokenSplit.output += event.outputTokens;
        tokenSplit.cacheRead += event.cacheReadTokens;
        tokenSplit.cacheWrite += event.cacheWriteTokens;
      }
      latestMs = Math.max(latestMs, entry.latestMs);
    } catch (error) {
      fileCache.delete(path);
      // The cleanup job prunes transcripts between readdir and stat; skip the gap.
      if (!isMissing(error)) unreadable ??= error;
    }
  }
  for (const path of fileCache.keys()) if (!seen.has(path)) fileCache.delete(path);
  if (unreadable) throw unreadable;
  return { buckets: combined, latestMs, modelTokens, tokenSplit };
}
