# Scripting

`open-usage` can print your current limits and exit without drawing the dashboard.
Use it from shell scripts, status bars, and coding agents that need to know how much quota is left.

```bash
open-usage --oneline         # one line for a status bar
open-usage --json            # every limit as JSON, on one line
open-usage --json --pretty   # the same, indented
open-usage --check           # no output, the exit code says how close you are
open-usage --oneline --check # the line, and the exit code
```

Add `--mock` to any of these for sample figures, which are always labelled as sample data.

## What it reads

By default these commands read only what open-usage has already cached: the usage cache, the Claude Code statusline snapshot, and local history.
They never start the `claude` or `codex` CLI and never call a provider's API, so they are cheap enough to run every few seconds.
A read takes about 300 milliseconds on a machine with a month of history.

Something else has to keep that cache current.
Either keep the dashboard open, or run the daemon:

```bash
open-usage daemon start --interval 5
```

### `--refresh`

`--refresh` fetches limits before printing, and works with `--json`, `--oneline`, and `--check`.
It takes a few seconds when it has to ask a provider, and it keeps the same throttles the dashboard and daemon use.
A reading newer than the provider's polling interval answers it without a request, so a loop that runs it cannot flood a provider.
It is meant for occasional scripts, such as checking quota before a long job.
A status bar should read the cache and leave the fetching to the daemon.

Without `--refresh` nothing is read from a provider, so a provider that has stopped working usually still reports `cached` with no entry in `errors`.
Judge those readings by `updatedAt`, or run `--refresh` to find out why they stopped.

## One-line output

```
claude 5h 27% wk 73% │ codex wk 2% │ go 5h 0% wk 7% mo 91%
```

| Part | Meaning |
| --- | --- |
| `5h`, `wk`, `3d` | The length of the window, as the provider reports it. |
| `27%` | How much of that limit is used. |
| `mo`, `credits`, `fable` | A monthly cycle, credit pool, or model lane, shown only when it is tighter than the session and weekly limits. |
| `↺` | The window has reset since the reading, so the old percent is not shown. |
| `blocked` | The provider refuses usage, which can happen below every cap. |
| `n/a` | The provider has no limit to show. |
| `codex!` | The last read of this provider failed, so its figures are cached. |
| `(sample)` | Sample figures, from `--mock`. |

The output is plain text unless you pass `--color`, which adds ANSI colours: green, yellow from 70%, and red from your warning threshold in settings.
tmux and Waybar use their own colour markup, so leave `--color` off there.

### tmux

```bash
set -g status-right '#(open-usage --oneline)'
set -g status-interval 30
```

### Waybar

```json
"custom/usage": {
  "exec": "open-usage --oneline",
  "interval": 30
}
```

### Claude Code statusline

In `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "open-usage --oneline --color"
}
```

open-usage can also read limits from a snapshot your statusline script writes, as described in [Provider details](PROVIDERS.md).
If your current statusline writes that snapshot, add this command to the script rather than replacing the script.

## `--check`

`--check` turns your limits into an exit code, so a script can stop before you hit a cap.
It prints nothing unless you also pass `--json` or `--oneline`.

| Code | Meaning |
| --- | --- |
| 0 | Every current limit is below your warning threshold. |
| 10 | At least one limit is at or above your warning threshold, which you set in the dashboard's settings. The default is 85%. |
| 11 | A limit is at 100% or more, or a provider refuses usage. |
| 20 | There is nothing to judge, because every reading is uncapped or has reset since it was taken. |

It judges every limit, including model lanes and monthly cycles, across the providers the dashboard shows.
A reading whose window has reset is ignored rather than held against you.

```bash
open-usage --check --refresh
case $? in
  0) ;;
  10) echo "close to a limit, continuing" ;;
  11) echo "at a limit, stopping"; exit 1 ;;
  *) echo "could not tell, continuing" ;;
esac
```

## Exit codes

These apply to every command on this page, and `--check` adds its own codes above.
The first three follow CodexBar and caut, so scripts written for those tools read open-usage the same way.

| Code | Meaning |
| --- | --- |
| 0 | The output was printed, including partial results with entries in `errors`. |
| 1 | An unexpected failure, or both `--json` and `--oneline` were passed. |
| 2 | This machine has no usage sources. Nothing is printed to stdout, and the reason goes to stderr. |

## JSON output

```json
{
  "schemaVersion": "open-usage.v1",
  "generatedAt": "2026-10-29T15:40:00.000Z",
  "isSampleData": false,
  "providers": [
    {
      "id": "codex",
      "name": "codex",
      "plan": "Pro 100",
      "source": "codex app-server + local rollouts",
      "status": "active",
      "updatedAt": "2026-10-29T15:38:12.000Z",
      "blockedReason": null,
      "limits": [
        {
          "id": "weekly",
          "label": "7d limit",
          "usedPercent": 2,
          "remainingPercent": 98,
          "windowMinutes": 10080,
          "resetsAt": "2026-11-04T09:00:00.000Z",
          "hasResetSinceRead": false,
          "reset": "resets in 5d 17h"
        }
      ]
    }
  ],
  "errors": []
}
```

### Top level

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `open-usage.v1`. It changes only for a breaking change; new fields may appear within a version. |
| `generatedAt` | When the report was printed, ISO 8601. |
| `isSampleData` | `true` only with `--mock`. Real output never contains sample figures. |
| `providers` | The providers the dashboard shows: installed or connected, and not switched off in settings. |
| `errors` | Providers whose read failed, as `{ "provider", "message" }`. Their cached figures still appear in `providers`. Most failures only surface with `--refresh`, since nothing is read without it. |

### Providers

| Field | Meaning |
| --- | --- |
| `id` | `claude`, `codex`, or `go`, the same names `--view` takes. |
| `name`, `plan` | As the dashboard shows them. |
| `source` | Where the limits were read from. |
| `status` | `active` (read during this run), `cached` (from the cache), `local` (estimated from local data), `expired` (a read failed), or `none` (nothing connected). |
| `updatedAt` | When the reading behind `limits` was taken, ISO 8601, or `null` when there is none. |
| `blockedReason` | The provider's own reason for refusing usage, or `null`. A provider can refuse usage below every cap, for example when a spend control is reached. |
| `limits` | One entry per limit line on the provider's detail screen. |

### Limits

| Field | Meaning |
| --- | --- |
| `id` | Stable within a provider, for example `session`, `weekly`, `monthly`, or a model lane such as `fable`. |
| `label` | The detail screen's label. |
| `usedPercent` | Percent of the limit used, or `null` when the provider publishes no cap for this line. It can exceed 100. |
| `remainingPercent` | `100 - usedPercent`, never below 0, or `null` with no cap. |
| `windowMinutes` | Length of the window: 300 for five hours, 10080 for a week. `null` for a billing cycle or an unstated window. |
| `resetsAt` | When the window resets, or for a rolling window when the oldest usage ages out, ISO 8601. `null` when the provider states no time. |
| `hasResetSinceRead` | `true` once `resetsAt` has passed. The reading predates the reset, so `usedPercent` is out of date until the cache is refreshed. |
| `reset` | The dashboard's own wording, for display. |

### `jq` examples

The tightest limit of each provider:

```bash
open-usage --json | jq -r '.providers[] | "\(.id) \([.limits[].usedPercent // 0] | max)%"'
```

Hours until each weekly limit resets:

```bash
open-usage --json | jq -r '.providers[] | .id as $id | .limits[] | select(.id == "weekly" and .resetsAt != null) | "\($id) \(((.resetsAt | sub("\\.[0-9]+Z$"; "Z") | fromdate) - now) / 3600 | floor)h"'
```
