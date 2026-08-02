/**
 * Colour screenshot harness. Renders screens to an HTML page that redraws each
 * cell on a canvas at a true 1:2 terminal aspect, painting block-drawing glyphs
 * as rectangles rather than trusting browser font metrics. Use it when a change
 * involves colour or bar geometry, which `preview.tsx` cannot show.
 *
 *   bun run shot out.html "detailed:--mode detailed" "narrow:--width 80"
 */
import { testRender } from "@opentui/react/test-utils";
import { App } from "../src/app";
import { mockUsageProvider } from "../src/data/mock-provider";
import { readFlags, startupFromFlags } from "../src/lib/args";
import { COLORS } from "../src/theme";

const DEFAULT_WIDTH = 140;
const DEFAULT_HEIGHT = 46;
const INPUT_SETTLE_MS = 30;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Cell {
  ch: string;
  fg: string;
  bg: string;
  bold: boolean;
}

interface Shot {
  label: string;
  note: string;
  cols: number;
  rows: number;
  cells: Cell[][];
}

// The renderer reports channels as 0..1 floats; older builds used 0..255.
function toHex(color: Rgba): string {
  const channel = (value: number) =>
    Math.round((value <= 1 ? value : value / 255) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

async function capture(label: string, spec: string): Promise<Shot> {
  const flags = readFlags(spec.split(/\s+/).filter(Boolean));

  const setup = await testRender(
    <App
      provider={mockUsageProvider}
      startup={startupFromFlags(flags)}
    />,
    {
      width: Number(flags.get("width") ?? DEFAULT_WIDTH),
      height: Number(flags.get("height") ?? DEFAULT_HEIGHT),
    },
  );

  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, INPUT_SETTLE_MS));
    await setup.flush();
  };
  try {
    await settle();

    for (const key of (flags.get("keys") ?? "").split(",").filter(Boolean)) {
      if (key === "ENTER") setup.mockInput.pressEnter();
      else if (key === "TAB") setup.mockInput.pressTab();
      else if (key === "ESC") setup.mockInput.pressEscape();
      else if (key === "SPACE") setup.mockInput.pressKey(" ");
      else setup.mockInput.pressKey(key);
      await settle();
    }

    const frame = setup.captureSpans();
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const cells = frame.lines.map((line) => {
      const row: Cell[] = [];
      for (const span of line.spans) {
        const fg = toHex(span.fg as unknown as Rgba);
        const bg = toHex(span.bg as unknown as Rgba);
        const bold = (span.attributes & 1) !== 0;
        for (const { segment } of segmenter.segment(span.text)) {
          const cellWidth = Math.max(1, Bun.stringWidth(segment));
          row.push({ ch: segment, fg, bg, bold });
          for (let column = 1; column < cellWidth; column++) row.push({ ch: "", fg, bg, bold });
        }
      }
      return row;
    });

    return { label, note: spec, cols: frame.cols, rows: frame.rows, cells };
  } finally {
    setup.renderer.destroy();
  }
}

// React's act() advisory is noise here - this harness drives real input.
const reportError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("act(...)")) return;
  reportError(...args);
};

const [, , outPath, ...specs] = process.argv;
if (!outPath) throw new Error("usage: bun run shot <out.html> \"label:--flags\" ...");

const shots: Shot[] = [];
for (const spec of specs) {
  const separator = spec.indexOf(":");
  const label = separator === -1 ? spec : spec.slice(0, separator);
  shots.push(await capture(label, separator === -1 ? "" : spec.slice(separator + 1)));
}

