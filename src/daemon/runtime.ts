import { PROVIDER_IDS, type UsageProvider } from "../data/types";
import { readDaemonState, updateDaemonState } from "./state";

export interface DaemonRuntimeOptions {
  provider: UsageProvider;
  statePath: string;
  intervalMs: number;
  /** Aborted by the signal handlers; ends the run between or during a poll. */
  signal: AbortSignal;
  /** The pid the state record must name for this run to keep going. */
  ownerPid: number;
  now?: () => Date;
  log?: (line: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Resolves early when aborted, so a stop does not wait out the interval. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "poll failed";
}

/** "2026-08-31T19:04:51.404Z poll ok" - one line per event, parseable by eye or by grep. */
function defaultLog(line: string): void {
  process.stdout.write(`${line}\n`);
}

function timestamp(at: Date): string {
  return at.toISOString();
}

/**
 * The daemon's whole job: refresh every provider on a fixed cadence so the
 * persisted usage cache is already current when someone opens the dashboard.
 * Failures are recorded and slept through - a laptop that spends the night
 * offline should find a working daemon in the morning, not a dead one.
 */
export async function runDaemonLoop(options: DaemonRuntimeOptions): Promise<void> {
  const { provider, statePath, intervalMs, signal, ownerPid } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? defaultLog;
  const sleep = options.sleep ?? abortableSleep;

  while (!signal.aborted) {
    const at = now();
    try {
      await provider.refresh({ reason: "interval", providerIds: PROVIDER_IDS, signal });
      if (signal.aborted) break;
      const atMs = at.getTime();
      updateDaemonState(statePath, {
        lastPollAtMs: atMs,
        lastSuccessAtMs: atMs,
        lastError: null,
      });
      log(`${timestamp(at)} poll ok`);
    } catch (error) {
      if (signal.aborted) break;
      const message = describeFailure(error);
      updateDaemonState(statePath, { lastPollAtMs: at.getTime(), lastError: message });
      log(`${timestamp(at)} poll failed: ${message}`);
    }

    // A record naming someone else means a second daemon took over. Standing
    // down is the only way both do not poll the same account twice a minute.
    const owner = readDaemonState(statePath)?.pid;
    if (owner !== undefined && owner !== ownerPid) {
      log(`${timestamp(now())} standing down: pid ${owner} owns the daemon record`);
      return;
    }

    await sleep(intervalMs, signal);
  }
}
