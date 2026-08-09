# open-usage

Unified AI plan usage for Claude Code, Codex, and OpenCode Go, in your terminal.

[![npm](https://img.shields.io/npm/v/open-usage?color=cb3837&logo=npm)](https://www.npmjs.com/package/open-usage)
[![ci](https://github.com/arionrefat/open-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/arionrefat/open-usage/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

If you pay for more than one AI coding plan, you have no single place to see how much of each is left.
`open-usage` reads what you have already installed and shows every limit on one screen, so you know which agent to reach for before you hit a wall.

![The open-usage overview screen](docs/media/overview.png)

## Install

```bash
bun install -g open-usage
```

Then run `open-usage`.

To try it without installing anything:

```bash
bunx open-usage
```

`open-usage` is built with Bun, so Bun is the natural way to install it - but it is not a requirement.
The package is a small launcher that fetches one prebuilt binary for your platform, and that binary embeds Bun.
So npm, pnpm, and yarn work exactly as well, on a machine with no Bun at all:

```bash
npm install -g open-usage      # or: pnpm add -g / yarn global add
npx open-usage                 # one-off, no install
```

### Standalone binary

Download the binary for your OS from the [releases page](https://github.com/arionrefat/open-usage/releases):

```bash
chmod +x open-usage-darwin-arm64
./open-usage-darwin-arm64
```

Supported platforms: macOS (Apple Silicon), Linux (x64, arm64), Windows (x64, arm64).

On macOS, Gatekeeper quarantines binaries downloaded through a browser.
Clear it with `xattr -d com.apple.quarantine open-usage-darwin-arm64`, or install through a package manager instead.

## Usage

```bash
open-usage
```

The first launch runs a short setup wizard that detects which agents you have installed.
After that it opens straight to the overview.

```bash
open-usage --view claude      # jump to a provider
open-usage --mode simple      # fewer numbers per screen
open-usage --no-poll          # read once, never refresh
open-usage --help
```

### Keys

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

Every control is also clickable, and the mouse wheel scrolls views taller than the terminal.

### Staying current

When a newer version has been published, the header says so:

```
OPEN USAGE                    v0.4.0 available ▏ 3 providers ▏ ✓ all clear ▏ updated now
```

Update with the same command that installed it - `bun install -g open-usage@latest`, or the npm, pnpm or yarn equivalent.
The check runs at most once a day, and [Configuration](#configuration) below covers switching it off.

## What it reads

| Provider    | Limits from                          | History from                       |
| ----------- | ------------------------------------ | ---------------------------------- |
| Claude Code | the signed-in `claude` CLI           | `~/.claude` transcripts            |
| Codex       | a sandboxed `codex app-server`       | `~/.codex/sessions`                |
| OpenCode Go | local estimate, or the dashboard cookie | `opencode.db`                   |

`open-usage` is read-only, and there is no account to create and no key to paste.
It reuses the logins your CLIs already have: Claude and Codex limits come from their own signed-in CLIs, so their credentials are never read.
The one credential file it opens is OpenCode's `auth.json`, and only to show connection status - the key is masked on read and never displayed, logged, or sent anywhere.

Nothing is written outside its own config directory, and there is no telemetry or analytics of any kind.
It makes two outbound requests of its own accord.
One is to `opencode.ai`, and only if you opt in by configuring the cookie below.
The other asks `registry.npmjs.org` whether a newer version has been published, so an installed copy can tell you it is out of date - it sends nothing but the request, caches the answer for a day, gives up after 1.5 seconds, and stays silent on any failure.
Set `OPEN_USAGE_NO_UPDATE_CHECK` to switch it off.

OpenCode Go does not publish per-account limits, so its percentages are local estimates and are labelled as such in the UI.
Configuring the cookie below replaces those estimates with exact figures, and is enough on its own: OpenCode itself need not be installed, though without it the Go card has no token history to chart.
[docs/PROVIDERS.md](docs/PROVIDERS.md) explains how each number is derived.

## Configuration

Settings live in the app, on the `5` screen.
They persist to `~/.config/open-usage/preferences.json` (or `$XDG_CONFIG_HOME/open-usage/`).

| Variable                     | Purpose                                        |
| ---------------------------- | ---------------------------------------------- |
| `XDG_CONFIG_HOME`            | relocate the config directory                  |
| `CODEX_HOME`                 | non-default Codex home                         |
| `OPENCODE_DB`                | non-default `opencode.db` path, for history    |
| `OPEN_USAGE_OPENCODE_COOKIE` | exact OpenCode Go windows, no install needed   |
| `OPEN_USAGE_NO_UPDATE_CHECK` | set to anything to stop the daily version check |

## Development

Requires [Bun](https://bun.sh) 1.0 or newer.

```bash
git clone https://github.com/arionrefat/open-usage.git
cd open-usage
bun install
bun run demo      # sample data, no polling
bun dev           # real data, file watching
```

```bash
bun run typecheck
bun test
bun run build     # compile a standalone binary into dist/
```

Two headless harnesses render screens without a TTY, which is what the layout tests use:

```bash
bun run preview --view claude --width 140          # text only
bun run shot out.html "wide:--mode detailed"       # colour, via canvas
```

[ARCHITECTURE.md](ARCHITECTURE.md) covers the module layout and state model.

## Releasing

Releases are tag-driven from `main`.
CI runs typecheck, tests, and a render smoke test on every push and pull request.

```bash
bun run version:set 0.4.0     # bumps the root and platform versions together
git commit -am "Release v0.4.0"
git push origin main
git tag v0.4.0 && git push origin v0.4.0
```

The `v*` tag builds a binary per platform, publishes the five `@open-usage/*` platform packages and then `open-usage` itself, and attaches the binaries to a GitHub release.

[docs/RELEASING.md](docs/RELEASING.md) covers the npm scope, token, and provenance setup the first release needs.

## License

[GPL-3.0-only](LICENSE)
