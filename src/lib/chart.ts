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

export interface ChartLabel {
  /** Zero-based column offset in the chart row. */
  offset: number;
  text: string;
  color: string;
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

/** Resamples a series onto exactly `targetWidth` columns without erasing peaks. */
function resampleIntoBuckets(values: number[], targetWidth: number): number[] {
  if (targetWidth <= 0) return [];
  if (values.length === targetWidth) return values.slice();
  if (values.length === 0) return new Array(targetWidth).fill(0);
  if (targetWidth === 1) return [Math.max(0, ...values)];
  if (values.length === 1) return new Array(targetWidth).fill(Math.max(0, values[0] ?? 0));
  if (targetWidth > values.length) {
    return Array.from(
      { length: targetWidth },
      (_, index) => values[Math.min(values.length - 1, Math.floor((index * values.length) / targetWidth))] ?? 0,
    );
  }

  const buckets: number[] = [];
  for (let bucketIndex = 0; bucketIndex < targetWidth; bucketIndex++) {
    const start = Math.floor((bucketIndex * values.length) / targetWidth);
    const end = Math.floor(((bucketIndex + 1) * values.length) / targetWidth);
    buckets.push(Math.max(0, ...values.slice(start, end)));
  }
  return buckets;
}

function filledRowCount(value: number, maximum: number, height: number): number {
  if (value <= 0) return 0;
  return Math.max(1, Math.round((value / maximum) * height));
}

interface BarLayout {
  points: number[];
  barWidths: number[];
  maximum: number;
}

function barLayout(values: number[], width: number): BarLayout {
  if (width <= 0) return { points: [], barWidths: [], maximum: 1 };
  const points = values.length > width ? resampleIntoBuckets(values, width) : values;
  const count = points.length;
  if (count === 0) return { points, barWidths: [], maximum: 1 };

  const baseWidth = Math.max(1, Math.floor(width / count));
  const extra = Math.max(0, width - baseWidth * count);
  const barWidths = points.map(
    (_, i) => baseWidth + (Math.floor(((i + 1) * extra) / count) - Math.floor((i * extra) / count)),
  );
  return { points, barWidths, maximum: Math.max(1, ...points) };
}

const GUIDE_FRACTIONS = [0.25, 0.5, 0.75] as const;
const ZERO_GLYPH = "▁";

function guideRows(height: number): Set<number> {
  return new Set(
    GUIDE_FRACTIONS.map((fraction) => height - 1 - Math.round(height * fraction)).filter(
      (row) => row > 0 && row < height - 1,
    ),
  );
}

/**
 * Solid bar chart, one bar per data point. Bar widths are distributed so the
 * chart spans exactly `width` columns; zero values get a dim baseline marker.
 */
export function bars(values: number[], width: number, height: number, color: string): ChartRow[] {
  if (width <= 0 || height <= 0) return [];
  const { points, barWidths, maximum } = barLayout(values, width);
  const count = points.length;
  if (count === 0) {
    return Array.from({ length: height }, () => ({
      segments: [{ text: " ".repeat(width), color: COLORS.bg }],
    }));
  }

  const guides = guideRows(height);
  const rows: ChartRow[] = [];

  for (let row = 0; row < height; row++) {
    const cells: Cell[] = [];
    points.forEach((value, pointIndex) => {
      const filledRows = filledRowCount(value, maximum, height);
      const isOn = row >= height - filledRows;
      const cell: Cell = isOn
        ? { char: "█", color }
        : row === height - 1 && value <= 0
          ? { char: ZERO_GLYPH, color: COLORS.textInert }
          : guides.has(row)
            ? { char: "┄", color: COLORS.borderSoft }
            : { char: " ", color: COLORS.bg };
      const barWidth = barWidths[pointIndex] ?? 0;
      for (let column = 0; column < barWidth; column++) cells.push(cell);
    });
    rows.push({ segments: mergeCells(cells) });
  }
  return rows;
}

/**
 * Chooses non-overlapping value labels for the top of a bar chart.
 * Wide charts label every active point; narrow charts keep the highest points
 * and the latest active point so the label row stays readable.
 */
export function barLabels(
  values: number[],
  width: number,
  formatValue: (value: number) => string,
  color: string,
): ChartLabel[] {
  const { points, barWidths } = barLayout(values, width);
  if (points.length === 0) return [];

  const starts: number[] = [];
  let offset = 0;
  for (const barWidth of barWidths) {
    starts.push(offset);
    offset += barWidth;
  }

  const candidates = points
    .map((value, index) => ({ value, index, text: formatValue(value) }))
    .filter((candidate) => candidate.value > 0);
  if (candidates.length === 0) return [];

  const barWidth = barWidths[0] ?? 1;
  const latest = candidates.at(-1);
  const priority = barWidth >= 4
    ? candidates
    : [...candidates].sort((left, right) => right.value - left.value).slice(0, 4);
  if (latest && !priority.includes(latest)) priority.push(latest);

  const selected: ChartLabel[] = [];
  for (const candidate of priority) {
    const barStart = starts[candidate.index] ?? 0;
    const labelWidth = Bun.stringWidth(candidate.text);
    const labelStart = Math.max(
      0,
      Math.min(width - labelWidth, barStart + Math.floor((barWidth - labelWidth) / 2)),
    );
    const labelEnd = labelStart + labelWidth;
    const overlaps = selected.some((label) => {
      const otherEnd = label.offset + Bun.stringWidth(label.text);
      return labelStart < otherEnd && labelEnd > label.offset;
    });
    if (!overlaps) selected.push({ offset: labelStart, text: candidate.text, color });
  }
  return selected.sort((left, right) => left.offset - right.offset);
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

function planBarHeight(value: number | null): number {
  if (value === null || value <= 0) return 0;
  return Math.max(1, Math.round((value / 100) * PLAN_HEIGHT));
}

function planTick(row: number): string {
  if (row === 0) return "100";
  if (row === Math.round(PLAN_HEIGHT / 2) - 1) return " 50";
  return "   ";
}

/** Fixed-geometry percent chart: 10 rows, 8-wide bars, 5-wide gaps, % ticks. */
export function planChart(items: PlanChartItem[]): PlanChart {
  const rows: ChartRow[] = [];
  for (let row = 0; row < PLAN_HEIGHT; row++) {
    const cells: Cell[] = [];
    items.forEach((item, i) => {
      if (i) for (let z = 0; z < PLAN_GAP; z++) cells.push({ char: " ", color: COLORS.bg });
      const filled = planBarHeight(item.value);
      const isOn = row >= PLAN_HEIGHT - filled;
      const cell: Cell = { char: isOn ? "█" : " ", color: isOn ? item.color : COLORS.bg };
      for (let z = 0; z < PLAN_BAR_WIDTH; z++) cells.push(cell);
    });
    const tick = planTick(row);
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
      text: gap + centerPad(item.value === null ? "-" : `${item.value}%`, PLAN_BAR_WIDTH),
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
  const highestRampIndex = BLOCK_RAMP.length - 1;
  return resampleIntoBuckets(values, width)
    .map((value) => {
      if (value <= 0) return BLOCK_RAMP[1] ?? "▁";
      const scaledRampIndex = Math.round((value / max) * highestRampIndex);
      const rampIndex = Math.max(0, Math.min(highestRampIndex, scaledRampIndex));
      return BLOCK_RAMP[rampIndex];
    })
    .join("");
}

/**
 * One 100%-stacked bar: each entry's share of the row's total. `char` defaults
 * to a half-height block so stacked rows keep a gap between them - a full block
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
