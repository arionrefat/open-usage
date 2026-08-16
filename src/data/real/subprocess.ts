/** Environment inherited by vendor CLIs, excluding open-usage-owned secrets. */
export function subprocessEnvironment(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("OPEN_USAGE_")),
  );
}

const KILL_GRACE_MS = 100;

interface KillableProcess {
  kill(signal?: number | NodeJS.Signals): void;
}

interface SubprocessGuardOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  timeoutError: () => Error;
  killGraceMs?: number;
}

/**
 * Races subprocess I/O against cancellation and a hard deadline. A child that
 * ignores SIGTERM is killed after a short grace period, while the caller's
 * promise rejects at the deadline instead of waiting for stdout or exit.
 */
export function createSubprocessGuard(
  proc: KillableProcess,
  options: SubprocessGuardOptions,
): { waitFor<T>(work: Promise<T>): Promise<T>; dispose(): void } {
  let isTerminating = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (isTerminating) return;
    isTerminating = true;
    try {
      proc.kill("SIGTERM");
    } catch {}
    forceKillTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, options.killGraceMs ?? KILL_GRACE_MS);
  };

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      terminate();
      reject(options.timeoutError());
    }, options.timeoutMs);
  });

  let abort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    if (!options.signal) return;
    abort = () => {
      terminate();
      reject(
        options.signal?.reason ?? new DOMException("Refresh aborted", "AbortError"),
      );
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
  });

  return {
    waitFor: <T>(work: Promise<T>) => Promise.race([work, deadline, cancellation]),
    dispose: () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (abort) options.signal?.removeEventListener("abort", abort);
      if (!isTerminating) {
        try {
          proc.kill("SIGTERM");
        } catch {}
      }
      // Once a deadline or cancel requests termination, retain the escalation
      // timer until it fires. Clearing it here would let a TERM-ignoring child
      // outlive the already-settled refresh promise.
      void forceKillTimer;
    },
  };
}
