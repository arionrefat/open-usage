import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "../../lib/file-lock";
import { isRecord } from "./json";
import type { Money } from "../types";
import { addTokenUsage, emptyTokenUsage, maxTokenUsage, type TokenUsage } from "./pricing";
import { dayStartMs } from "./claude-transcripts";

/**
 * Claude reports a balance, never a statement: `used_credits` is cumulative
 * within a billing cycle and resets at the boundary, and transcripts are pruned
 * at `cleanupPeriodDays` (default 30). Neither answers "what did last month
 * cost". This store is what does - it records what it sees, from install day.
 *
 * Two different mechanics, deliberately:
 *
 * Spend is an odometer. Readings are sampled and the running maximum is kept;
 * they are NEVER summed. Summing samples of a cumulative counter multiplies the
 * real figure by the number of polls, which at a 60s interval is a ~1000x
 * overstatement per day. A reading below the stored maximum means the cycle
 * rolled over, so the maximum is banked as that cycle's final total.
 *
 * Tokens are events. They carry real timestamps, so they are keyed by local day
 * and replaced wholesale for days fully covered by the transcript window. Day
 * granularity is what lets an arbitrary billing cycle be summed exactly.
 */

const CURRENT_VERSION = 1;
/** Bounds file growth; five years of billing cycles is far past any useful range. */
const MAX_COMPLETED_CYCLES = 60;

export interface SpendCycle {
  startedMs: number;
  endedMs: number;
  totalMinor: number;
  currency: string;
  exponent: number;
}

export interface OpenSpendCycle {
  startedMs: number;
  lastReadingMs: number;
  maxMinor: number;
  currency: string;
  exponent: number;
}

export interface DayTokens {
  /** Per canonical model id. */
  models: Record<string, TokenUsage>;
}

export interface SpendStore {
  openCycle: OpenSpendCycle | null;
  completedCycles: SpendCycle[];
  /** Keyed by `YYYY-MM-DD` in local time, matching `localDateKey`. */
  days: Record<string, DayTokens>;
}

export function emptySpendStore(): SpendStore {
  return { openCycle: null, completedCycles: [], days: {} };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const input = finite(value.input);
  const output = finite(value.output);
  const cacheRead = finite(value.cacheRead);
  const cacheWrite5m = finite(value.cacheWrite5m);
  const cacheWrite1h = finite(value.cacheWrite1h);
  if (
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite5m === null ||
    cacheWrite1h === null
  ) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite5m, cacheWrite1h };
}

function parseOpenCycle(value: unknown): OpenSpendCycle | null {
  if (!isRecord(value)) return null;
  const startedMs = finite(value.startedMs);
  const lastReadingMs = finite(value.lastReadingMs);
  const maxMinor = finite(value.maxMinor);
  const exponent = finite(value.exponent);
  if (startedMs === null || lastReadingMs === null || maxMinor === null || exponent === null) {
    return null;
  }
  if (typeof value.currency !== "string") return null;
  return { startedMs, lastReadingMs, maxMinor, currency: value.currency, exponent };
}

function parseCompletedCycle(value: unknown): SpendCycle | null {
  if (!isRecord(value)) return null;
  const startedMs = finite(value.startedMs);
  const endedMs = finite(value.endedMs);
  const totalMinor = finite(value.totalMinor);
  const exponent = finite(value.exponent);
  if (startedMs === null || endedMs === null || totalMinor === null || exponent === null) {
    return null;
  }
  if (typeof value.currency !== "string") return null;
  return { startedMs, endedMs, totalMinor, currency: value.currency, exponent };
}

export function parseSpendStore(value: unknown): SpendStore {
  if (!isRecord(value) || value.version !== CURRENT_VERSION) return emptySpendStore();

  const completedCycles: SpendCycle[] = [];
  if (Array.isArray(value.completedCycles)) {
    for (const entry of value.completedCycles) {
      const cycle = parseCompletedCycle(entry);
      if (cycle) completedCycles.push(cycle);
    }
  }

  const days: Record<string, DayTokens> = {};
  // `months` is what 0.6.0 and earlier wrote under, before the store moved to
  // day granularity in name as well as in fact. Read it so banked days survive.
  const rawDays = isRecord(value.days) ? value.days : value.months;
  if (isRecord(rawDays)) {
    for (const [day, raw] of Object.entries(rawDays)) {
      if (!isRecord(raw) || !isRecord(raw.models)) continue;
      const models: Record<string, TokenUsage> = {};
      for (const [model, usage] of Object.entries(raw.models)) {
        const parsed = parseTokenUsage(usage);
        if (parsed) models[model] = parsed;
      }
      days[day] = { models };
    }
  }

  return { openCycle: parseOpenCycle(value.openCycle), completedCycles, days };
}

/**
 * Folds one odometer reading into the store. Pure, so the rollover rule is
 * directly testable without touching a filesystem.
 *
 * A reading at or above the open cycle's maximum raises it. A reading below it
 * closes the cycle at that maximum and opens a new one - the only way a
 * cumulative counter goes down is a reset. A currency change is also a new
 * cycle, since the totals are no longer comparable.
 */
