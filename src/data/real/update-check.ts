import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "../../config";
import { isRecord } from "./json";

/** A slow registry must never become a slow launch, so the window is short and hard. */
const REQUEST_TIMEOUT_MS = 1500;
/** One request answers both: the `latest` tag and any `critical` tag. */
const REGISTRY_URL = "https://registry.npmjs.org/-/package/open-usage/dist-tags";
/** npm dist-tag marking a release every installed version must take. */
const CRITICAL_TAG = "critical";
/** Set to any non-empty value to stop the check from running at all. */
const OPT_OUT_ENV = "OPEN_USAGE_NO_UPDATE_CHECK";

export interface UpdateCacheEntry {
  latestVersion: string;
  criticalVersion: string | null;
  checkedAtMs: number;
}

export interface UpdateNotice {
  /** The version to advertise: the critical tag when it applies, latest otherwise. */
  version: string;
  /** True when the running version is older than the `critical` dist-tag. */
  isCritical: boolean;
}

function defaultUpdateCachePath(): string {
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
    // Entries written before the critical tag existed simply have no tag recorded.
    const criticalVersion =
      typeof parsed.criticalVersion === "string" ? parsed.criticalVersion : null;
    return { latestVersion: parsed.latestVersion, criticalVersion, checkedAtMs: parsed.checkedAtMs };
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

/**
 * Resolves to null if `promise` has not settled in time. The abort signal below
 * already asks a well-behaved fetch to stop, but the signal only binds an
 * implementation that honours it - and `FetchLike` is injectable. This makes the
 * deadline a property of the caller instead of a favour from the callee.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    // A pending check must never be the reason the process stays alive.
    timer.unref?.();
    const settle = (value: T | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(settle, () => settle(null));
  });
}

async function readRegistryTags(
  fetchImpl: FetchLike,
): Promise<{ latestVersion: string; criticalVersion: string | null } | null> {
  const response = await fetchImpl(REGISTRY_URL, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.latest !== "string") return null;
  const criticalVersion = typeof body[CRITICAL_TAG] === "string" ? body[CRITICAL_TAG] : null;
  return { latestVersion: body.latest, criticalVersion };
}

/** null on any failure: offline, DNS, proxy, timeout, a hang and a bad body are one case here. */
export async function fetchDistTags(
  fetchImpl: FetchLike = fetch,
): Promise<{ latestVersion: string; criticalVersion: string | null } | null> {
  return withDeadline(readRegistryTags(fetchImpl), REQUEST_TIMEOUT_MS);
}

export interface UpdateCheckOptions {
  currentVersion: string;
  path?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

/**
 * Turns a registry answer into a notice: nothing to say means null. The critical
 * tag wins over latest - if the running version predates it, this is an emergency
 * even when latest has already moved further ahead.
 */
export function noticeFor(
  tags: { latestVersion: string; criticalVersion: string | null },
  currentVersion: string,
): UpdateNotice | null {
  if (tags.criticalVersion !== null && isNewerVersion(tags.criticalVersion, currentVersion)) {
    return { version: tags.criticalVersion, isCritical: true };
  }
  if (isNewerVersion(tags.latestVersion, currentVersion)) {
    return { version: tags.latestVersion, isCritical: false };
  }
  return null;
}

/**
 * The notice to render, or null when there is nothing to say. Every launch asks
 * the registry, so a release shows up the next time the dashboard opens; the
 * cache only stands in when that request fails, so an install that already
 * heard about a release keeps saying so while offline. Never throws and never
 * rejects: the caller renders a dim corner line, so any failure has to end as
 * silence rather than as an error the user did not ask for.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateNotice | null> {
  const { currentVersion, env = process.env, fetchImpl = fetch } = options;
  if (isUpdateCheckDisabled(env)) return null;

  const path = options.path ?? defaultUpdateCachePath();
  const nowMs = (options.now ?? new Date()).getTime();

  const tags = await fetchDistTags(fetchImpl);
  if (tags === null) {
    const cached = readUpdateCache(path);
    return cached === null ? null : noticeFor(cached, currentVersion);
  }

  const entry: UpdateCacheEntry = { ...tags, checkedAtMs: nowMs };
  writeUpdateCache(path, entry);
  return noticeFor(entry, currentVersion);
}
