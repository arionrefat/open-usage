import { BLOCK_RAMP, COLORS } from "../theme";

export interface ChartSegment {
  text: string;
  color: string;
  /** Set when a cell packs two sub-rows into one half-block glyph. */
  background?: string;
}

export interface ChartRow {
  segments: ChartSegment[];
}

interface Cell {
  char: string;
  color: string;
  background?: string;
}

/** Collapses adjacent same-styled cells so a row renders as few spans. */
function mergeCells(cells: Cell[]): ChartSegment[] {
  const segments: ChartSegment[] = [];
  for (const cell of cells) {
    const last = segments[segments.length - 1];
    if (last && last.color === cell.color && last.background === cell.background) {
      last.text += cell.char;
    } else {
      segments.push({ text: cell.char, color: cell.color, background: cell.background });
    }
  }
  return segments;
}

/** Linearly resamples a series onto exactly `width` columns. */
export function resample(values: number[], width: number): number[] {
  if (width <= 0) return [];
  if (values.length === width) return values.slice();
  if (values.length === 0) return new Array(width).fill(0);
  if (values.length === 1 || width === 1) return new Array(width).fill(values[0] ?? 0);

  const out: number[] = [];
  for (let i = 0; i < width; i++) {
    const x = (i * (values.length - 1)) / (width - 1);
    const lower = Math.floor(x);
    const upper = Math.min(values.length - 1, lower + 1);
    const a = values[lower] ?? 0;
    const b = values[upper] ?? 0;
    out.push(a + (b - a) * (x - lower));
  }
  return out;
}

/**
 * Solid bar chart, one bar per data point. Bar widths are distributed so the
 * chart spans exactly `width` columns; zero values leave a blank column.
 */
export function bars(values: number[], width: number, height: number, color: string): ChartRow[] {
  if (width <= 0 || height <= 0) return [];
  const points = values.length > width ? resample(values, width) : values;
  const count = points.length;
  if (count === 0) {
    return Array.from({ length: height }, () => ({
      segments: [{ text: " ".repeat(width), color: COLORS.bg }],
    }));
  }

  const baseWidth = Math.max(1, Math.floor(width / count));
  const extra = Math.max(0, width - baseWidth * count);
  const barWidths = points.map(
    (_, i) => baseWidth + (Math.floor(((i + 1) * extra) / count) - Math.floor((i * extra) / count)),
  );
  const max = Math.max(1, ...points);
  const rows: ChartRow[] = [];

  for (let row = 0; row < height; row++) {
    const cells: Cell[] = [];
    points.forEach((value, i) => {
      const filled = value > 0 ? Math.max(1, Math.round((value / max) * height)) : 0;
      const isOn = row >= height - filled;
      const cell: Cell = { char: isOn ? "█" : " ", color: isOn ? color : COLORS.bg };
      for (let z = 0; z < (barWidths[i] ?? 0); z++) cells.push(cell);
    });
    rows.push({ segments: mergeCells(cells) });
  }
  return rows;
}

export interface PlanChartItem {
  /** null renders a zero-height bar with a dimmed label and an em-dash value. */
  value: number | null;
  color: string;
  label: string;
}

export interface PlanChartLabel {
  text: string;
  color: string;
}

export interface PlanChart {
  rows: ChartRow[];
  baseline: string;
  names: PlanChartLabel[];
  values: PlanChartLabel[];
  /** Total column footprint including the tick gutter. */
  width: number;
}

const PLAN_HEIGHT = 10;
const PLAN_BAR_WIDTH = 8;
const PLAN_GAP = 5;
const PLAN_LEFT_PAD = 5;
const PLAN_TICK_WIDTH = 5;

function centerPad(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  return " ".repeat(left) + text + " ".repeat(Math.max(0, width - text.length - left));
}

