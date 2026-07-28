import { COLORS, THRESHOLDS } from "../theme";

export interface Meter {
  fill: string;
  track: string;
  /** Color of the filled portion. */
  color: string;
  percentLabel: string;
  /** Color of the numeric readout — always severity-driven when past a threshold. */
  percentColor: string;
}

function severityColor(percent: number): string | null {
  if (percent >= THRESHOLDS.danger) return COLORS.danger;
  if (percent >= THRESHOLDS.warn) return COLORS.warn;
  return null;
}

/**
 * Builds a block-character meter. With `useSeverityColors` the bar ignores the
 * provider's brand color and reads green/amber/red instead.
 */
export function buildMeter(
  percent: number,
  width: number,
  accentColor: string,
  useSeverityColors = false,
): Meter {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const severity = severityColor(clamped);
  return {
    fill: "█".repeat(filled),
    track: "█".repeat(width - filled),
    color: useSeverityColors ? (severity ?? COLORS.ok) : (severity ?? accentColor),
    percentLabel: `${clamped}%`,
    percentColor: severity ?? accentColor,
  };
}

/** An empty meter, used when a provider publishes no cap or is disconnected. */
export function emptyMeter(width: number): Meter {
  return {
    fill: "",
    track: "█".repeat(width),
    color: COLORS.track,
    percentLabel: "—",
    percentColor: COLORS.textDisabled,
  };
}
