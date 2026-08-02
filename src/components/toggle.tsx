import { COLORS } from "../theme";
import type { Segment } from "./primitives";

export interface ToggleOption<T> {
  label: string;
  value: T;
}

export function toggleSegments<T>(
  options: ToggleOption<T>[],
  current: T,
  onSelect: (value: T) => void,
): Segment[] {
  const segments: Segment[] = [];

  options.forEach((option, index) => {
    if (index > 0) segments.push({ text: " " });
    const isActive = option.value === current;
    segments.push({
      text: ` ${option.label} `,
      color: isActive ? COLORS.bg : COLORS.textSoft,
      background: isActive ? COLORS.accent : COLORS.bgChip,
      isBold: isActive,
      onClick: () => onSelect(option.value),
    });
  });

  return segments;
}

/** The single-key shortcut chip that sits beside a toggle, e.g. `m` or `w`. */
export function toggleChip(key: string, onClick: () => void): Segment[] {
  return [
    { text: "  " },
    { text: ` ${key} `, color: COLORS.textSoft, background: COLORS.bgChip, onClick },
  ];
}
