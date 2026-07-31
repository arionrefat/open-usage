/** Palette lifted verbatim from the Usage Limits TUI design. */
export const COLORS = {
  bg: "#0b0b0b",
  bgChrome: "#0e0e0e",
  bgFilter: "#111111",
  bgRowActive: "#151515",
  bgTabActive: "#232323",
  bgTabIdle: "#131313",
  bgInput: "#131313",
  bgChip: "#1c1c1c",
  borderChip: "#2f2f2f",
  border: "#1b1b1b",
  borderSoft: "#141414",
  borderPanel: "#262626",
  /** Horizontal rules need a touch more contrast than a 1px CSS border. */
  divider: "#242424",
  track: "#1e1e1e",
  rule: "#2e2e2e",
  textBright: "#f0f0f0",
  text: "#cfcfcf",
  textMuted: "#9a9a9a",
  textSoft: "#8a8a8a",
  textDim: "#6b6b6b",
  textFaint: "#5c5c5c",
  textGhost: "#4f4f4f",
  textDisabled: "#3d3d3d",
  textInert: "#3a3a3a",
  markIdle: "#232323",
  /** Dot separators between the footer key hints. */
  footerSeparator: "#2a2a2a",
  accent: "#e0a244",
  info: "#4c8dff",
  ok: "#3fb950",
  warn: "#d29922",
  danger: "#f0483e",
  noticeBorder: "#2f2a1a",
  noticeBg: "#16130b",
} as const;

/** A bar turns amber past WARN and red past DANGER. */
export const THRESHOLDS = { warn: 70, danger: 85 } as const;

export const PROVIDER_COLORS = {
  cl: COLORS.accent,
  cx: COLORS.ok,
  go: COLORS.info,
} as const;

export const BLOCK_RAMP = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export const SPINNER_FRAMES = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"] as const;
