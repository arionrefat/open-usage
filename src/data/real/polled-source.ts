import type { ConnectionStatus, PollOptions } from "../types";

/**
 * Scheduling core shared by every remote-backed limits source. Each provider
 * supplies only its I/O and its wording; the rules that keep us off an API's bad
 * side - one request in flight at a time, a floor under manual refreshes, and a
 * backoff that widens while a provider keeps failing - live here so they are
 * written and tested once.
 */
export interface PolledSourceSchedule {
  /**
   * Floor between automatic polls. A function is re-evaluated on every tick, so
   * a source whose cost depends on what another source already covers can widen
   * or tighten its own cadence as that coverage comes and goes.
   */
  minPollMs: number | (() => number);
  /** Floor honored even by manual refreshes, so a held key cannot flood an API. */
  minForcedPollMs: number;
  /** Delay after the first failure; doubles per consecutive failure up to the cap. */
  backoffMs: number;
  maxBackoffMs: number;
  /** Past this age a cached reading is still served, but with a notice. */
  staleAfterMs?: number;
}

/** Returned by a precheck to skip the request without calling out. */
export interface PolledSourceSkip {
  note: string | null;
  /** false leaves the schedule untouched so the next tick can retry at once. */
  isThrottled: boolean;
}

export interface PolledSourceConfig<T> extends PolledSourceSchedule {
  fetch(now: Date, signal: AbortSignal | undefined): Promise<T>;
  fetchedAtMs(value: T): number;
  /** Turns a failure into the note shown in place of a percent. */
  describeFailure(error: unknown): string;
  staleNote?(ageMs: number): string;
  /** Runs before each request; a returned value skips it. */
  precheck?(now: Date): PolledSourceSkip | null;
  /** Lets a source drop derived state - a cached workspace id - after a failure. */
  onFailure?(error: unknown): void;
  /**
   * A delay the failure itself dictates, such as a 429's Retry-After. It wins
   * over the computed backoff whenever it asks us to wait longer.
   */
  retryDelayMs?(error: unknown): number | null;
  initial?: T | null;
  onUpdate?(value: T): void;
  /**
   * A reading persisted by another process - the daemon, or a second dashboard
   * - re-read on every tick. One newer than what this source holds is adopted
   * as its own, so two processes sharing a cache never both ask the API for
   * what one of them has already fetched.
   */
  readPersisted?(): T | null;
}

export interface PolledSource<T> {
  read(): T | null;
  note(now?: Date): string | null;
  isStale(now?: Date): boolean;
  status(): ConnectionStatus;
  poll(now: Date, options?: PollOptions): Promise<void>;
}

