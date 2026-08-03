import { COLORS, THRESHOLDS } from "../theme";

export interface Meter {
  fill: string;
  track: string;
  /** Color of the filled portion. */
  color: string;
  percentLabel: string;
  /** Color of the numeric readout - always severity-driven when past a threshold. */
  percentColor: string;
}

function severityColor(percent: number, dangerThreshold: number): string | null {
  if (percent >= dangerThreshold) return COLORS.danger;
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
  dangerThreshold: number = THRESHOLDS.danger,
): Meter {
  const meterWidth = Math.max(0, Math.floor(width));
  const value = Number.isFinite(percent) ? Math.max(0, percent) : 0;
  const clamped = Math.min(100, value);
  const filled = Math.round((clamped / 100) * meterWidth);
  const severity = severityColor(value, dangerThreshold);
  return {
    fill: "█".repeat(filled),
    track: "█".repeat(meterWidth - filled),
    color: useSeverityColors ? (severity ?? COLORS.ok) : (severity ?? accentColor),
    percentLabel: `${Math.round(value)}%`,
    percentColor: severity ?? accentColor,
  };
}

/** An empty meter, used when a provider publishes no cap or is disconnected. */
export function emptyMeter(width: number): Meter {
  const meterWidth = Math.max(0, Math.floor(width));
  return {
    fill: "",
    track: "█".repeat(meterWidth),
    color: COLORS.track,
    percentLabel: "-",
    percentColor: COLORS.textDisabled,
  };
}
