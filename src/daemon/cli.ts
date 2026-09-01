import { spawn } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname } from "node:path";
import {
  APP_NAME,
  DAEMON_MAX_INTERVAL_MINUTES,
  DAEMON_MIN_INTERVAL_MINUTES,
  parseDaemonIntervalMinutes,
} from "../config";
import { hasRealSources, defaultRealProviderPaths, selectUsageProvider } from "../data/real-provider";
import { readFlags } from "../lib/args";
import { defaultPreferencesPath, readPreferences, updatePreferences } from "../preferences";
import {
  claimDaemonState,
  restartDaemon,
  startDaemon,
  statusDaemon,
  stopDaemon,
  type DaemonCommandResult,
  type DaemonHost,
} from "./lifecycle";
import { runDaemonLoop } from "./runtime";
import { clearDaemonState, defaultDaemonLogPath, defaultDaemonStatePath } from "./state";

const LOG_ROTATE_BYTES = 1024 * 1024;
const DEFAULT_LOG_LINES = 20;

export function daemonHelpText(): string {
  return `${APP_NAME} daemon - keep the usage cache warm in the background

USAGE
  ${APP_NAME} daemon <command> [options]

COMMANDS
  start                start the daemon and return
  stop                 ask a running daemon to shut down
  restart              stop, then start with the current interval
  status               report whether a daemon is running and how it is doing
  logs                 print the tail of the daemon log
  run                  run the poll loop in the foreground (for launchd/systemd)

OPTIONS
  --interval <min>     minutes between polls, ${DAEMON_MIN_INTERVAL_MINUTES}-${DAEMON_MAX_INTERVAL_MINUTES}; remembered for next time
  --lines <n>          how many log lines \`logs\` prints (default ${DEFAULT_LOG_LINES})

The daemon is off until you start it, and it does not survive a reboot on its
own - start it from your login items, launchd, or systemd if you want that.`;
}

/**
 * How to invoke ourselves again. A compiled binary is its own runtime, which
 * Bun marks by serving the entry from a virtual root; running from source needs
 * the Bun executable plus the real entry path.
 */
export function selfCommand(main: string = Bun.main, execPath: string = process.execPath): string[] {
  const isCompiled = main.startsWith("/$bunfs/") || main.includes("~BUN");
  return isCompiled ? [execPath] : [execPath, main];
}

