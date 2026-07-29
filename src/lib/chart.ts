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
 * Filled area chart. The topmost filled row of each column keeps the accent
 * color, everything below it drops to `dimColor` so the silhouette reads.
 */
export function areaChart(
  values: number[],
  width: number,
  height: number,
  color: string,
  dimColor: string,
): ChartRow[] {
  const columns = resample(values, width);
  const max = Math.max(1, ...values);
  const rows: ChartRow[] = [];

  for (let row = 0; row < height; row++) {
    const cells: Cell[] = [];
    for (let i = 0; i < width; i++) {
      const filled = ((columns[i] ?? 0) / max) * height;
      const top = height - Math.ceil(filled);
      const level = filled - (height - 1 - row);
      if (level >= 1) cells.push({ char: "█", color: row === top ? color : dimColor });
      else if (level > 0.06) cells.push({ char: BLOCK_RAMP[Math.max(1, Math.round(level * 8))]!, color });
      else cells.push({ char: " ", color: COLORS.bg });
    }
    rows.push({ segments: mergeCells(cells) });
  }
  return rows;
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

/** Token counts are held in millions; roll over to billions past 1000M. */
export function formatTokens(millions: number): string {
  return millions >= 1000 ? `${(millions / 1000).toFixed(2)}B` : `${Math.round(millions)}M`;
}
