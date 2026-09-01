import { formatAge } from "../data/real/aggregate";
import {
  clearDaemonState,
  readDaemonState,
  writeDaemonState,
  type DaemonState,
} from "./state";

export interface DaemonCommandResult {
  exitCode: number;
  message: string;
}

/**
 * Everything the commands do to the world outside their own state file. Tests
 * supply fakes for all of it, which is why none of the lifecycle logic below
 * spawns, signals, or sleeps directly.
 */
export interface DaemonHost {
  statePath: string;
  logPath: string;
  now(): Date;
  /** When the machine last booted, which bounds how old a live pid can be. */
  bootedAtMs(): number;
  /** True while a pid names a live process we are allowed to signal. */
  isAlive(pid: number): boolean;
  /** Asks a pid to shut down; a missing process is not an error. */
  terminate(pid: number): void;
  /** Launches a detached `daemon run` and answers with its pid. */
  spawn(intervalMinutes: number): number;
  sleep(ms: number): Promise<void>;
  /** False when there is no local agent to read, which makes a daemon pointless. */
  hasRealSources(): boolean;
}

const STARTUP_TIMEOUT_MS = 3_000;
const STOP_TIMEOUT_MS = 5_000;
const WAIT_STEP_MS = 100;
/**
 * Slack for a boot time we can only infer from uptime, which some platforms
 * round to whole seconds. A daemon in someone's login items starts within
 * moments of the boot it belongs to, so the margin costs us nothing.
 */
const BOOT_TOLERANCE_MS = 60_000;
/**
 * How far behind a heartbeat may fall before the record is debris. A live daemon
 * rewrites `lastPollAtMs` every interval - a failed poll writes it too - so a
 * record that has not moved in several intervals is one nobody is keeping, and
 * whoever holds its pid now inherited the number rather than earned it. The
 * floor keeps a one-minute cadence from making the window so tight that a single
 * slow poll reads as death.
 */
const STALE_HEARTBEAT_INTERVALS = 4;
const STALE_HEARTBEAT_FLOOR_MS = 15 * 60_000;

function ageText(nowMs: number, atMs: number | null): string {
  if (atMs === null) return "never";
  // A record stamped in the future is a clock change, not a poll from tomorrow.
  if (nowMs < atMs) return "just now";
  const age = formatAge(nowMs - atMs);
  return age === "just now" ? age : `${age} ago`;
}

export function describeDaemonState(state: DaemonState, nowMs: number): string {
  const lines = [
    `running · pid ${state.pid} · every ${state.intervalMinutes}m · last poll ${ageText(nowMs, state.lastPollAtMs)}`,
  ];
  if (state.lastError) {
    lines.push(`last error: ${state.lastError} (last success ${ageText(nowMs, state.lastSuccessAtMs)})`);
  }
  lines.push(`log: ${state.logPath}`);
  return lines.join("\n");
}

/**
 * A pid is not an identity. Pids are recycled, so a record left behind by a
 * crash can come to name something else entirely - and `stop` would then signal
 * a stranger. Two things catch that. Nothing survives a reboot, so a record
 * claiming to predate the last one is debris however alive its pid looks; and a
 * daemon that were really running would still be writing to its record, so a
 * heartbeat that stopped moving means the pid outlived the daemon that had it.
 */
function isLiveDaemon(host: DaemonHost, state: DaemonState): boolean {
  if (state.startedAtMs < host.bootedAtMs() - BOOT_TOLERANCE_MS) return false;
  // Before the first poll lands there is no heartbeat yet, only a start time.
  const beatAtMs = state.lastPollAtMs ?? state.startedAtMs;
  const allowedSilenceMs = Math.max(
    state.intervalMinutes * 60_000 * STALE_HEARTBEAT_INTERVALS,
    STALE_HEARTBEAT_FLOOR_MS,
  );
  if (host.now().getTime() - beatAtMs > allowedSilenceMs) return false;
  return host.isAlive(state.pid);
}

/** The record only counts while it names a live daemon; anything else is debris. */
function readLiveState(host: DaemonHost): DaemonState | null {
  const state = readDaemonState(host.statePath);
  if (!state) return null;
  if (isLiveDaemon(host, state)) return state;
  clearDaemonState(host.statePath, state.pid);
  return null;
}

