/** Tokyo Night palette with interpolated structural shades. */
export const COLORS = {
  bg: "#16161e",
  bgChrome: "#1a1b26",
  bgFilter: "#1d1f2d",
  bgRowActive: "#202333",
  bgTabActive: "#292e42",
  bgTabIdle: "#1f2230",
  bgInput: "#1f2230",
  bgChip: "#242838",
  borderChip: "#3b4261",
  border: "#242735",
  borderSoft: "#1f2130",
  borderPanel: "#32384f",
  /** Horizontal rules need a touch more contrast than a 1px CSS border. */
  divider: "#30364c",
  track: "#282c3e",
  rule: "#394057",
  textBright: "#c0caf5",
  text: "#a9b1d6",
  textMuted: "#737aa2",
  textSoft: "#697196",
  textDim: "#60698e",
  textFaint: "#565f89",
  textGhost: "#545c7e",
  textDisabled: "#454d6c",
  textInert: "#3b4261",
  markIdle: "#292e42",
  /** Dot separators between the footer key hints. */
  footerSeparator: "#353b53",
  accent: "#ff9e64",
  info: "#7aa2f7",
  ok: "#9ece6a",
  warn: "#e0af68",
  danger: "#f7768e",
  noticeBorder: "#332a2b",
  noticeBg: "#211c24",
} as const;

/** A bar turns yellow past WARN and red past DANGER. */
export const THRESHOLDS = { warn: 70, danger: 85 } as const;

export const PROVIDER_COLORS = {
  cl: COLORS.accent,
  cx: COLORS.ok,
  go: COLORS.info,
} as const;

export const BLOCK_RAMP = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export const SPINNER_FRAMES = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"] as const;
