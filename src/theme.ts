/** Tokyo Night palette with interpolated structural shades. */
export const COLORS = {
  bg: "#1a1b26",
  bgChrome: "#16161e",
  bgFilter: "#212435",
  bgRowActive: "#283457",
  bgTabActive: "#292e42",
  bgTabIdle: "#232738",
  bgInput: "#232738",
  bgChip: "#282d40",
  borderChip: "#3f4769",
  border: "#282c3d",
  borderSoft: "#232638",
  borderPanel: "#363d57",
  /** Horizontal rules need a touch more contrast than a 1px CSS border. */
  divider: "#343b54",
  track: "#2c3146",
  rule: "#3d455f",
  textBright: "#c0caf5",
  text: "#a9b1d6",
  textMuted: "#737aa2",
  textSoft: "#697196",
  textDim: "#60698e",
  textFaint: "#565f89",
  textGhost: "#545c7e",
  textDisabled: "#414868",
  textInert: "#3b4261",
  markIdle: "#292e42",
  /** Dot separators between the footer key hints. */
  footerSeparator: "#39415b",
  accent: "#7aa2f7",
  info: "#7dcfff",
  ok: "#9ece6a",
  warn: "#e0af68",
  danger: "#f7768e",
  noticeBorder: "#2f3955",
  noticeBg: "#1e2331",
} as const;

/** A bar turns yellow past WARN and red past DANGER. */
export const THRESHOLDS = { warn: 70, danger: 85 } as const;

export const PROVIDER_COLORS = {
  cl: "#ff9e64",
  cx: COLORS.ok,
  go: "#7aa2f7",
} as const;

export const BLOCK_RAMP = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export const SPINNER_FRAMES = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"] as const;
