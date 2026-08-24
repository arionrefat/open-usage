import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "../src/app";
import { toggleSegments } from "../src/components/toggle";
import { mockUsageProvider } from "../src/data/mock-provider";
import type { UsageProvider, UsageSnapshot } from "../src/data/types";
import {
  VIEW_KEYS,
  type OverviewMode,
  type ViewKey,
} from "../src/state/app-state";
import { COLORS } from "../src/theme";
import { legendBarWidth } from "../src/screens/overview-simple";
import { dailySplitBarWidth } from "../src/screens/overview-detailed";

test("toggle pills have only a plain gap and share the accent background", () => {
  const options = [
    { label: "first", value: "first" },
    { label: "second", value: "second" },
  ];
  const firstActive = toggleSegments(options, "first", () => {});
  const secondActive = toggleSegments(options, "second", () => {});

  expect(firstActive).toHaveLength(3);
  expect(firstActive.map((segment) => segment.text)).toEqual([" first ", " ", " second "]);
  expect(firstActive[0]?.background).toBe(COLORS.accent);
  expect(firstActive[0]?.onClick).toBeFunction();
  expect(firstActive[1]?.background).toBeUndefined();
  expect(firstActive[1]?.onClick).toBeUndefined();
  expect(firstActive[2]?.background).toBe(COLORS.bgChip);
  expect(firstActive[2]?.onClick).toBeFunction();
  expect(secondActive[0]?.background).toBe(COLORS.bgChip);
  expect(secondActive[2]?.background).toBe(COLORS.accent);
});

/** 60 is the narrowest width the chrome is expected to stay legible at. */
const WIDTHS = [60, 80, 100, 140];
const HEIGHT = 44;

async function renderRows(
  width: number,
  view: ViewKey,
  mode: OverviewMode,
  patch?: (snapshot: UsageSnapshot) => UsageSnapshot,
): Promise<string[]> {
  const provider: UsageProvider = patch
    ? {
        ...mockUsageProvider,
        readSnapshot: () => patch(mockUsageProvider.readSnapshot()),
        refresh: (request) => mockUsageProvider.refresh(request).then(patch),
      }
    : mockUsageProvider;
  const setup = await testRender(
    <App
      provider={provider}
      startup={{ screen: "app", view, mode, useSeverityColors: false, isDailySplitVisible: true }}
    />,
    { width, height: HEIGHT },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setup.flush();
    // The captured frame ends with a trailing newline; drop the empty row it leaves.
    return setup.captureCharFrame().replace(/\n$/, "").split("\n");
  } finally {
    act(() => setup.renderer.destroy());
  }
}

function rowContaining(rows: string[], needle: string): string {
  return rows.find((row) => row.includes(needle)) ?? "";
}

describe("chrome stays on one row", () => {
  for (const width of WIDTHS) {
    test(`header does not wrap at ${width} columns`, async () => {
      const rows = await renderRows(width, "overview", "detailed");
      const header = rowContaining(rows, "OPEN USAGE");
      // Both groups on one row means the line never overflowed into a second.
      expect(header).toContain("updated");
    });

    test(`header keeps a gap before the alert group at ${width} columns`, async () => {
      const rows = await renderRows(width, "overview", "detailed");
      expect(rowContaining(rows, "OPEN USAGE")).toMatch(/\s3 providers ▏ ▲/);
    });

    test(`tab strip does not wrap at ${width} columns`, async () => {
      const rows = await renderRows(width, "overview", "detailed");
      expect(rowContaining(rows, "1 overview")).toContain("range");
    });
  }
});

test("header orders provider count before status", async () => {
  const header = rowContaining(
    await renderRows(140, "overview", "detailed"),
    "OPEN USAGE",
  );
  expect(header).toMatch(/3 providers ▏ ▲.* ▏ updated/);
});

describe("no adjacent groups collide", () => {
  /** Exact collisions observed before the overflow guard existed. */
  const COLLISIONS = ["providers▲", "codexPlus", "opencode goGo", "claude codeMax", "models88%"];

  for (const width of WIDTHS) {
    for (const mode of ["detailed", "simple"] as const) {
      test(`${mode} overview at ${width} columns`, async () => {
        const frame = (await renderRows(width, "overview", mode)).join("\n");
        for (const collision of COLLISIONS) expect(frame).not.toContain(collision);
      });
    }
  }
});