export function recordSpendReading(
  store: SpendStore,
  reading: Money,
  nowMs: number,
): SpendStore {
  const open = store.openCycle;

  if (!open || open.currency !== reading.currency || open.exponent !== reading.exponent) {
    const completed = open
      ? [
          ...store.completedCycles,
          {
            startedMs: open.startedMs,
            endedMs: open.lastReadingMs,
            totalMinor: open.maxMinor,
            currency: open.currency,
            exponent: open.exponent,
          },
        ]
      : store.completedCycles;
    return {
      ...store,
      completedCycles: completed.slice(-MAX_COMPLETED_CYCLES),
      openCycle: {
        startedMs: nowMs,
        lastReadingMs: nowMs,
        maxMinor: reading.amountMinor,
        currency: reading.currency,
        exponent: reading.exponent,
      },
    };
  }

  if (reading.amountMinor >= open.maxMinor) {
    return {
      ...store,
      openCycle: { ...open, maxMinor: reading.amountMinor, lastReadingMs: nowMs },
    };
  }

  // Dropped below the running maximum: the cycle reset. Bank the old peak.
  return {
    ...store,
    completedCycles: [
      ...store.completedCycles,
      {
        startedMs: open.startedMs,
        endedMs: open.lastReadingMs,
        totalMinor: open.maxMinor,
        currency: open.currency,
        exponent: open.exponent,
      },
    ].slice(-MAX_COMPLETED_CYCLES),
    openCycle: {
      startedMs: nowMs,
      lastReadingMs: nowMs,
      maxMinor: reading.amountMinor,
      currency: reading.currency,
      exponent: reading.exponent,
    },
  };
}

/**
 * Folds a fresh transcript measurement into the store.
 *
 * Replacement rather than accumulation: transcripts are re-read in full on
 * every poll, so adding would double-count. Days absent from `measured` are
 * kept untouched, which is what preserves history past Claude's 30-day pruning.
 *
 * `earliestMs` guards the boundary. The oldest day on disk is only partly
 * covered - Claude pruned the rest - so replacing it with the smaller
 * re-measurement would erase real usage we had already banked. Partly covered
 * days take the element-wise maximum instead; fully covered days replace.
 */
export function recordDayTokens(
  store: SpendStore,
  measured: Record<string, Record<string, TokenUsage>>,
  earliestMs: number | null,
): SpendStore {
  const days = { ...store.days };
  for (const [day, models] of Object.entries(measured)) {
    const isFullyCovered = earliestMs !== null && dayStartMs(day) >= earliestMs;
    const previous = days[day]?.models;
    if (isFullyCovered || !previous) {
      days[day] = { models: { ...models } };
      continue;
    }
    const merged: Record<string, TokenUsage> = { ...previous };
    for (const [model, usage] of Object.entries(models)) {
      const banked = merged[model];
      merged[model] = banked ? maxTokenUsage(banked, usage) : usage;
    }
    days[day] = { models: merged };
  }
  return { ...store, days };
}

/** Sums every recorded day whose start falls in `[fromMs, toMs)`, per model key. */
export function sumWindow(
  store: SpendStore,
  fromMs: number,
  toMs: number,
): Record<string, TokenUsage> {
  const totals: Record<string, TokenUsage> = {};
  for (const [day, entry] of Object.entries(store.days)) {
    const startMs = dayStartMs(day);
    if (!Number.isFinite(startMs) || startMs < fromMs || startMs >= toMs) continue;
    for (const [model, usage] of Object.entries(entry.models)) {
      const target = (totals[model] ??= emptyTokenUsage());
      addTokenUsage(target, usage);
    }
  }
  return totals;
}

/** Earliest day the store holds any tokens for, or null when it holds none. */
export function recordsBeganMs(store: SpendStore): number | null {
  let earliest: number | null = null;
  for (const day of Object.keys(store.days)) {
    const startMs = dayStartMs(day);
    if (!Number.isFinite(startMs)) continue;
    if (earliest === null || startMs < earliest) earliest = startMs;
  }
  return earliest;
}

function readSpendStore(path: string): SpendStore {
  try {
    return parseSpendStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptySpendStore();
  }
}

function serializable(store: SpendStore): Record<string, unknown> {
  return {
    version: CURRENT_VERSION,
    openCycle: store.openCycle,
    completedCycles: store.completedCycles,
    days: store.days,
  };
}

function writeStoreFile(path: string, store: SpendStore): void {
  let temporary: string | null = null;
  try {
    temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(serializable(store))}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    if (temporary) rmSync(temporary, { force: true });
  }
}

/**
 * Read-modify-write under the shared lock so two running instances cannot
 * interleave and lose an odometer peak.
 */
export function updateSpendStore(
  path: string,
  update: (store: SpendStore) => SpendStore,
): SpendStore {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return withFileLock(path, () => {
      const next = update(readSpendStore(path));
      writeStoreFile(path, next);
      return next;
    });
  } catch {
    // History is an enhancement; a read-only home must not break usage polling.
    // The caller still gets this run's figures, they just are not persisted.
    try {
      return update(readSpendStore(path));
    } catch {
      return emptySpendStore();
    }
  }
}

/** Total for the cycle in progress, or null before any reading has been recorded. */
export function openCycleTotal(store: SpendStore): Money | null {
  const open = store.openCycle;
  if (!open) return null;
  return { amountMinor: open.maxMinor, currency: open.currency, exponent: open.exponent };
}
