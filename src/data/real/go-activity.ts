import { addToBucket, localDateKey, type HourBuckets } from "./aggregate";
import type { OpencodeSessionStats } from "./opencode-db";
import type { GoUsageRow } from "./opencode-usage";

/**
 * Turns the console's request log into the same activity shape `opencode.db`
 * produces, so one rendering path serves both sources.
 *
 * The console covers the whole workspace rather than this device, which is
 * the reason the provider labels its scope. It may fill `series` at all only
 * because it reports every token kind separately, so the blended basis can be
 * computed exactly rather than approximated - a source that cannot do that
 * belongs in a labelled figure, not on a shared axis.
 */
export interface GoActivity {
  buckets: HourBuckets;
  stats: OpencodeSessionStats;
  rejected30d: number;
}

/** Fresh tokens only, matching the local db's `TOKENS_SQL`; cache reads are out. */
export function blendedTokens(row: GoUsageRow): number {
  return row.inputTokens + row.outputTokens + row.reasoningTokens + row.cacheWriteTokens;
}

export function goActivityFromRows(rows: GoUsageRow[]): GoActivity {
  const buckets: HourBuckets = new Map();
  const sessions = new Set<string>();
  const modelTokens: Record<string, number> = {};
  const modelRows = new Map<string, number>();
  const dayCosts = new Map<string, number>();
  const split = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let tokens = 0;
  let latestMs = 0;
  let totalUsd = 0;
  let rejected = 0;

  for (const row of rows) {
    if (row.sessionId !== null) sessions.add(row.sessionId);
    // Refused before inference ran, so it must not count toward the top model.
    if (row.isRejected) {
      rejected += 1;
      continue;
    }
    const blended = blendedTokens(row);
    addToBucket(buckets, row.atMs, blended);
    latestMs = Math.max(latestMs, row.atMs);
    const day = localDateKey(new Date(row.atMs));
    dayCosts.set(day, (dayCosts.get(day) ?? 0) + row.usd);
    tokens += blended;
    totalUsd += row.usd;
    if (blended > 0) modelTokens[row.model] = (modelTokens[row.model] ?? 0) + blended;
    modelRows.set(row.model, (modelRows.get(row.model) ?? 0) + 1);
    split.input += row.inputTokens;
    split.output += row.outputTokens;
    split.reasoning += row.reasoningTokens;
    split.cacheRead += row.cacheReadTokens;
    split.cacheWrite += row.cacheWriteTokens;
  }

  let topModel: string | null = null;
  let topCount = 0;
  for (const [model, count] of modelRows) {
    if (count > topCount) {
      topModel = model;
      topCount = count;
    }
  }

  const stats: OpencodeSessionStats = {
    sessions: sessions.size,
    tokens,
    latestMs,
    topModel,
    ...(Object.keys(modelTokens).length > 0 ? { modelTokens30d: modelTokens } : {}),
    tokenSplit30d: split,
    // Only rows that carry money produce a cost line; an all-zero total on a
    // plan that never charges is a real reading, not a missing one.
    cost30d: { totalUsd, peakDayUsd: Math.max(0, ...dayCosts.values()) },
  };
  return { buckets, stats, rejected30d: rejected };
}