test("simple overview uses the fixed-geometry plan chart", async () => {
  const frame = (await renderRows(140, "overview", "simple")).join("\n");
  expect(frame).toContain("plan usage");
  expect(frame).toContain("100 │");
  expect(frame).toContain(" 50 │");
  expect(frame).toContain(`  0 └${"─".repeat(34)}`);
  expect(frame).toContain("% share");
  expect(frame).not.toContain("largest share");
});

test("simple overview keeps all three providers in the legend", async () => {
  const rows = await renderRows(140, "overview", "simple");
  // codex ships expired in the mock, so its off-state legend must still render.
  expect(rowContaining(rows, "▎codex")).not.toBe("");
  expect(rowContaining(rows, "▎codex")).not.toContain("share");
  expect(rows.join("\n")).toContain("failed");
});

test("narrow meters and daily bars give their fixed prefixes first claim on width", () => {
  expect(7 + legendBarWidth(12)).toBe(12);
  expect(legendBarWidth(5)).toBe(0);
  expect(9 + 1 + 4 + dailySplitBarWidth(18, 4)).toBe(18);
  expect(dailySplitBarWidth(10, 4)).toBe(0);
});

/** Half-height block: full blocks would fuse the rows into one wedge. */
const SHARE_BAR = "▀";

/** The share row for one provider: name, figures and bar on a single line. */
function shareRow(rows: string[], name: string): string {
  return (
    rows.find(
      (row) => new RegExp(`^\\s+${name}\\s{2,}`).test(row) && /[▀·]/.test(row),
    ) ?? ""
  );
}

test("usage share states the window its arrows compare", async () => {
  const frame = (await renderRows(140, "overview", "detailed")).join("\n");
  expect(frame).toContain("usage share");
  expect(frame).toContain("total");
  expect(frame).toContain("▲▼ 7d change");
});

test("usage share gives each provider one bar, a percent and a token count", async () => {
  const rows = await renderRows(140, "overview", "detailed");
  const row = shareRow(rows, "claude code");
  expect(row).toContain(SHARE_BAR);
  expect(row).toMatch(/\s60%\s/);
  expect(row).toContain("1.44B");
  // The old three-column layout scaled each bar to its own column; one row per
  // provider on a shared baseline is what makes the shares comparable.
  expect(rows.join("\n")).not.toContain("━━━━━━━━");
});

test("usage share ranks the heaviest provider first", async () => {
  const patch = (snapshot: UsageSnapshot): UsageSnapshot => ({
    ...snapshot,
    providers: {
      ...snapshot.providers,
      cl: {
        ...snapshot.providers.cl,
        series: { ...snapshot.providers.cl.series, daily: [...Array(29).fill(0), 1] },
      },
    },
  });
  const rows = await renderRows(140, "overview", "detailed", patch);
  const order = rows
    .map((row) => ["codex", "opencode go", "claude code"].find((name) => shareRow(rows, name) === row))
    .filter((name): name is string => name !== undefined);
  expect(order).toEqual(["codex", "opencode go", "claude code"]);
});

test("a provider with no history source says so instead of claiming a zero share", async () => {
  const rows = await renderRows(140, "overview", "detailed", (snapshot) => ({
    ...snapshot,
    providers: {
      ...snapshot.providers,
      go: { ...snapshot.providers.go, hasHistory: false },
    },
  }));
  const row = shareRow(rows, "opencode go");

  expect(row).toContain("no history");
  // A dotted lane, never a bar or a measured-looking zero.
  expect(row).toContain("·");
  expect(row).not.toContain(SHARE_BAR);
  expect(row).not.toContain("0%");
  expect(shareRow(rows, "claude code")).toContain(SHARE_BAR);
});

const CARD_ALERT = "✓ 1 free limit reset available";

/** Flags one alert for the card and leaves a second alert detail-only. */
function withCardAlert(snapshot: UsageSnapshot): UsageSnapshot {
  return {
    ...snapshot,
    providers: {
      ...snapshot.providers,
      cl: {
        ...snapshot.providers.cl,
        limits: snapshot.providers.cl.limits.map((limit, index) => ({
          ...limit,
          alert:
            index === 0
              ? { text: CARD_ALERT, color: COLORS.ok, isOnCard: true }
              : { text: "▲ detail-only warning", color: COLORS.danger },
        })),
      },
    },
  };
}

test("overview cards carry card-flagged limit alerts and leave the rest to the detail screen", async () => {
  const frame = (await renderRows(140, "overview", "detailed", withCardAlert)).join("\n");

  expect(frame).toContain(CARD_ALERT);
  expect(frame).not.toContain("▲ detail-only warning");
});