async function waitUntil(
  host: DaemonHost,
  isDone: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = host.now().getTime() + timeoutMs;
  while (!isDone()) {
    if (host.now().getTime() >= deadline) return false;
    await host.sleep(WAIT_STEP_MS);
  }
  return true;
}

export async function startDaemon(
  host: DaemonHost,
  intervalMinutes: number,
): Promise<DaemonCommandResult> {
  const running = readLiveState(host);
  if (running) {
    return {
      exitCode: 0,
      message: `daemon already running · pid ${running.pid} · every ${running.intervalMinutes}m\nrun \`open-usage daemon stop\` first to change the interval`,
    };
  }
  if (!host.hasRealSources()) {
    return {
      exitCode: 1,
      message: "no local agents found, so there is nothing to poll in the background.\nrun `open-usage` once and finish setup first.",
    };
  }

  const pid = host.spawn(intervalMinutes);
  // The child publishes its own record, so waiting for it is what tells us the
  // daemon actually came up rather than dying on its first import.
  const isUp = await waitUntil(
    host,
    () => readDaemonState(host.statePath)?.pid === pid,
    STARTUP_TIMEOUT_MS,
  );
  if (isUp) {
    return {
      exitCode: 0,
      message: `daemon started · pid ${pid} · every ${intervalMinutes}m\nlog: ${host.logPath}`,
    };
  }
  if (!host.isAlive(pid)) {
    return {
      exitCode: 1,
      message: `daemon exited immediately · see ${host.logPath}`,
    };
  }
  return {
    exitCode: 0,
    message: `daemon starting · pid ${pid} · every ${intervalMinutes}m\nnot confirmed yet; check \`open-usage daemon status\`\nlog: ${host.logPath}`,
  };
}

export async function stopDaemon(host: DaemonHost): Promise<DaemonCommandResult> {
  const state = readDaemonState(host.statePath);
  if (!state) return { exitCode: 0, message: "daemon not running" };
  if (!isLiveDaemon(host, state)) {
    clearDaemonState(host.statePath, state.pid);
    return { exitCode: 0, message: `daemon not running · removed a stale record for pid ${state.pid}` };
  }

  host.terminate(state.pid);
  const hasStopped = await waitUntil(host, () => !host.isAlive(state.pid), STOP_TIMEOUT_MS);
  if (!hasStopped) {
    return {
      exitCode: 1,
      message: `daemon pid ${state.pid} did not stop within ${STOP_TIMEOUT_MS / 1000}s`,
    };
  }
  // The daemon clears its own record on a clean exit; this covers the rest.
  clearDaemonState(host.statePath, state.pid);
  return { exitCode: 0, message: `daemon stopped · pid ${state.pid}` };
}

export function statusDaemon(host: DaemonHost): DaemonCommandResult {
  const state = readDaemonState(host.statePath);
  if (!state) return { exitCode: 0, message: "daemon not running" };
  if (!isLiveDaemon(host, state)) {
    clearDaemonState(host.statePath, state.pid);
    return {
      exitCode: 0,
      message: `daemon not running · removed a stale record for pid ${state.pid}`,
    };
  }
  return { exitCode: 0, message: describeDaemonState(state, host.now().getTime()) };
}

export async function restartDaemon(
  host: DaemonHost,
  intervalMinutes: number,
): Promise<DaemonCommandResult> {
  const stopped = await stopDaemon(host);
  if (stopped.exitCode !== 0) return stopped;
  const started = await startDaemon(host, intervalMinutes);
  return { ...started, message: `${stopped.message}\n${started.message}` };
}

/** Publishes the record a daemon run owns for as long as it lives. */
export function claimDaemonState(
  statePath: string,
  state: Omit<DaemonState, "lastPollAtMs" | "lastSuccessAtMs" | "lastError">,
): void {
  writeDaemonState(statePath, {
    ...state,
    lastPollAtMs: null,
    lastSuccessAtMs: null,
    lastError: null,
  });
}
