import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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
  const tokens = inputTokens + outputTokens + cacheWriteTokens;
  if (tokens <= 0) return null;
  const id = typeof message.id === "string" ? message.id : null;
  const model = typeof message.model === "string" ? message.model : null;
  return { epochMs, tokens, id, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/**
 * Claude Code re-logs an assistant message as it streams, so a transcript holds
 * several identical usage blocks per message. Counting every line inflates the
 * totals by roughly 3x, so each message id is banked once.
 */
export function aggregateTranscriptLines(
  lines: Iterable<string>,
  now: Date = new Date(),
): TranscriptAggregate {
  const buckets: HourBuckets = new Map();
  const modelTokens = new Map<string, number>();
  const tokenSplit: TranscriptTokenSplit = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const seen = new Set<string>();
  let latestMs = 0;
  for (const line of lines) {
    const event = parseTranscriptLine(line);
    if (!event) continue;
    if (event.id !== null) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
    }
    addToBucket(buckets, event.epochMs, event.tokens);
    if (event.epochMs >= now.getTime() - THIRTY_DAYS_MS) {
      if (event.model !== null) {
        const allTokens = event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;
        modelTokens.set(event.model, (modelTokens.get(event.model) ?? 0) + allTokens);
      }
      tokenSplit.input += event.inputTokens;
      tokenSplit.output += event.outputTokens;
      tokenSplit.cacheRead += event.cacheReadTokens;
      tokenSplit.cacheWrite += event.cacheWriteTokens;
    }
    latestMs = Math.max(latestMs, event.epochMs);
  }
  return { buckets, latestMs, modelTokens, tokenSplit };
}

interface FileCacheEntry {
  size: number;
  mtimeMs: number;
  aggregate: TranscriptAggregate;
}

// Per-file aggregates keyed by path; a size/mtime match skips the re-parse
// so a 60s poll over tens of MB of transcripts stays effectively free.
const fileCache = new Map<string, FileCacheEntry>();

/** Sums assistant token usage across every transcript under `projectsDir`. */
export function readClaudeTranscripts(projectsDir: string): TranscriptAggregate {
  const combined: HourBuckets = new Map();
  const modelTokens = new Map<string, number>();
  const tokenSplit: TranscriptTokenSplit = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let latestMs = 0;
  if (!existsSync(projectsDir)) return { buckets: combined, latestMs, modelTokens, tokenSplit };

  let entries: string[];
  try {
    entries = readdirSync(projectsDir, { recursive: true, encoding: "utf8" });
  } catch {
    return { buckets: combined, latestMs, modelTokens, tokenSplit };
  }

  const seen = new Set<string>();
  for (const relative of entries) {
    if (!relative.endsWith(".jsonl")) continue;
    const path = join(projectsDir, relative);
    seen.add(path);
    try {
      const stats = statSync(path);
      const cached = fileCache.get(path);
      const cacheMatchesFile =
        cached !== undefined && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs;
      let entry = cacheMatchesFile ? cached : null;
      if (!entry) {
        entry = {
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          aggregate: aggregateTranscriptLines(readFileSync(path, "utf8").split("\n")),
        };
        fileCache.set(path, entry);
      }
      mergeBuckets(combined, entry.aggregate.buckets);
      for (const [model, tokens] of entry.aggregate.modelTokens) {
        modelTokens.set(model, (modelTokens.get(model) ?? 0) + tokens);
      }
      tokenSplit.input += entry.aggregate.tokenSplit.input;
      tokenSplit.output += entry.aggregate.tokenSplit.output;
      tokenSplit.cacheRead += entry.aggregate.tokenSplit.cacheRead;
      tokenSplit.cacheWrite += entry.aggregate.tokenSplit.cacheWrite;
      latestMs = Math.max(latestMs, entry.aggregate.latestMs);
    } catch {
      // The cleanup job prunes transcripts between readdir and stat; skip the gap.
    }
  }
  for (const path of fileCache.keys()) if (!seen.has(path)) fileCache.delete(path);
  return { buckets: combined, latestMs, modelTokens, tokenSplit };
}
