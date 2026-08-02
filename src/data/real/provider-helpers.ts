import { formatTokens } from "../../lib/chart";
import { COLORS } from "../../theme";
import type { BurnRate, UsageLimit } from "../types";
import { formatCountdown, formatRate } from "./aggregate";

const NO_CAP_DATA = "no cap data";

export function capLessLimit(
  id: string,
  label: string,
  detailLabel: string,
  note: string,
  footnote: string,
): UsageLimit {
  return {
    id,
    label,
    detailLabel,
    percent: null,
    valueLabel: "n/a",
    valueColor: COLORS.textGhost,
    reset: note,
    footnote,
  };
}

export function resetText(resetsAtMs: number | null, nowMs: number): string {
  return resetsAtMs !== null ? `resets in ${formatCountdown(resetsAtMs - nowMs)}` : "reset unknown";
}

/** Like formatTokens but keeps sub-million counts readable ("442K", "1.9M"). */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 10_000_000) return formatTokens(tokens / 1_000_000);
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${Math.round(tokens)}`;
}

export function localBurn(rate: number): BurnRate {
  return {
    limit: "local burn only",
    timeToReset: NO_CAP_DATA,
    rate: formatRate(rate),
    projectedPercent: 0,
    capsOutAt: NO_CAP_DATA,
  };
}

export { NO_CAP_DATA };