test("a card alert sits below every meter so neighbouring cards stay row-aligned", async () => {
  const meterRow = (rows: string[]) => rows.findIndex((row) => row.includes("weekly · all models"));
  const plain = await renderRows(140, "overview", "detailed");
  const alerted = await renderRows(140, "overview", "detailed", withCardAlert);

  expect(meterRow(plain)).toBeGreaterThan(0);
  expect(meterRow(alerted)).toBe(meterRow(plain));
  // The alert lands after the card's last meter, not between two of them.
  expect(alerted.findIndex((row) => row.includes(CARD_ALERT))).toBeGreaterThan(meterRow(alerted));
});

test("a provider with no cap states its rate instead of projecting against nothing", async () => {
  const rows = await renderRows(140, "overview", "detailed", (snapshot) => ({
    ...snapshot,
    providers: {
      ...snapshot.providers,
      cl: {
        ...snapshot.providers.cl,
        burn: { ...snapshot.providers.cl.burn, rate: "9K tok/h", capsOutAt: null },
      },
    },
  }));
  const frame = rows.join("\n");

  expect(frame).toContain("9K tok/h");
  expect(frame).toContain("no cap to project against");
  // The old template spliced the placeholder straight into the sentence.
  expect(frame).not.toContain("you cap out no cap data");
  expect(frame).not.toContain("projected 0% at reset");
});

/** Strips the cache figure from every provider, leaving nothing for the column to state. */
function withoutCacheReads(snapshot: UsageSnapshot): UsageSnapshot {
  const strip = (provider: UsageSnapshot["providers"]["cl"]) => {
    const { cacheRead30d: _dropped, ...rest } = provider;
    return rest;
  };
  return {
    ...snapshot,
    providers: {
      cl: strip(snapshot.providers.cl),
      cx: strip(snapshot.providers.cx),
      go: strip(snapshot.providers.go),
    },
  };
}

test("usage share states cache reads beside the tokens they are held out of", async () => {
  const rows = await renderRows(140, "overview", "detailed");
  const row = shareRow(rows, "claude code");

  // The period is named: the column stays 30d while the range beside it cycles.
  expect(rows.join("\n")).toContain("+ 30d cache read");
  // Both figures on one row: the cache volume is stated without being folded
  // into the token count, which would make the cross-provider share meaningless.
  expect(row).toContain("1.44B");
  expect(row).toContain("2.68B");
});

test("a source reporting no cache breakdown reads as unknown, not as zero", async () => {
  const rows = await renderRows(140, "overview", "detailed");
  // codex's server figure carries no cache split at all; printing 0 would claim
  // a measurement nobody made.
  expect(shareRow(rows, "codex")).toMatch(/551M\s+-\s/);
  expect(shareRow(rows, "codex")).not.toMatch(/551M\s+0\s/);
});

test("the cache column drops out entirely when no provider reports cache reads", async () => {
  const rows = await renderRows(140, "overview", "detailed", withoutCacheReads);

  expect(rows.join("\n")).not.toContain("cache read");
  // The token figures stay put; only the column of nothing-but-dashes goes.
  expect(shareRow(rows, "claude code")).toContain("1.44B");
  expect(shareRow(rows, "claude code")).not.toMatch(/1\.44B\s+-\s/);
});

test("cache outlives the session count when the row runs out of room", async () => {
  const withSessions = (snapshot: UsageSnapshot): UsageSnapshot => ({
    ...snapshot,
    providers: { ...snapshot.providers, cl: { ...snapshot.providers.cl, sessions30d: 204 } },
  });
  const roomy = shareRow(await renderRows(80, "overview", "detailed", withSessions), "claude code");
  const cramped = shareRow(await renderRows(70, "overview", "detailed", withSessions), "claude code");

  expect(roomy).toContain("204 sessions");
  expect(roomy).toContain("2.68B");
  // The session count is the first to give way; the cache volume can dwarf every
  // other figure on the row and is stated nowhere else on this screen.
  expect(cramped).not.toContain("204 sessions");
  expect(cramped).toContain("2.68B");
});

describe("every view renders at every width", () => {
  for (const width of WIDTHS) {
    for (const view of VIEW_KEYS) {
      test(`${view} at ${width} columns`, async () => {
        const rows = await renderRows(width, view, "detailed");
        expect(rows.length).toBe(HEIGHT);
        for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
      });
    }
  }
});
