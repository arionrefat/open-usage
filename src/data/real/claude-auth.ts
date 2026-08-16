import { isRecord } from "./json";
import { createSubprocessGuard, subprocessEnvironment } from "./subprocess";
import type { PollOptions } from "../types";

/** Structured read through `claude auth status --json`. subscriptionType replaces hardcoded labels. */
export interface ClaudeAuthInfo {
  loggedIn: boolean;
  subscriptionType: string | null;
  fetchedAtMs: number;
}

function parseAuthStatus(value: unknown, fetchedAtMs: number): ClaudeAuthInfo | null {
  if (!isRecord(value)) return null;
  const loggedIn = value.loggedIn === true;
  const subType = typeof value.subscriptionType === "string" ? value.subscriptionType : null;
  return { loggedIn, subscriptionType: subType, fetchedAtMs };
}

const REQUEST_TIMEOUT_MS = 5_000;

function spawnAuth() {
  return Bun.spawn(["claude", "auth", "status", "--json"], {
    stdout: "pipe",
    stderr: "ignore",
    env: subprocessEnvironment(),
  });
}

export async function readClaudeAuth(
  now: Date,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ClaudeAuthInfo> {
  let proc: ReturnType<typeof spawnAuth>;
  try {
    proc = spawnAuth();
  } catch (error) {
    throw new Error(`claude cli not found: ${String(error)}`);
  }

  const guard = createSubprocessGuard(proc, {
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
    timeoutError: () => new Error("timeout"),
  });
  try {
    const output = await guard.waitFor(new Response(proc.stdout).text());
    const parsed: unknown = JSON.parse(output);
    return parseAuthStatus(parsed, now.getTime()) ?? { loggedIn: false, subscriptionType: null, fetchedAtMs: now.getTime() };
  } finally {
    guard.dispose();
  }
}

const STALE_MS = 30 * 60_000;
const MIN_POLL_MS = 60_000;
const MIN_FORCED_POLL_MS = 5_000;

export interface ClaudeAuthSource {
  read(): ClaudeAuthInfo | null;
  poll(now: Date, options?: PollOptions): Promise<void>;
}

export const dormantClaudeAuthSource: ClaudeAuthSource = {
  read: () => null,
  poll: () => Promise.resolve(),
};

type ClaudeAuthReader = typeof readClaudeAuth;

export function createClaudeAuthSource(reader: ClaudeAuthReader = readClaudeAuth): ClaudeAuthSource {
  let cached: ClaudeAuthInfo | null = null;
  let nextPollAtMs = 0;
  let lastAttemptAtMs = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  async function request(now: Date, options: PollOptions): Promise<void> {
    const nowMs = now.getTime();
    lastAttemptAtMs = nowMs;
    nextPollAtMs = nowMs + MIN_POLL_MS;
    try {
      cached = await reader(now, { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // Auth is supplemental; a failure should not replace cached data.
    }
  }

  return {
    read: () => {
      if (!cached || Date.now() - cached.fetchedAtMs > STALE_MS) return null;
      return cached;
    },
    poll(now, options = {}) {
      // Same guarantee as the limits sources: never two `claude` children at once.
      if (inFlight) return inFlight;
      const nowMs = now.getTime();
      const floorMs = options.force ? MIN_FORCED_POLL_MS : MIN_POLL_MS;
      if (nowMs - lastAttemptAtMs < floorMs) return Promise.resolve();
      if (!options.force && nowMs < nextPollAtMs) return Promise.resolve();

      const pending = request(now, options).finally(() => {
        if (inFlight === pending) inFlight = null;
      });
      inFlight = pending;
      return pending;
    },
  };
}