/** Fixed-geometry percent chart: 10 rows, 8-wide bars, 5-wide gaps, % ticks. */
export function planChart(items: PlanChartItem[]): PlanChart {
  const rows: ChartRow[] = [];
  for (let row = 0; row < PLAN_HEIGHT; row++) {
    const cells: Cell[] = [];
    items.forEach((item, i) => {
      if (i) for (let z = 0; z < PLAN_GAP; z++) cells.push({ char: " ", color: COLORS.bg });
      const filled =
        item.value === null
          ? 0
          : item.value > 0
            ? Math.max(1, Math.round((item.value / 100) * PLAN_HEIGHT))
            : 0;
      const isOn = row >= PLAN_HEIGHT - filled;
      const cell: Cell = { char: isOn ? "█" : " ", color: isOn ? item.color : COLORS.bg };
      for (let z = 0; z < PLAN_BAR_WIDTH; z++) cells.push(cell);
    });
    const tick = row === 0 ? "100" : row === Math.round(PLAN_HEIGHT / 2) - 1 ? " 50" : "   ";
    rows.push({
      segments: [{ text: `${tick} │`, color: COLORS.textDisabled }, ...mergeCells(cells)],
    });
  }

  const names: PlanChartLabel[] = [];
  const values: PlanChartLabel[] = [];
  items.forEach((item, i) => {
    const gap = " ".repeat(i ? PLAN_GAP : PLAN_LEFT_PAD);
    names.push({
      text: gap + centerPad(item.label, PLAN_BAR_WIDTH),
      color: item.value === null ? COLORS.textGhost : COLORS.textMuted,
    });
    values.push({
      text: gap + centerPad(item.value === null ? "—" : `${item.value}%`, PLAN_BAR_WIDTH),
      color: item.value === null ? COLORS.textGhost : item.color,
    });
  });

  const plotWidth = items.length * PLAN_BAR_WIDTH + Math.max(0, items.length - 1) * PLAN_GAP;
  return {
    rows,
    baseline: `  0 └${"─".repeat(plotWidth)}`,
    names,
    values,
    width: PLAN_TICK_WIDTH + plotWidth,
  };
}

/** Single-line sparkline using the eighth-block ramp. */
export function sparkline(values: number[], width: number): string {
  const max = Math.max(1, ...values);
  return resample(values, width)
    .map((value) => BLOCK_RAMP[Math.max(0, Math.min(8, Math.round((value / max) * 8)))])
    .join("");
}

/**
 * One 100%-stacked bar: each entry's share of the row's total. `char` defaults
 * to a half-height block so stacked rows keep a gap between them — a full block
 * would fuse consecutive rows into a single slab on terminals with no extra
 * line spacing.
 */
export function stackedBar(
  parts: Array<{ value: number; color: string }>,
  width: number,
  char = "▀",
): ChartSegment[] {
  if (width <= 0) return [];
  const values = parts.map((part) => Math.max(0, part.value));
  const total = sum(values);
  if (total <= 0) return [{ text: char.repeat(width), color: COLORS.track }];

  const cells: Cell[] = [];
  let used = 0;
  let cumulative = 0;
  parts.forEach((part, index) => {
    cumulative += values[index] ?? 0;
    const boundary = index === parts.length - 1 ? width : Math.round((cumulative / total) * width);
    const cellCount = Math.max(0, boundary - used);
    used += cellCount;
    for (let i = 0; i < cellCount; i++) cells.push({ char, color: part.color });
  });
  return mergeCells(cells);
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Token counts are held in millions; roll over to billions past 1000M and down
 * to thousands below 1M so light providers never read as a flat "0M".
 */
export function formatTokens(millions: number): string {
  if (millions >= 1000) return `${(millions / 1000).toFixed(2)}B`;
  if (millions >= 1) return `${Math.round(millions)}M`;
  if (millions <= 0) return "0";
  const thousands = millions * 1000;
  return thousands >= 1 ? `${Math.round(thousands)}K` : "<1K";
}
