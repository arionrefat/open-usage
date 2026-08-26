import { BLOCK_RAMP, COLORS } from "../theme";
import { truncate } from "./text";

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
  /** Zero-based row offset, including the reserved row above the plot. */
  row: number;
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

function filledEighthCount(value: number, maximum: number, height: number): number {
  if (value <= 0) return 0;
  return Math.max(1, Math.min(height * 8, Math.round((value / maximum) * height * 8)));
}

interface BarLayout {
  points: number[];
  fillWidth: number;
  gap: number;
  starts: number[];
  leftPadding: number;
  rightPadding: number;
  maximum: number;
}

function barLayout(values: number[], width: number): BarLayout {
  if (width <= 0) {
    return {
      points: [],
      fillWidth: 0,
      gap: 0,
      starts: [],
      leftPadding: 0,
      rightPadding: 0,
      maximum: 1,
    };
  }
  const points = values.length > width ? resampleIntoBuckets(values, width) : values;
  const count = points.length;
  if (count === 0) {
    return {
      points,
      fillWidth: 0,
      gap: 0,
      starts: [],
      leftPadding: 0,
      rightPadding: width,
      maximum: 1,
    };
  }

  const fillWithGap = Math.floor((width - (count - 1)) / count);
  const gap = fillWithGap >= 2 ? 1 : 0;
  let fillWidth = gap ? fillWithGap : Math.max(1, Math.floor(width / count));
  if (gap === 1 && fillWidth >= 6 && fillWidth % 2 === 0) fillWidth--;
  const usedWidth = count * fillWidth + (count - 1) * gap;
  const padding = Math.max(0, width - usedWidth);
  const leftPadding = Math.floor(padding / 2);
  const rightPadding = padding - leftPadding;
  const starts = points.map((_, index) => leftPadding + index * (fillWidth + gap));
  return {
    points,
    fillWidth,
    gap,
    starts,
    leftPadding,
    rightPadding,
    maximum: Math.max(1, ...points),
  };
}

const GUIDE_FRACTIONS = [0.25, 0.5, 0.75] as const;
const ZERO_GLYPH = "▁";

function barGlyph(value: number, maximum: number, height: number, row: number): string | null {
  const eighths = filledEighthCount(value, maximum, height);
  const fullRows = Math.floor(eighths / 8);
  const partial = eighths % 8;
  const rowFromBottom = height - 1 - row;
  if (rowFromBottom < fullRows) return "█";
  if (partial > 0 && rowFromBottom === fullRows) return BLOCK_RAMP[partial] ?? ZERO_GLYPH;
  return null;
}

function guideRows(height: number): Set<number> {
  return new Set(
    GUIDE_FRACTIONS.map((fraction) => height - 1 - Math.round(height * fraction)).filter(
      (row) => row > 0 && row < height - 1,
    ),
  );
}

/**
 * Solid bar chart, one uniformly sized bar per data point. Edge padding absorbs
 * leftover columns so the chart spans exactly `width`; zeroes mark the baseline.
 */
export function bars(values: number[], width: number, height: number, color: string): ChartRow[] {
  if (width <= 0 || height <= 0) return [];
  const { points, fillWidth, gap, leftPadding, rightPadding, maximum } = barLayout(values, width);
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
    const emptyCell: Cell = guides.has(row)
      ? { char: "┄", color: COLORS.borderSoft }
      : { char: " ", color: COLORS.bg };
    for (let column = 0; column < leftPadding; column++) cells.push(emptyCell);
    points.forEach((value, pointIndex) => {
      const glyph = barGlyph(value, maximum, height, row);
      const cell: Cell = glyph
        ? { char: glyph, color }
        : row === height - 1 && value <= 0
          ? { char: ZERO_GLYPH, color: COLORS.textInert }
          : emptyCell;
      for (let column = 0; column < fillWidth; column++) cells.push(cell);
      if (pointIndex < count - 1) {
        for (let column = 0; column < gap; column++) {
          cells.push({ char: " ", color: COLORS.bg });
        }
      }
    });
    for (let column = 0; column < rightPadding; column++) {
      cells.push(emptyCell);
    }
    rows.push({ segments: mergeCells(cells) });
  }
  return rows;
}

/**
 * Places up to five value labels immediately above their bars. The first row is
 * reserved above the plot; lower labels share the bar grid without covering it.
 */