const PAGE = `<!doctype html><meta charset="utf-8">
<style>
 body{margin:0;padding:20px;background:${COLORS.bg};font-family:ui-sans-serif,system-ui}
 h2{color:${COLORS.textBright};font-size:13px;font-weight:600;margin:22px 0 6px}
 h2 small{color:${COLORS.textMuted};font-weight:400}
 canvas{display:block}
</style>
<div id="out"></div>
<script>
const SHOTS = __SHOTS__;
const CW = 10, CH = 20;   // even, so quadrant fills land on whole pixels
// Block-drawing glyphs as [x, y, x2, y2] fractions of one cell.
const RECTS = {
  "\\u2588":[0,0,1,1], "\\u2580":[0,0,1,.5], "\\u2584":[0,.5,1,1], "\\u2590":[.5,0,1,1],
  "\\u2581":[0,.875,1,1], "\\u2582":[0,.75,1,1], "\\u2583":[0,.625,1,1],
  "\\u2585":[0,.375,1,1], "\\u2586":[0,.25,1,1], "\\u2587":[0,.125,1,1],
  "\\u258f":[0,0,.125,1], "\\u258e":[0,0,.25,1], "\\u258d":[0,0,.375,1], "\\u258c":[0,0,.5,1]
};
// Quadrant glyphs as a 4-bit mask: 1 upper-left, 2 upper-right, 4 lower-left, 8 lower-right.
const QUADS = {
  "\\u2598":1, "\\u259d":2, "\\u2596":4, "\\u2597":8, "\\u259a":9,
  "\\u259e":6, "\\u259b":7, "\\u259c":11, "\\u2599":13, "\\u259f":14
};
const LINES = {"\\u2500":"h","\\u2502":"v","\\u250c":"tl","\\u2510":"tr","\\u2514":"bl","\\u2518":"br"};
for (const shot of SHOTS) {
  const heading = document.createElement("h2");
  heading.textContent = shot.label + ' ';
  const details = document.createElement("small");
  details.textContent = shot.note + ' \\u00b7 ' + shot.cols + '\\u00d7' + shot.rows;
  heading.append(details);
  const canvas = document.createElement("canvas");
  canvas.width = shot.cols * CW;
  canvas.height = shot.rows * CH;
  const g = canvas.getContext("2d");
  g.fillStyle = "${COLORS.bg}";
  g.fillRect(0, 0, canvas.width, canvas.height);
  shot.cells.forEach((row, y) => row.forEach((cell, x) => {
    const px = x * CW, py = y * CH;
    g.fillStyle = cell.bg;
    g.fillRect(px, py, CW, CH);
    const rect = RECTS[cell.ch];
    if (rect) {
      g.fillStyle = cell.fg;
      g.fillRect(px + rect[0]*CW, py + rect[1]*CH, (rect[2]-rect[0])*CW, (rect[3]-rect[1])*CH);
      return;
    }
    const quad = QUADS[cell.ch];
    if (quad !== undefined) {
      g.fillStyle = cell.fg;
      if (quad & 1) g.fillRect(px, py, CW/2, CH/2);
      if (quad & 2) g.fillRect(px + CW/2, py, CW/2, CH/2);
      if (quad & 4) g.fillRect(px, py + CH/2, CW/2, CH/2);
      if (quad & 8) g.fillRect(px + CW/2, py + CH/2, CW/2, CH/2);
      return;
    }
    const line = LINES[cell.ch];
    if (line) {
      g.fillStyle = cell.fg;
      if (line !== "v") {
        const x0 = line === "tl" || line === "bl" ? px + CW/2 : px;
        g.fillRect(x0, py + CH/2 - 1, line === "h" ? CW : CW/2, 1.5);
      }
      if (line !== "h") {
        const y0 = line === "tl" || line === "tr" ? py + CH/2 : py;
        g.fillRect(px + CW/2 - 1, y0, 1.5, line === "v" ? CH : CH/2);
      }
      return;
    }
    if (cell.ch === " ") return;
    g.fillStyle = cell.fg;
    g.font = (cell.bold ? "bold " : "") + "14px 'JetBrains Mono', Menlo, monospace";
    g.fillText(cell.ch, px, py + CH - 5);
  }));
  document.getElementById("out").append(heading, canvas);
}
</script>`;

const serializedShots = JSON.stringify(shots).replaceAll("<", "\\u003c");
await Bun.write(outPath, PAGE.replace("__SHOTS__", serializedShots));
console.log(`wrote ${outPath}`);
