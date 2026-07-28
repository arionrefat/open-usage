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

/**
 * Hole radius as a share of the ring's. Matches the design's CSS mask, whose
 * `transparent 45%` of a farthest-corner gradient resolves to 0.45 * √2.
 */
export const DONUT_INNER_RADIUS = 0.636;

/**
 * Quadrant glyphs indexed by a 4-bit mask of which sub-cells the foreground
 * paints: 1 upper-left, 2 upper-right, 4 lower-left, 8 lower-right.
 */
const QUADRANT_GLYPHS = [
  " ", "▘", "▝", "▀",
  "▖", "▌", "▞", "▛",
  "▗", "▚", "▐", "▜",
  "▄", "▙", "▟", "█",
] as const;

/**
 * Folds four sub-cell colours into one cell. A cell carries only a foreground
 * and a background, so the two most common colours win and a rarer third — which
 * only arises where two slices meet — is drawn as the foreground.
 */
function packQuadrants(samples: string[]): Cell {
  const counts = new Map<string, number>();
  for (const sample of samples) counts.set(sample, (counts.get(sample) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([color]) => color);
  const color = ranked[0] ?? COLORS.bg;
  const background = ranked[1] ?? color;

  let mask = 0;
  samples.forEach((sample, index) => {
    if (sample !== background) mask |= 1 << index;
  });
  return { char: QUADRANT_GLYPHS[mask] ?? " ", color, background };
}

/**
 * Character-cell donut chart. Each cell is sampled as a 2x2 grid and drawn with
 * a quadrant glyph, which halves the horizontal step of the ring's edge against
 * the one sample per column a half-block allows. `values` and `colors` are
 * index-aligned.
 */
export function donutChart(
  values: number[],
  colors: string[],
  width: number,
  height: number,
): ChartRow[] {
  // Measured in half-cell widths, where a sub-cell is 1 unit wide and 2 tall.
  const sampleColumns = width * 2;
  const sampleRows = height * 2;
  const centerX = (sampleColumns - 1) / 2;
  const centerY = sampleRows - 1;
  const radius = Math.min(centerX, centerY);
  const total = values.reduce((a, b) => a + b, 0);

  const cumulative: number[] = [];
  let running = 0;
  for (const value of values) {
    running += value;
    cumulative.push(running);
  }

  const sampleColor = (sampleX: number, sampleY: number): string => {
    const nx = (sampleX - centerX) / radius;
    const ny = (sampleY * 2 - centerY) / radius;
    const distance = Math.sqrt(nx * nx + ny * ny);
    if (distance > 1 || distance < DONUT_INNER_RADIUS) return COLORS.bg;
    if (total <= 0) return COLORS.track;

    let angle = Math.atan2(nx, -ny);
    if (angle < 0) angle += Math.PI * 2;
    const position = (angle / (Math.PI * 2)) * total;
    let index = 0;
    while (index < cumulative.length - 1 && position > (cumulative[index] ?? 0)) index++;
    return colors[index] ?? COLORS.track;
  };

  const rows: ChartRow[] = [];
  for (let row = 0; row < height; row++) {
    const cells: Cell[] = [];
    for (let column = 0; column < width; column++) {
      const x = column * 2;
      const y = row * 2;
      cells.push(
        packQuadrants([
          sampleColor(x, y),
          sampleColor(x + 1, y),
          sampleColor(x, y + 1),
          sampleColor(x + 1, y + 1),
        ]),
      );
    }
    rows.push({ segments: mergeCells(cells) });
  }
  return rows;
}

/** Single-line sparkline using the eighth-block ramp. */
export function sparkline(values: number[], width: number): string {
  const max = Math.max(1, ...values);
  return resample(values, width)
    .map((value) => BLOCK_RAMP[Math.max(1, Math.round((value / max) * 8))])
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
  const total = parts.reduce((a, p) => a + p.value, 0);
  const cells: Cell[] = [];
  let used = 0;
  parts.forEach((part, index) => {
    const isLast = index === parts.length - 1;
    const cellCount = isLast ? width - used : Math.round((part.value / (total || 1)) * width);
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
