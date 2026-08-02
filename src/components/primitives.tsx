import { MouseButton, TextAttributes, type MouseEvent } from "@opentui/core";
import type { ChartRow } from "../lib/chart";
import { columnWidth, truncate } from "../lib/text";
import { COLORS } from "../theme";

/** Columns held between a split line's groups so they never read as one word. */
const MIN_GAP = 1;
/** Share of the width the left group may claim before the right group is cut. */
const LEFT_PRIORITY = 0.6;

export interface Segment {
  text: string;
  color?: string;
  background?: string;
  isBold?: boolean;
  /** Makes this segment's columns a left-click target. */
  onClick?: () => void;
}

interface HitRange {
  start: number;
  end: number;
  onClick: () => void;
}

function renderSegments(segments: Segment[], keyPrefix: string) {
  return segments.map((segment, index) => (
    <span
      key={`${keyPrefix}-${index}`}
      fg={segment.color ?? COLORS.text}
      bg={segment.background}
      attributes={segment.isBold ? TextAttributes.BOLD : undefined}
    >
      {segment.text}
    </span>
  ));
}

export function segmentsWidth(segments: Segment[]): number {
  return segments.reduce((acc, segment) => acc + columnWidth(segment.text), 0);
}

/** Clips a segment list to `width` columns, ellipsizing the one that straddles it. */
function fitSegments(segments: Segment[], width: number): Segment[] {
  if (width <= 0) return [];
  const fitted: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    const remaining = width - used;
    if (remaining <= 0) break;
    const segmentWidth = columnWidth(segment.text);
    if (segmentWidth <= remaining) {
      fitted.push(segment);
      used += segmentWidth;
      continue;
    }
    fitted.push({ ...segment, text: truncate(segment.text, remaining) });
    break;
  }
  return fitted;
}

interface SplitFit {
  left: Segment[];
  right: Segment[];
  gap: number;
}

/**
 * Keeps a split line on exactly one row of `width` columns. The right group
 * carries secondary readouts, so it gives up columns before the left is cut.
 */
function fitSplit(left: Segment[], right: Segment[], width: number): SplitFit {
  const gapCost = right.length > 0 ? MIN_GAP : 0;
  const leftWidth = segmentsWidth(left);
  const rightWidth = segmentsWidth(right);
  if (leftWidth + rightWidth + gapCost <= width) {
    return { left, right, gap: Math.max(0, width - leftWidth - rightWidth) };
  }

  const leftFloor = Math.min(leftWidth, Math.ceil(width * LEFT_PRIORITY));
  const fittedRight = fitSegments(right, Math.max(0, width - leftFloor - gapCost));
  const fittedRightWidth = segmentsWidth(fittedRight);
  const rightGap = fittedRight.length > 0 ? MIN_GAP : 0;
  const fittedLeft = fitSegments(left, Math.max(0, width - fittedRightWidth - rightGap));
  return {
    left: fittedLeft,
    right: fittedRight,
    gap: Math.max(0, width - segmentsWidth(fittedLeft) - fittedRightWidth),
  };
}

/** Maps each clickable segment onto the column range it occupies. */
function hitRanges(segments: Segment[], offset: number): HitRange[] {
  const ranges: HitRange[] = [];
  let start = offset;
  for (const segment of segments) {
    const end = start + columnWidth(segment.text);
    if (segment.onClick) ranges.push({ start, end, onClick: segment.onClick });
    start = end;
  }
  return ranges;
}

/**
 * Turns column ranges into a mouse handler. The event carries absolute
 * coordinates, so the target's own origin is subtracted to get the column.
 */
function clickHandler(ranges: HitRange[]) {
  if (ranges.length === 0) return undefined;
  return (event: MouseEvent) => {
    if (event.button !== MouseButton.LEFT || !event.target) return;
    const targetColumn = event.x - event.target.x;
    const hit = ranges.find(
      (range) => targetColumn >= range.start && targetColumn < range.end,
    );
    if (!hit) return;
    event.stopPropagation();
    hit.onClick();
  };
}