export function barLabels(
  values: number[],
  width: number,
  height: number,
  formatValue: (value: number) => string,
  color: string,
): ChartLabel[] {
  const { points, fillWidth, starts, maximum } = barLayout(values, width);
  if (points.length === 0 || height <= 0) return [];

  const candidates = points
    .map((value, index) => ({ value, index, text: truncate(formatValue(value), width) }))
    .filter((candidate) => candidate.value > 0);
  if (candidates.length === 0) return [];

  const peak = candidates.reduce((highest, candidate) =>
    candidate.value > highest.value ? candidate : highest,
  );
  const latest = candidates.at(-1);
  const priority = [
    peak,
    ...(latest && latest !== peak ? [latest] : []),
    ...candidates
      .filter((candidate) => candidate !== peak && candidate !== latest)
      .sort((left, right) => right.value - left.value || right.index - left.index),
  ];

  const occupied = Array.from({ length: height + 1 }, () =>
    new Array<boolean>(width).fill(false),
  );
  for (let index = 0; index < points.length; index++) {
    const value = points[index] ?? 0;
    const start = starts[index] ?? 0;
    for (let row = 0; row < height; row++) {
      if (!barGlyph(value, maximum, height, row) && !(row === height - 1 && value <= 0)) continue;
      for (let column = start; column < start + fillWidth; column++) {
        const plotRow = occupied[row + 1];
        if (plotRow) plotRow[column] = true;
      }
    }
  }

  const selected: ChartLabel[] = [];
  for (const candidate of priority) {
    if (selected.length >= 5) break;
    const barStart = starts[candidate.index] ?? 0;
    const labelWidth = Bun.stringWidth(candidate.text);
    const labelStart = Math.max(
      0,
      Math.min(width - labelWidth, barStart + Math.floor((fillWidth - labelWidth) / 2)),
    );
    const labelEnd = labelStart + labelWidth;
    const capRow = height - Math.ceil(filledEighthCount(candidate.value, maximum, height) / 8);
    for (let row = capRow; row >= 0; row--) {
      const occupiedStart = Math.max(0, labelStart - 1);
      const occupiedEnd = Math.min(width, labelEnd + 1);
      const crossesBar = occupied[row]?.slice(occupiedStart, occupiedEnd).some(Boolean) ?? true;
      const crowdsLabel = selected.some((label) => {
        if (label.row !== row) return false;
        const otherEnd = label.offset + Bun.stringWidth(label.text);
        return labelStart <= otherEnd && label.offset <= labelEnd;
      });
      if (crossesBar || crowdsLabel) continue;
      selected.push({ offset: labelStart, row, text: candidate.text, color });
      break;
    }
  }
  return selected.sort((left, right) => left.row - right.row || left.offset - right.offset);
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

/**
 * Single-line sparkline using the eighth-block ramp.
 *
 * A single line has one colour, so zero and the smallest positive value can
 * only be told apart by glyph: zero takes the blank at the foot of the ramp and
 * anything positive takes at least one step above it. Rounding alone put small
 * values below zero's own glyph, which drew real activity as emptier than none.
 */
export function sparkline(values: number[], width: number): string {
  const max = Math.max(1, ...values);
  const highestRampIndex = BLOCK_RAMP.length - 1;
  return resampleIntoBuckets(values, width)
    .map((value) => {
      if (value <= 0) return BLOCK_RAMP[0] ?? " ";
      const scaledRampIndex = Math.round((value / max) * highestRampIndex);
      const rampIndex = Math.max(1, Math.min(highestRampIndex, scaledRampIndex));
      return BLOCK_RAMP[rampIndex];
    })
    .join("");
}

/** Blank columns marking the seam between two adjacent stacked segments. */
const STACK_GAP = 2;

/**
 * One 100%-stacked bar: each entry's share of the row's total. `char` defaults
 * to a half-height block so stacked rows keep a gap between them - a full block
 * would fuse consecutive rows into a single slab on terminals with no extra
 * line spacing.
 *
 * Each seam between segments is blanked out so the colours read as separate
 * runs. The gap is cut from the tail of the outgoing segment rather than added
 * to the row, which keeps the bar exactly `width` columns and leaves every
 * boundary where an ungapped bar would have put it.
 */
export function stackedBar(
  parts: Array<{ value: number; color: string }>,
  width: number,
  char = "▀",
  gap = STACK_GAP,
): ChartSegment[] {
  if (width <= 0) return [];
  // Whole columns only: the loops below count cells, so a fractional seam would
  // overrun the row and break the exactly-`width` guarantee.
  const seamGap = Number.isFinite(gap) ? Math.max(0, Math.floor(gap)) : 0;
  const values = parts.map((part) => Math.max(0, part.value));
  const total = sum(values);
  if (total <= 0) return [{ text: char.repeat(width), color: COLORS.track }];
  const lastActive = values.reduce((last, value, index) => (value > 0 ? index : last), -1);

  const cells: Cell[] = [];
  let used = 0;
  let cumulative = 0;
  parts.forEach((part, index) => {
    cumulative += values[index] ?? 0;
    const boundary = index === parts.length - 1 ? width : Math.round((cumulative / total) * width);
    const cellCount = Math.max(0, boundary - used);
    used += cellCount;
    // The trailing segment needs no seam, and no segment gives up its last column.
    const gapCells = index === lastActive ? 0 : Math.min(seamGap, Math.max(0, cellCount - 1));
    for (let i = 0; i < cellCount - gapCells; i++) cells.push({ char, color: part.color });
    for (let i = 0; i < gapCells; i++) cells.push({ char: " ", color: COLORS.bg });
  });
  return mergeCells(cells);
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export interface TokenDelta {
  text: string;
  direction: "up" | "down" | "flat";
}

/** Growth at or past this ratio reads better as a multiplier than a percentage. */
const DELTA_MULTIPLIER_RATIO = 4;

/**
 * Period-over-period change. Strong growth is stated as a multiplier, because a
 * near-silent prior window otherwise produces percentages like 803% that take
 * longer to read than "9.0x" and say no more. Returns null with nothing to
 * compare against.
 */
export function formatDelta(current: number, previous: number | null): TokenDelta | null {
  if (previous === null) return null;
  if (previous <= 0) return current > 0 ? { text: "new", direction: "up" } : null;
  const ratio = current / previous;
  if (ratio >= DELTA_MULTIPLIER_RATIO) {
    return { text: `${ratio.toFixed(ratio >= 100 ? 0 : 1)}x`, direction: "up" };
  }
  const percent = Math.round((ratio - 1) * 100);
  if (percent === 0) return { text: "flat", direction: "flat" };
  return { text: `${Math.abs(percent)}%`, direction: percent > 0 ? "up" : "down" };
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