/** Rotates before handing the log to a new daemon, which is safe: nobody holds it. */
function rotateLogBeforeStart(path: string): void {
  try {
    if (statSync(path).size < LOG_ROTATE_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    // No log yet, or a home we cannot write: neither is worth failing a run over.
  }
}

/**
 * Rotation from inside the daemon, so a run that lasts months stays bounded
 * rather than only being trimmed the next time someone restarts it. `start`
 * points the child's stdout at the log, and that fd follows a rename, so the
 * only rotation available here is to copy the file aside and truncate it in
 * place - the fd was opened for append, so the next line lands at the new start.
 *
 * Anything that is not our own log file is left alone: under launchd or systemd
 * stdout is a pipe and rotation belongs to the supervisor, and a shell redirect
 * is the user's own file to manage.
 *
 * `fd` is a test seam; production always rotates the stdout it was handed.
 */
export function rotateOwnLog(logPath: string, fd: number = process.stdout.fd): void {
  try {
    const out = fstatSync(fd);
    if (!out.isFile() || out.size < LOG_ROTATE_BYTES) return;
    const onDisk = statSync(logPath);
    if (out.dev !== onDisk.dev || out.ino !== onDisk.ino) return;
    copyFileSync(logPath, `${logPath}.1`);
    ftruncateSync(fd, 0);
  } catch {
    // A log we cannot rotate is not a reason to stop polling.
  }
}

function openLogFd(path: string): number {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return openSync(path, "a", 0o600);
}

function createHost(): DaemonHost {
  const statePath = defaultDaemonStatePath();
  const logPath = defaultDaemonLogPath();
  return {
    statePath,
    logPath,
    now: () => new Date(),
    // Uptime is the only portable way to ask when the machine came up.
    bootedAtMs: () => Date.now() - uptime() * 1000,
    isAlive: (pid) => {
      try {
        // Signal 0 checks for a process we may signal without sending anything.
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM means it exists but belongs to someone else, which still counts.
        return error instanceof Error && "code" in error && error.code === "EPERM";
      }
    },
    terminate: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone; the caller polls for its disappearance either way.
      }
    },
    spawn: (intervalMinutes) => {
      rotateLogBeforeStart(logPath);
      const fd = openLogFd(logPath);
      try {
        const [command, ...prefix] = selfCommand();
        const child = spawn(
          command!,
          [...prefix, "daemon", "run", "--interval", String(intervalMinutes)],
          // detached puts the daemon in its own session, so closing the terminal
          // that started it does not take it down with a SIGHUP.
          { detached: true, stdio: ["ignore", fd, fd] },
        );
        child.unref();
        if (child.pid === undefined) throw new Error("could not spawn the daemon process");
        return child.pid;
      } finally {
        closeSync(fd);
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    hasRealSources: () => hasRealSources(defaultRealProviderPaths()),
  };
}

function resolveInterval(flags: Map<string, string>): DaemonCommandResult | number {
  const preferencesPath = defaultPreferencesPath();
  const remembered = readPreferences(preferencesPath).daemonIntervalMinutes;
  if (!flags.has("interval")) return remembered;

  const requested = parseDaemonIntervalMinutes(flags.get("interval"));
  if (requested === null) {
    return {
      exitCode: 1,
      message: `--interval takes a whole number of minutes between ${DAEMON_MIN_INTERVAL_MINUTES} and ${DAEMON_MAX_INTERVAL_MINUTES}`,
    };
  }
  if (requested !== remembered) {
    try {
      updatePreferences(preferencesPath, { daemonIntervalMinutes: requested });
    } catch {
      // A read-only home still gets the interval it asked for, just not next time.
    }
  }
  return requested;
}

function tailLog(path: string, lines: number): DaemonCommandResult {
  try {
    const content = readFileSync(path, "utf8").trimEnd();
    if (content === "") return { exitCode: 0, message: `${path} is empty` };
    return { exitCode: 0, message: content.split("\n").slice(-lines).join("\n") };
  } catch {
    return { exitCode: 0, message: `no daemon log yet at ${path}` };
  }
}

/** The daemon process itself: claims the record, polls until told to stop, cleans up. */
async function runInForeground(intervalMinutes: number): Promise<DaemonCommandResult> {
  const statePath = defaultDaemonStatePath();
  const logPath = defaultDaemonLogPath();
  const provider = selectUsageProvider("real");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);

  claimDaemonState(statePath, {
    pid: process.pid,
    startedAtMs: Date.now(),
    intervalMinutes,
    logPath,
  });
  process.stdout.write(
    `${new Date().toISOString()} daemon started · pid ${process.pid} · every ${intervalMinutes}m\n`,
  );
  try {
    await runDaemonLoop({
      provider,
      statePath,
      intervalMs: intervalMinutes * 60_000,
      signal: controller.signal,
      ownerPid: process.pid,
      log: (line) => {
        rotateOwnLog(logPath);
        process.stdout.write(`${line}\n`);
      },
    });
  } finally {
    clearDaemonState(statePath, process.pid);
  }
  return { exitCode: 0, message: `${new Date().toISOString()} daemon stopped` };
}

/** Runs one `daemon` subcommand and answers with what to print and what to exit with. */
export async function runDaemonCommand(argv: readonly string[]): Promise<DaemonCommandResult> {
  const [command = "status", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    return { exitCode: 0, message: daemonHelpText() };
  }

  const flags = readFlags([...rest]);
  const host = createHost();

  switch (command) {
    case "status":
      return statusDaemon(host);
    case "stop":
      return stopDaemon(host);
    case "logs": {
      const requested = Number(flags.get("lines"));
      const lines = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_LOG_LINES;
      return tailLog(host.logPath, lines);
    }
    case "start":
    case "restart":
    case "run": {
      const interval = resolveInterval(flags);
      if (typeof interval !== "number") return interval;
      if (command === "start") return startDaemon(host, interval);
      if (command === "restart") return restartDaemon(host, interval);
      return runInForeground(interval);
    }
    default:
      return {
        exitCode: 1,
        message: `unknown daemon command "${command}"\n\n${daemonHelpText()}`,
      };
  }
}
