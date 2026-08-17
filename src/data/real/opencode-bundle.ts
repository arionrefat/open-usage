/**
 * Recovers opencode's server-function ids from its own client bundle.
 *
 * The ids are content hashes that change on every redeploy, but the bundle also
 * emits the registration key each one was declared under - `query(fn, "usage.list")`.
 * Those keys are stable, so a stale hash can be re-derived instead of shipped.
 */
const OPENCODE_ORIGIN = "https://opencode.ai";

const ASSET_PATH = /assets\/[A-Za-z0-9_.\-]+\.js/g;
const SERVER_REFERENCE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createServerReference\(\s*"([0-9a-f]{64})"\s*\)/g;
const REGISTRATION = /\b(?:query|action)\(\s*([A-Za-z_$][\w$]*)\s*,\s*"([^"]+)"/g;
/** The bundle renames a reference before registering it: `const getUsageInfo = getUsageInfo_1;`. */
const ALIAS = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*[;,}\n]/g;
const MAX_ALIAS_HOPS = 8;

/** The bundle is a few dozen chunks; the cap stops a redesign from crawling forever. */
const MAX_CHUNKS = 200;
const MAX_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface ServerFunctionRef {
  /** Registration key, e.g. "usage.list". Stable across redeploys; the hash is not. */
  key: string;
  hash: string;
  /** Chunk the pair was found in - two routes may register the same key. */
  chunk: string;
}

export function collectAssetPaths(source: string): string[] {
  const paths = new Set<string>();
  for (const match of source.matchAll(ASSET_PATH)) {
    paths.add(match[0].replace(/^.*assets\//, ""));
  }
  return [...paths];
}

/**
 * Pairs each `createServerReference("<hash>")` with the key its `query`/`action`
 * call registered it under, following the alias the bundle assigns in between. A
 * reference with no registration is dropped: the symbol name alone cannot tell
 * two same-named functions apart, and the bundle does contain such pairs.
 */
export function parseServerFunctionRefs(source: string, chunk: string): ServerFunctionRef[] {
  const hashBySymbol = new Map<string, string>();
  for (const match of source.matchAll(SERVER_REFERENCE)) {
    const [, symbol, hash] = match;
    if (symbol !== undefined && hash !== undefined) hashBySymbol.set(symbol, hash);
  }

  const aliases = new Map<string, string>();
  for (const match of source.matchAll(ALIAS)) {
    const [, alias, target] = match;
    if (alias !== undefined && target !== undefined) aliases.set(alias, target);
  }

  const hashFor = (symbol: string): string | null => {
    let current = symbol;
    for (let hop = 0; hop <= MAX_ALIAS_HOPS; hop += 1) {
      const known = hashBySymbol.get(current);
      if (known !== undefined) return known;
      const next = aliases.get(current);
      if (next === undefined || next === current) return null;
      current = next;
    }
    return null;
  };

  const refs: ServerFunctionRef[] = [];
  const seenHashesByKey = new Map<string, Set<string>>();
  for (const match of source.matchAll(REGISTRATION)) {
    const [, symbol, key] = match;
    if (symbol === undefined || key === undefined) continue;
    const hash = hashFor(symbol);
    if (hash === null) continue;
    const seen = seenHashesByKey.get(key) ?? new Set<string>();
    if (seen.has(hash)) continue;
    seen.add(hash);
    seenHashesByKey.set(key, seen);
    refs.push({ key, hash, chunk });
  }
  return refs;
}

export function groupByKey(refs: ServerFunctionRef[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const ref of refs) {
    const hashes = grouped.get(ref.key) ?? [];
    if (!hashes.includes(ref.hash)) hashes.push(ref.hash);
    grouped.set(ref.key, hashes);
  }
  return grouped;
}

async function fetchText(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(url, { signal, redirect: "follow" });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(run))));
  }
  return results;
}

/**
 * Walks the chunk graph from the landing page and returns every registration key
 * it can pair with a hash. Network-heavy by nature, so this is a recovery path -
 * callers fall back to it only once a shipped id stops parsing.
 */
export async function discoverServerFunctionRefs(
  options: { signal?: AbortSignal; timeoutMs?: number; origin?: string } = {},
): Promise<Map<string, string[]>> {
  const origin = options.origin ?? OPENCODE_ORIGIN;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  const landing = await fetchText(`${origin}/`, signal);
  if (landing === null) return new Map();

  const refs: ServerFunctionRef[] = [];
  const visited = new Set<string>();
  let frontier = collectAssetPaths(landing);

  while (frontier.length > 0 && visited.size < MAX_CHUNKS) {
    const batch = frontier.filter((name) => !visited.has(name)).slice(0, MAX_CHUNKS - visited.size);
    for (const name of batch) visited.add(name);

    const bodies = await mapWithLimit(batch, MAX_CONCURRENCY, async (name) => ({
      name,
      body: await fetchText(`${origin}/_build/assets/${name}`, signal),
    }));

    const next = new Set<string>();
    for (const { name, body } of bodies) {
      if (body === null) continue;
      refs.push(...parseServerFunctionRefs(body, name));
      for (const path of collectAssetPaths(body)) {
        if (!visited.has(path)) next.add(path);
      }
    }
    frontier = [...next];
  }
  return groupByKey(refs);
}
