# limits

A terminal dashboard for unified AI plan usage across Claude Code, Codex, and OpenCode Go.
Built with [OpenTUI](https://git.new/create-tui) and React.

## Running

```bash
bun install
bun run limits
```

`bun dev` runs the same thing with file watching.

The CLI can open any screen directly, which is useful while iterating on a view:

```bash
bun run limits --view settings
bun run limits --mode simple
bun run limits --screen onboarding
bun run limits --severity-colors    # bars read green/amber/red instead of brand colors
bun run limits --no-daily-split     # hide the stacked daily chart on the overview
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

On the settings screen `space` shows or hides a provider, `↵` cycles its connection status, `p` pastes a key, and `d` disconnects it.

## Mouse

Every control is clickable: the numbered tabs, the `range` readout, the mode and window toggles, provider cards and settings rows, the `o` setup-wizard link, the keymap's dimmed backdrop, the onboarding buttons, and each hint in the footer bar.
The mouse wheel scrolls views taller than the terminal.

## Data

The UI reads everything through the `UsageProvider` interface in `src/data/types.ts`.
`src/data/mock-provider.ts` is the adapter currently wired up; it serves fixed sample figures.
Swapping in a live adapter that polls each vendor requires no changes to the screens.

## Width

The layout targets 140 columns but stays on a single row per line at any width.
When a line runs out of room its right-hand readout gives up columns first, then the left is
ellipsized; the tab strip drops whole tabs and scrolls to keep the active one visible.
The overview's donut is hidden below 88 columns and the legend takes the full width.

## Layout

```
src/
  app.tsx              root layout, keymap, polling timers
  config.ts            app-level constants (version, poll interval, config path)
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
For anything involving either, `shot` writes an HTML page that redraws each cell on a canvas at a
true terminal aspect, with block glyphs painted as rectangles rather than font glyphs:

```bash
bun run shot out.html "wide:--mode detailed" "narrow:--mode detailed --width 80"
```
