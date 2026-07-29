/**
 * Column width of a string. Delegates to Bun's wcwidth so a wide glyph added
 * later cannot silently shift a whole row out of alignment.
 */
export function columnWidth(value: string): number {
  return Bun.stringWidth(value);
}

export function padEnd(value: string, width: number): string {
  const diff = width - columnWidth(value);
  return diff > 0 ? value + " ".repeat(diff) : value;
}

export function padStart(value: string, width: number): string {
  const diff = width - columnWidth(value);
  return diff > 0 ? " ".repeat(diff) + value : value;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Clips `value` to `width` columns, marking the cut with an ellipsis. */
export function truncate(value: string, width: number): string {
  if (columnWidth(value) <= width) return value;
  if (width <= 0) return "";
  if (width === 1) return "…";
  let kept = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    if (columnWidth(kept + segment) > width - 1) break;
    kept += segment;
  }
  return `${kept}…`;
}
