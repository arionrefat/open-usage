import { describe, expect, spyOn, test } from "bun:test";
import {
  collectAssetPaths,
  discoverServerFunctionRefs,
  groupByKey,
  parseServerFunctionRefs,
} from "../../../src/data/real/opencode-bundle";

/** Verbatim in shape from opencode's own chunks, trimmed to the declarations. */
const WORKSPACE_CHUNK =
  'const getWorkspaces_query = createServerReference("def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f");' +
  'const getWorkspaces = query(getWorkspaces_query, "workspaces");';

/** The usage route aliases the reference before registering it. */
const USAGE_CHUNK =
  'const getUsageInfo_1 = createServerReference("bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c");' +
  "const getUsageInfo = getUsageInfo_1;" +
  'const queryUsageInfo = query(getUsageInfo, "usage.list");' +
  'const getCosts_1 = createServerReference("15702f3a12ff8bff357f8c2aa154a17e65b746d5f6b96adc9002c86ee0c15205");' +
  "const getCosts = getCosts_1;";

/** A second route registers the same key under a different hash. */
const KEYS_CHUNK =
  'const listKeys_query = createServerReference("6262ba54bff26cd7ec162f93db420e0d19df9cd94b2233dfe3b6b24c3f990388");' +
  'const listKeys = query(listKeys_query, "usage.list");';

describe("parseServerFunctionRefs", () => {
  test("pairs a directly registered reference with its key", () => {
    expect(parseServerFunctionRefs(WORKSPACE_CHUNK, "workspace.js")).toEqual([
      {
        key: "workspaces",
        hash: "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f",
        chunk: "workspace.js",
      },
    ]);
  });

  test("follows the alias between the reference and its registration", () => {
    // Without alias resolution the usage ids - the only reason to scan at all -
    // would both be missed.
    expect(parseServerFunctionRefs(USAGE_CHUNK, "usage.js")).toEqual([
      {
        key: "usage.list",
        hash: "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c",
        chunk: "usage.js",
      },
    ]);
  });

  test("drops a reference that is never registered", () => {
    // getCosts is called directly, so it has no key to be recovered by.
    const refs = parseServerFunctionRefs(USAGE_CHUNK, "usage.js");
    expect(refs.some((ref) => ref.hash.startsWith("15702f3a"))).toBe(false);
  });

  test("ignores registrations that resolve to no reference", () => {
    expect(parseServerFunctionRefs('query(somethingElse, "other.key");', "x.js")).toEqual([]);
  });
});

describe("groupByKey", () => {
  test("keeps every candidate when two routes register the same key", () => {
    // Collapsing to one hash here would silently pick the wrong endpoint.
    const refs = [
      ...parseServerFunctionRefs(USAGE_CHUNK, "usage.js"),
      ...parseServerFunctionRefs(KEYS_CHUNK, "keys.js"),
    ];
    expect(groupByKey(refs).get("usage.list")).toEqual([
      "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c",
      "6262ba54bff26cd7ec162f93db420e0d19df9cd94b2233dfe3b6b24c3f990388",
    ]);
  });

  test("does not repeat an identical hash seen in two chunks", () => {
    const refs = [
      ...parseServerFunctionRefs(WORKSPACE_CHUNK, "a.js"),
      ...parseServerFunctionRefs(WORKSPACE_CHUNK, "b.js"),
    ];
    expect(groupByKey(refs).get("workspaces")).toHaveLength(1);
  });
});

describe("collectAssetPaths", () => {
  test("takes the bare chunk name from any asset reference", () => {
    expect(
      collectAssetPaths('import("/_build/assets/index-AbC1.js");"./assets/entry-Xy2.js"'),
    ).toEqual(["index-AbC1.js", "entry-Xy2.js"]);
  });

  test("reports each chunk once", () => {
    expect(collectAssetPaths("assets/a-1.js assets/a-1.js")).toEqual(["a-1.js"]);
  });
});

describe("discoverServerFunctionRefs", () => {
  test("walks the chunk graph and returns candidates by key", async () => {
    const bodies: Record<string, string> = {
      "https://opencode.ai/": '<script src="/_build/assets/entry-1.js">',
      "https://opencode.ai/_build/assets/entry-1.js": `${WORKSPACE_CHUNK}import("assets/usage-2.js")`,
      "https://opencode.ai/_build/assets/usage-2.js": USAGE_CHUNK,
    };
    const requested: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        (input: string | URL | Request) => {
          const url = input.toString();
          requested.push(url);
          const body = bodies[url];
          return Promise.resolve(
            body === undefined ? new Response("", { status: 404 }) : new Response(body),
          );
        },
        { preconnect: (_url: string | URL) => undefined },
      ),
    );

    try {
      const found = await discoverServerFunctionRefs();
      expect(found.get("workspaces")).toEqual([
        "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f",
      ]);
      expect(found.get("usage.list")).toEqual([
        "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c",
      ]);
      // The second-level chunk is only reachable by following the first.
      expect(requested).toContain("https://opencode.ai/_build/assets/usage-2.js");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("an unreachable landing page yields nothing rather than throwing", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(() => Promise.reject(new Error("offline")), {
        preconnect: (_url: string | URL) => undefined,
      }),
    );

    try {
      expect((await discoverServerFunctionRefs()).size).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
