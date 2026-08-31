import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { configPath, isDaemonIntervalMinutes } from "../config";
import { isRecord } from "../data/real/json";
import { withFileLock } from "../lib/file-lock";

/**
 * What a running daemon publishes about itself. `status` and `stop` read this
 * instead of scanning the process table, so the record has to survive a crash
 * without ever being mistaken for a live process: `pid` is checked for liveness
 * before any of the rest is believed.
 */
export interface DaemonState {
  pid: number;
  startedAtMs: number;
  intervalMinutes: number;
  /** When the last poll was attempted, null before the first one completes. */
  lastPollAtMs: number | null;
  /** When a poll last succeeded, so a run of failures stays visible. */
  lastSuccessAtMs: number | null;
  /** The last failure, cleared by the next success. */
  lastError: string | null;
  logPath: string;
}

export type DaemonStatePatch = Partial<Omit<DaemonState, "pid" | "startedAtMs">>;

export function defaultDaemonStatePath(): string {
  return configPath("daemon.json");
}

export function defaultDaemonLogPath(): string {
  return configPath("daemon.log");
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function nullableInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = finiteInteger(value);
  return parsed === null ? undefined : parsed;
}

/** null for a missing, malformed, or foreign-version record: all mean "no daemon". */
export function readDaemonState(path: string): DaemonState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    const pid = finiteInteger(parsed.pid);
    const startedAtMs = finiteInteger(parsed.startedAtMs);
    const lastPollAtMs = nullableInteger(parsed.lastPollAtMs);
    const lastSuccessAtMs = nullableInteger(parsed.lastSuccessAtMs);
    if (pid === null || pid <= 0 || startedAtMs === null) return null;
    if (!isDaemonIntervalMinutes(parsed.intervalMinutes)) return null;
    if (lastPollAtMs === undefined || lastSuccessAtMs === undefined) return null;
    if (parsed.lastError !== null && typeof parsed.lastError !== "string") return null;
    if (typeof parsed.logPath !== "string") return null;
    return {
      pid,
      startedAtMs,
      intervalMinutes: parsed.intervalMinutes,
      lastPollAtMs,
      lastSuccessAtMs,
      lastError: parsed.lastError,
      logPath: parsed.logPath,
    };
  } catch {
    return null;
  }
}

function writeDaemonStateFile(path: string, state: DaemonState): void {
  let temporary: string | null = null;
  try {
    temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    if (temporary) rmSync(temporary, { force: true });
  }
}

/** Writes through a sibling file so a poll interrupted mid-write leaves the old record intact. */
export function writeDaemonState(path: string, state: DaemonState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  withFileLock(path, () => writeDaemonStateFile(path, state));
}

/**
 * Merges a patch into whatever is on disk. Returns null when the record has
 * gone, which is how a daemon learns its own record was replaced or removed -
 * by `stop`, or by a second daemon that took over.
 */
export function updateDaemonState(path: string, patch: DaemonStatePatch): DaemonState | null {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return withFileLock(path, () => {
      const existing = readDaemonState(path);
      if (!existing) return null;
      const next = { ...existing, ...patch };
      writeDaemonStateFile(path, next);
      return next;
    });
  } catch {
    // Progress reporting is not worth ending a run over.
    return null;
  }
}

/** Removes the record. Only the pid that owns it should call this. */
export function clearDaemonState(path: string, ownerPid?: number): void {
  try {
    withFileLock(path, () => {
      if (ownerPid !== undefined && readDaemonState(path)?.pid !== ownerPid) return;
      rmSync(path, { force: true });
    });
  } catch {
    // A record we cannot remove is reported as stale on the next status read.
  }
}
