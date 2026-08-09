import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "../../config";
import { isRecord } from "./json";

/**
 * The registry answer is trusted for a day. This is a courtesy notice, not a
 * security check, and a release nobody hears about for a few hours costs less
 * than a request on every launch.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** A slow registry must never become a slow launch, so the window is short and hard. */
const REQUEST_TIMEOUT_MS = 1500;
const REGISTRY_URL = "https://registry.npmjs.org/open-usage/latest";
/** Set to any non-empty value to stop the check from running at all. */
const OPT_OUT_ENV = "OPEN_USAGE_NO_UPDATE_CHECK";

export interface UpdateCacheEntry {
  latestVersion: string;
  checkedAtMs: number;
}

export function defaultUpdateCachePath(): string {
  return configPath("update-check.json");
}

export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[OPT_OUT_ENV] ?? "").trim() !== "";
}

/** Numeric release parts, ignoring any pre-release suffix. */
function releaseParts(version: string): number[] {
  return version
    .split("-")[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10));
}

function hasPreRelease(version: string): boolean {
  return version.includes("-");
}

/**
 * Orders two dotted versions. Compares release numbers pairwise so 0.10.0 sorts
 * above 0.2.0, then breaks a tie by treating a pre-release as below the release
 * it leads to - 0.2.0-beta.1 is older than 0.2.0. Returns 0 when either side is
 * unparseable, which makes an unreadable version a non-event rather than a
 * spurious upgrade prompt.
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = releaseParts(left);
  const rightParts = releaseParts(right);
  if (leftParts.some(Number.isNaN) || rightParts.some(Number.isNaN)) return 0;

  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }

  const leftPre = hasPreRelease(left);
  const rightPre = hasPreRelease(right);
  if (leftPre === rightPre) return 0;
  return leftPre ? -1 : 1;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

export function readUpdateCache(path: string): UpdateCacheEntry | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return null;
    if (typeof parsed.latestVersion !== "string") return null;
    if (typeof parsed.checkedAtMs !== "number" || !Number.isFinite(parsed.checkedAtMs)) return null;
    return { latestVersion: parsed.latestVersion, checkedAtMs: parsed.checkedAtMs };
  } catch {
    return null;
  }
}

export function writeUpdateCache(path: string, entry: UpdateCacheEntry): void {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch {
    // A cache that cannot be written costs one request next launch, nothing more.
  } finally {
    rmSync(temporary, { force: true });
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** null on any failure: offline, DNS, proxy, timeout and a bad body are one case here. */
export async function fetchLatestVersion(fetchImpl: FetchLike = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.version !== "string") return null;
    return body.version;
  } catch {
    return null;
  }
}

export interface UpdateCheckOptions {
  currentVersion: string;
  path?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

/**
 * The version to advertise, or null when there is nothing to say. Never throws
 * and never rejects: the caller renders a dim line, so any failure has to end as
 * silence rather than as an error the user did not ask for.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<string | null> {
  const { currentVersion, env = process.env, fetchImpl = fetch } = options;
  if (isUpdateCheckDisabled(env)) return null;

  const path = options.path ?? defaultUpdateCachePath();
  const nowMs = (options.now ?? new Date()).getTime();

  const cached = readUpdateCache(path);
  // A future-dated stamp means a clock change, not a fresh answer; re-ask.
  const isCacheFresh =
    cached !== null && nowMs >= cached.checkedAtMs && nowMs - cached.checkedAtMs < CACHE_TTL_MS;
  if (isCacheFresh) {
    return isNewerVersion(cached.latestVersion, currentVersion) ? cached.latestVersion : null;
  }

  const latestVersion = await fetchLatestVersion(fetchImpl);
  if (latestVersion === null) return null;

  writeUpdateCache(path, { latestVersion, checkedAtMs: nowMs });
  return isNewerVersion(latestVersion, currentVersion) ? latestVersion : null;
}
