import { COLORS } from "../theme";
import type { Segment } from "./primitives";

export interface ToggleOption<T> {
  label: string;
  value: T;
}

/**
 * The design draws a segmented control as a rounded, outlined capsule holding
 * two pills. A cell grid has neither rounded corners nor hairline borders, so
 * the capsule is carried by an unbroken background instead: the padding either
 * side and the gap between pills share the container colour, which is what makes
 * the group read as one control rather than two floating labels.
 */
export function toggleSegments<T>(
  options: ToggleOption<T>[],
  current: T,
  activeBackground: string,
  onSelect: (value: T) => void,
): Segment[] {
  const pad: Segment = { text: " ", background: COLORS.bgRowActive };
  const segments: Segment[] = [pad];

  options.forEach((option, index) => {
    if (index > 0) segments.push(pad);
    const isActive = option.value === current;
    segments.push({
      text: ` ${option.label} `,
      color: isActive ? COLORS.bg : COLORS.textSoft,
      background: isActive ? activeBackground : COLORS.bgRowActive,
      isBold: true,
      onClick: () => onSelect(option.value),
    });
  });

  segments.push(pad);
  return segments;
}

/** The single-key shortcut chip that sits beside a toggle, e.g. `m` or `w`. */
export function toggleChip(key: string, onClick: () => void): Segment[] {
  return [
    { text: "  " },
    { text: ` ${key} `, color: COLORS.textSoft, background: COLORS.bgChip, onClick },
  ];
}
