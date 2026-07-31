export interface CodexLimits {
  weeklyPercent: number;
  resetsAtMs: number | null;
}

/**
 * Seam for the codex limits poller. A network-backed implementation lands
 * once the endpoint is verified; until then the stub keeps percents null.
 */
export interface CodexLimitsSource {
  read(): CodexLimits | null;
  /** Shown wherever a percent would have been. */
  note: string;
}

export const stubCodexLimitsSource: CodexLimitsSource = {
  read: () => null,
  note: "limits api not yet connected",
};