export function createPolledSource<T>(config: PolledSourceConfig<T>): PolledSource<T> {
  let cached: T | null = config.initial ?? null;
  let note: string | null = null;
  let status: ConnectionStatus = cached ? "cached" : "none";
  /** Set only by a failure or a throttled precheck; `r` may override it. */
  let retryNotBeforeMs = 0;
  /** Server-dictated silence (a 429's Retry-After). `r` must not override this. */
  let blockedUntilMs = 0;
  let lastAttemptAtMs = Number.NEGATIVE_INFINITY;
  /**
   * When the automatic cadence last had an answer. A reading restored from the
   * persisted cache counts here, so relaunching the app - or opening it while
   * the daemon keeps that cache warm - does not fire a request the cache
   * already answers. It deliberately does not count against `minForcedPollMs`,
   * which exists to stop a held `r` from flooding an API, not to sit out the
   * first press.
   */
  let lastReadingAtMs = config.initial ? config.fetchedAtMs(config.initial) : Number.NEGATIVE_INFINITY;
  let consecutiveFailures = 0;
  let inFlight: Promise<void> | null = null;

  function minPollMs(): number {
    return typeof config.minPollMs === "function" ? config.minPollMs() : config.minPollMs;
  }

  function backoffMsFor(failures: number): number {
    const widened = config.backoffMs * 2 ** (failures - 1);
    return Math.min(config.maxBackoffMs, Number.isFinite(widened) ? widened : config.maxBackoffMs);
  }

  /**
   * Takes over a reading another process persisted since the last tick. It
   * counts as a reading of our own for the automatic cadence, and as a live
   * one for status: the other process fetched it from the provider moments
   * ago, and calling that "cached" would show a working daemon as a stale
   * dashboard. Like the seeded reading, it does not count against the manual
   * floor - that floor exists to stop a held key, not to sit out a press.
   */
  function adoptPersisted(nowMs: number): void {
    const persisted = config.readPersisted?.() ?? null;
    if (!persisted) return;
    const persistedAtMs = config.fetchedAtMs(persisted);
    // Stamped ahead of the clock is debris from a clock change, not news.
    if (persistedAtMs > nowMs) return;
    if (cached && persistedAtMs <= config.fetchedAtMs(cached)) return;
    cached = persisted;
    lastReadingAtMs = persistedAtMs;
    note = null;
    status = "active";
    // Someone just reached the provider, so whatever we were backing off from
    // has cleared. A server's own Retry-After is not ours to lift, though.
    consecutiveFailures = 0;
    retryNotBeforeMs = 0;
  }

  function isStale(now: Date = new Date()): boolean {
    if (!cached || config.staleAfterMs === undefined) return false;
    const ageMs = now.getTime() - config.fetchedAtMs(cached);
    return ageMs < 0 || ageMs > config.staleAfterMs;
  }

  async function request(now: Date, options: PollOptions): Promise<void> {
    const nowMs = now.getTime();
    const retryBeforeAttempt = retryNotBeforeMs;
    lastAttemptAtMs = nowMs;

    try {
      const value = await config.fetch(now, options.signal);
      cached = value;
      consecutiveFailures = 0;
      retryNotBeforeMs = 0;
      blockedUntilMs = 0;
      note = null;
      status = "active";
      config.onUpdate?.(value);
    } catch (error) {
      // A cancelled refresh is not a provider failure: it must not widen the
      // backoff or claim the provider is unreachable. The attempt still counts
      // against the manual floor, because the request did go out.
      if (options.signal?.aborted) {
        retryNotBeforeMs = retryBeforeAttempt;
        throw error;
      }
      consecutiveFailures += 1;
      const requestedDelayMs = config.retryDelayMs?.(error) ?? 0;
      if (requestedDelayMs > 0) blockedUntilMs = nowMs + requestedDelayMs;
      retryNotBeforeMs = nowMs + Math.max(backoffMsFor(consecutiveFailures), requestedDelayMs);
      config.onFailure?.(error);
      note = config.describeFailure(error);
      status = "expired";
    }
  }

  return {
    read: () => cached,
    note: (now) => {
      if (note) return note;
      if (!cached || config.staleAfterMs === undefined || !config.staleNote) return null;
      const ageMs = (now?.getTime() ?? Date.now()) - config.fetchedAtMs(cached);
      return ageMs < 0 || ageMs > config.staleAfterMs
        ? config.staleNote(Math.max(0, ageMs))
        : null;
    },
    isStale,
    status: () => status,
    poll(now, options = {}) {
      // One request at a time: a second caller joins the one already running
      // instead of opening a duplicate connection or spawning a second CLI. This
      // also removes any window in which a slow older reply could land on top of
      // a newer one.
      if (inFlight) return inFlight;

      const nowMs = now.getTime();
      adoptPersisted(nowMs);
      const clockMovedBackward = nowMs < lastAttemptAtMs || nowMs < lastReadingAtMs;
      // `lastAttemptAtMs` heals itself on the next attempt, but a seeded reading
      // never would: a cache stamped ahead of the clock is debris from a clock
      // change, not a licence to ignore the schedule for the life of the process.
      if (nowMs < lastReadingAtMs) lastReadingAtMs = Number.NEGATIVE_INFINITY;
      // `r` overrides our own cadence and our own guess at a backoff, but never
      // a server that answered with an explicit Retry-After.
      if (!clockMovedBackward && nowMs < blockedUntilMs) return Promise.resolve();
      if (options.force) {
        if (!clockMovedBackward && nowMs - lastAttemptAtMs < config.minForcedPollMs) return Promise.resolve();
      } else {
        if (!clockMovedBackward && nowMs < retryNotBeforeMs) return Promise.resolve();
        const cadenceAnchorMs = Math.max(lastAttemptAtMs, lastReadingAtMs);
        if (!clockMovedBackward && nowMs - cadenceAnchorMs < minPollMs()) return Promise.resolve();
      }

      const skip = config.precheck?.(now);
      if (skip) {
        note = skip.note;
        status = skip.note ? "expired" : "none";
        if (skip.isThrottled) {
          lastAttemptAtMs = nowMs;
          retryNotBeforeMs = nowMs + minPollMs();
        }
        return Promise.resolve();
      }

      const pending = request(now, options).finally(() => {
        if (inFlight === pending) inFlight = null;
      });
      inFlight = pending;
      return pending;
    },
  };
}
