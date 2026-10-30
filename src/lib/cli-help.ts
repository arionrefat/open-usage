import { APP_NAME, APP_VERSION } from "../config";

export function versionText(): string {
  return `${APP_NAME} ${APP_VERSION}`;
}

export function helpText(): string {
  return `${APP_NAME} ${APP_VERSION}
Unified AI plan usage for Claude Code, Codex, and OpenCode Go.

USAGE
  ${APP_NAME} [options]
  ${APP_NAME} daemon <start|stop|restart|status|logs> [--interval <min>]

OPTIONS
  --view <name>        open a view: overview, claude, codex, go, settings
  --mode <name>        overview density: detailed (default) or simple
  --screen <name>      start on a screen: app (default) or onboarding
  --severity-colors    colour bars green/amber/red instead of per-provider
  --no-daily-split     hide the stacked daily chart on the overview
  --no-poll            read once at startup, never refresh
  --mock               use sample data instead of real provider data
  --json               print current limits as JSON and exit, without drawing
  --pretty             indent the --json output
  --oneline            print current limits on one line for a status bar
  --color              colour the --oneline output with ANSI codes
  --check              exit 10 near a limit, 11 at one, 20 with no data to judge
  --refresh            with the above: fetch limits first, if the cache is old
  -h, --help           show this help
  -v, --version        show the version

SCRIPTING
  --json, --oneline and --check read only what is already cached and never
  start the claude or codex CLI, so they are cheap enough for a statusline.
  They exit 2 when this machine has no usage sources. Exit codes, the schema,
  and tmux and Waybar setups are in docs/SCRIPTING.md.

DAEMON
  Off unless you start it. Refreshes every provider on its own interval so the
  dashboard opens on current numbers. \`${APP_NAME} daemon --help\` for details.

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
