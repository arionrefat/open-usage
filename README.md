# Limitless

A terminal dashboard for unified AI plan usage across Claude Code, Codex, and OpenCode Go.
Built with [OpenTUI](https://opentui.com/docs/) and React.

## Installing

Requires [Bun](https://bun.sh) 1.0 or newer. Install the CLI globally:

```bash
bun install -g open-usage
```

Or run it on demand without installing:

```bash
bunx open-usage
```

Prefer a standalone executable? Grab the binary for your OS from the
[releases page](https://github.com/arionrefat/open-usage/releases), make it executable, and run it directly -
no Bun required.

## Running

```bash
bun install
bun run limitless
```

`bun dev` runs the same thing with file watching.

The CLI can open any screen directly, which is useful while iterating on a view:

```bash
bun run limitless --view settings
bun run limitless --mode simple
bun run limitless --screen onboarding
bun run limitless --severity-colors    # bars read green/amber/red instead of brand colors
bun run limitless --no-daily-split     # hide the stacked daily chart on the overview
```

## Keys

| Key     | Action                                          |
| ------- | ----------------------------------------------- |
| `1`–`5` | jump to a view; `5` is settings                 |
| `tab`   | cycle views forward                             |
| `j`/`k` | move between providers                          |
| `↵`     | open the selected provider                      |
| `m`     | overview mode: simplified / detailed            |
| `w`     | window: session / weekly (simplified mode only) |
| `t`     | cycle range: today / 7d / 30d / month / all     |
| `r`     | refresh all providers                           |
| `/`     | filter providers by name                        |
| `o`     | re-run the setup wizard                         |
| `?`     | keymap                                          |
| `q`     | quit                                            |

On the settings screen `space` shows or hides a provider.
Available providers refresh at startup and during the regular polling interval; `r` also probes unavailable providers manually.

## Mouse

Every control is clickable: the numbered tabs, the `range` readout, mode and window toggles, provider cards, settings actions, the `o` setup-wizard link, the keymap's dimmed backdrop, onboarding buttons, and each hint in the footer bar.
The mouse wheel scrolls views taller than the terminal.

## Data

The UI reads everything through the `UsageProvider` interface in `src/data/types.ts`.
Production mode reads local provider sources through `src/data/real-provider.ts`.
The `limitless`, `preview`, and `shot` scripts use `src/data/mock-provider.ts` for fixed sample figures.
The setup wizard opens automatically on first launch, auto-detects provider logins, and never asks users to paste tokens.
Provider visibility remains in memory for the current session.
Onboarding completion is stored in `~/.config/limitless/preferences.json`.

Provider access is read-only: the app writes only its small preferences file and never reads provider tokens directly.
Claude and Codex limits are fetched through their signed-in first-party CLIs; OpenCode Go uses local data unless its optional dashboard integration is explicitly configured.

### Provider Data

- Claude limits come from the signed-in Claude CLI's `/usage` command; charts, model share, token split, prompts, and sessions come from local `~/.claude` history and transcripts. Plan labels are read from `claude auth status --json`.
- Codex live limits and account-wide analytics come from a short-lived, sandboxed `codex app-server` child process. Local per-device usage is read from native rollout files under `~/.codex/sessions` (with opencode.db as a fallback). Codex refreshes during startup, the regular application poll, and with `r`.
- OpenCode Go analytics come from `opencode.db` and are model-weighted against published per-model allowances. Exact subscription windows require the optional private dashboard integration; without it, percentages are visibly labeled as model-weighted local estimates.

There is no supported public Codex subscription HTTP API that avoids the first-party CLI process.
Directly reading Codex OAuth credentials or calling its private backend would be less secure and less stable, so Limitless does neither.

## Width

The layout targets 140 columns and is tested down to 60 columns.
When a line runs out of room its right-hand readout gives up columns first, then the left is ellipsized; the tab strip drops whole tabs to keep the active one visible.
Detailed overview columns stack vertically when they cannot fit at their minimum readable width.
The overview's provider histogram is hidden below 88 columns and the legend takes the full width.

## Layout

```
src/
  app.tsx              root layout, keymap, polling timers
  config.ts            app-level constants (version and poll interval)
  theme.ts             palette, thresholds, per-provider colors
  components/          line and chart primitives, chrome, meters
  data/                UsageProvider contract and the mock adapter
  lib/                 chart maths, meter building, monospace text helpers
  screens/             overview, provider detail, settings, onboarding, help
  state/               reducer, action types, derived selectors
  layout.test.tsx      asserts no chrome line wraps or collides, 60–140 columns
scripts/preview.tsx    headless text screenshot harness
scripts/shot.tsx       headless colour screenshot harness
```

## Development

```bash
bun run typecheck
bun test
bun run preview --view claude --width 140     # print a screen as text, no TTY needed
bun run preview --screen onboarding --keys ENTER,s,k,ENTER
```

`preview` prints characters only, so it cannot show colour or how full a bar is.
For anything involving either, `shot` writes an HTML page that redraws each cell on a canvas at a true terminal aspect, with block glyphs painted as rectangles rather than font glyphs:

```bash
bun run shot out.html "wide:--mode detailed" "narrow:--mode detailed --width 80"
```

## Releasing

Releases are tag-driven from `main`. CI runs `typecheck`, the test suite, and a headless render smoke test on every push and pull request; a `vX.Y.Z` tag triggers the `release` workflow, which builds per-platform binaries, attaches them to a GitHub release, and publishes `open-usage` to npm.

To cut a release:

1. Bump `version` in `package.json` (the `v` in the UI reads it automatically).
2. Push `main`, then tag it: `git tag v0.4.0 && git push origin v0.4.0`.

The workflow needs the `NPM_TOKEN` repository secret (an npm access token with publish scope).
