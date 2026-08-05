import { APP_NAME, APP_VERSION } from "../config";

export function versionText(): string {
  return `${APP_NAME} ${APP_VERSION}`;
}

export function helpText(): string {
  return `${APP_NAME} ${APP_VERSION}
Unified AI plan usage for Claude Code, Codex, and OpenCode Go.

USAGE
  ${APP_NAME} [options]

OPTIONS
  --view <name>        open a view: overview, claude, codex, go, settings
  --mode <name>        overview density: detailed (default) or simple
  --screen <name>      start on a screen: app (default) or onboarding
  --severity-colors    colour bars green/amber/red instead of per-provider
  --no-daily-split     hide the stacked daily chart on the overview
  --no-poll            read once at startup, never refresh
  --mock               use sample data instead of real provider data
  -h, --help           show this help
  -v, --version        show the version

KEYS
  1-5 views    tab cycle    j/k providers    enter open    r refresh
  m mode       t range      / filter         o setup       ? keymap    q quit

Docs and issues: https://github.com/arionrefat/open-usage`;
}

/** Short flags never reach readFlags, so the raw argv is checked here. */
export function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export function wantsVersion(argv: string[]): boolean {
  return argv.includes("--version") || argv.includes("-v");
}
