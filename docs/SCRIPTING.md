# Scripting

`open-usage --json` prints your current limits as JSON and exits without drawing the dashboard.
Use it from shell scripts, status bars, and coding agents that need to know how much quota is left.

```bash
open-usage --json            # one line, for piping
open-usage --json --pretty   # indented, for reading
open-usage --json --mock     # sample figures, labelled as such
```

## What it reads

`--json` reads only what open-usage has already cached: the usage cache, the Claude Code statusline snapshot, and local history.
It never starts the `claude` or `codex` CLI and never calls a provider's API, so it is cheap enough to run every few seconds.
A full read takes a few hundred milliseconds on a machine with a month of history.

Something else has to keep that cache current.
Either keep the dashboard open, or run the daemon:

```bash
open-usage daemon start --interval 5
```

Every provider carries `updatedAt`, and every limit carries `hasResetSinceRead`, so a script can tell a current reading from an old one.

## Output

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
| `errors` | Providers whose last read failed, as `{ "provider", "message" }`. Their cached figures still appear in `providers`. |

### Providers

| Field | Meaning |
| --- | --- |
| `id` | `claude`, `codex`, or `go`, the same names `--view` takes. |
| `name`, `plan` | As the dashboard shows them. |
| `source` | Where the limits were read from. |
| `status` | `active` (read this session), `cached` (from the cache), `local` (estimated from local data), `expired` (the last read failed), or `none` (nothing connected). |
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

## Exit codes

The codes follow CodexBar and caut, so scripts written for those tools read open-usage the same way.

| Code | Meaning |
| --- | --- |
| 0 | The report was printed, including partial results with entries in `errors`. |
| 1 | An unexpected failure. |
| 2 | This machine has no usage sources. Nothing is printed to stdout, and the reason goes to stderr. |

## Examples

The tightest limit of each provider:

```bash
open-usage --json | jq -r '.providers[] | "\(.id) \([.limits[].usedPercent // 0] | max)%"'
```

A tmux status segment:

```bash
set -g status-right '#(open-usage --json | jq -r "[.providers[] | \"\(.id) \([.limits[].usedPercent // 0] | max)%\"] | join(\" · \")")'
```

Fail a script when any limit is nearly spent:

```bash
open-usage --json | jq -e '[.providers[].limits[] | select(.hasResetSinceRead | not) | .usedPercent // 0] | max < 90'
```