/** Wraps a plain callback as a left-click handler for a whole renderable. */
export function leftClick(onClick: () => void) {
  return (event: MouseEvent) => {
    if (event.button !== MouseButton.LEFT) return;
    event.stopPropagation();
    onClick();
  };
}

interface LineProps {
  segments: Segment[];
  background?: string;
  /** When set, the line is clipped to this many columns rather than wrapping. */
  width?: number;
}

/** A single styled line of text. */
export function Line({ segments, background, width }: LineProps) {
  const fitted = width === undefined ? segments : fitSegments(segments, width);
  return (
    <text bg={background} onMouseDown={clickHandler(hitRanges(fitted, 0))}>
      {renderSegments(fitted, "s")}
    </text>
  );
}

interface SplitLineProps {
  width: number;
  left: Segment[];
  right?: Segment[];
  background?: string;
  /** Character used for the gap; the design leaves it blank. */
  filler?: string;
}

/**
 * One line with `left` flush left and `right` flush right. The gap is computed
 * rather than flexed so column alignment stays exact in a monospace grid.
 */
export function SplitLine({ width, left, right = [], background, filler = " " }: SplitLineProps) {
  const fit = fitSplit(left, right, width);
  const rightWidth = segmentsWidth(fit.right);
  const rightStart = width - rightWidth;
  const ranges = [...hitRanges(fit.left, 0), ...hitRanges(fit.right, rightStart)];

  return (
    <text bg={background} onMouseDown={clickHandler(ranges)}>
      {renderSegments(fit.left, "l")}
      <span fg={COLORS.rule}>{filler.repeat(fit.gap)}</span>
      {renderSegments(fit.right, "r")}
    </text>
  );
}

interface TripleLineProps {
  width: number;
  left: Segment[];
  center: Segment[];
  right: Segment[];
}

/** Three groups spread across the width, matching the design's flex spacers. */
export function TripleLine({ width, left, center, right }: TripleLineProps) {
  // The centre readout is the first thing dropped; the axis ends matter more.
  if (segmentsWidth(left) + segmentsWidth(center) + segmentsWidth(right) + 2 > width) {
    return <SplitLine width={width} left={left} right={right} />;
  }

  const centerWidth = segmentsWidth(center);
  const rightWidth = segmentsWidth(right);
  const slack = Math.max(0, width - segmentsWidth(left) - centerWidth - rightWidth);
  const leftGap = Math.floor(slack / 2);
  const centerStart = segmentsWidth(left) + leftGap;
  const ranges = [
    ...hitRanges(left, 0),
    ...hitRanges(center, centerStart),
    ...hitRanges(right, width - rightWidth),
  ];

  return (
    <text onMouseDown={clickHandler(ranges)}>
      {renderSegments(left, "l")}
      <span>{" ".repeat(leftGap)}</span>
      {renderSegments(center, "c")}
      <span>{" ".repeat(slack - leftGap)}</span>
      {renderSegments(right, "r")}
    </text>
  );
}

interface ChartProps {
  rows: ChartRow[];
}

/** Renders pre-computed chart rows; each row is already run-length merged. */
export function Chart({ rows }: ChartProps) {
  return (
    <box flexDirection="column">
      {rows.map((row, rowIndex) => (
        <text key={`row-${rowIndex}`}>
          {row.segments.map((segment, index) => (
            <span key={`seg-${index}`} fg={segment.color} bg={segment.background}>
              {segment.text}
            </span>
          ))}
        </text>
      ))}
    </box>
  );
}

interface RuleProps {
  width: number;
  color?: string;
}

export function Rule({ width, color = COLORS.divider }: RuleProps) {
  return <text fg={color}>{"─".repeat(Math.max(0, width))}</text>;
}

export function Spacer({ height = 1 }: { height?: number }) {
  return <box height={height} flexShrink={0} />;
}

/** A boxed keyboard hint such as `j/k` or `space`. */
function keyCap(label: string, onClick?: () => void): Segment[] {
  return [{ text: ` ${label} `, color: COLORS.textSoft, background: COLORS.bgChip, onClick }];
}

export function keyHint(label: string, description: string, onClick?: () => void): Segment[] {
  return [...keyCap(label, onClick), { text: ` ${description}`, color: COLORS.textGhost, onClick }];
}
