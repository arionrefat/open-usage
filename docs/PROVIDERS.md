# Provider integration research

Researched 2026-08-01, re-verified 2026-08-03 (official documentation, upstream source, and local ground-truthing on this machine).
Where a published claim disagreed with this machine's own files, the measurement won; those cases are kept as corrections rather than quietly overwritten.
This is the implementation reference for wiring real limit data into Limitless for all three providers.

Verdict up front: all three providers can show real or near-real limit data, each through a different mechanism.

| Provider | Real percent-of-limit? | Best source | User must provide | Status |
| --- | --- | --- | --- | --- |
| claude code | Yes (5h + weekly) | First-party `claude -p "/usage"`, then a fresh statusline snapshot | Claude Code installed and signed in | Shipped |
| codex | Yes, from the CLI itself | Codex CLI `app-server` JSON-RPC | Codex CLI installed and signed in | Shipped |
| opencode go | Yes with a cookie, else a spend estimate | `opencode.ai/_server` RPC, falling back to `opencode.db` spend vs caps | Optional session cookie for exact figures | Shipped |

## claude code

### Sources, best first

| Source | Type | Auth | Fields | Reliability |
| --- | --- | --- | --- | --- |
| `claude --safe-mode -p "/usage" --output-format json --no-session-persistence` | first-party CLI | Claude Code's own login | current session %, weekly all-models %, model-specific weekly %, reset text | Live account fetch with no model turn, but quota fields are text rather than a stable JSON schema |
| `~/.claude/usage-snapshot.json` | local file, rewritten every ~3s by the statusline | none | `rate_limits.five_hour.{used_percentage,resets_at}`, `rate_limits.seven_day.{used_percentage,resets_at}`, `context_window`, `cost`, `model` | Official schema and high confidence while fresh; goes stale otherwise |
| `GET https://api.anthropic.com/api/oauth/usage` | HTTP, undocumented (powers `/usage`) | OAuth bearer token + `anthropic-beta: oauth-2025-04-20` + `User-Agent: claude-code/<version>` | session %, weekly all-models %, weekly per-model %, reset timestamps | Reverse-engineered; 429s hard without the User-Agent header; poll no faster than ~180s |
| `~/.claude/projects/**/*.jsonl` | local transcripts | none | per-message token usage, model, timestamps | Usable for activity shape once de-duplicated (see below); never for accounting |
| `v1/organizations/usage_report/*` | HTTP, official | Admin API key | org-level tokens/costs | Official but orgs only; not applicable to a personal Max/Pro plan |

### Recommendation

Use the signed-in Claude CLI as the live source, with a conservative three-minute minimum poll interval and a ten-minute cache cutoff.
The command was verified locally on Claude Code 2.1.220: it completed in 627 ms with zero turns, zero tokens, and zero cost, and matched the Claude web dashboard at 10% session and 95% weekly usage.
Its outer response is JSON but the quota fields remain human-readable text, so parsing must be defensive and fail closed if both expected windows are not present.
Use the documented statusline schema only while its file is under ten minutes old.
Never render an older statusline percentage as current, even with a stale warning; show the limits as unavailable until the CLI succeeds or a fresh session snapshot arrives.
Do not adopt the OAuth endpoint as a default path: on macOS the token lives in the Keychain, consumer OAuth is intended for Anthropic's own clients, and direct polling introduces credential, compatibility, rate-limit, and Terms risks.
Treat transcripts as the histogram source only.

### Why not the Claude web cookie

The Claude usage page is live and was independently verified against the CLI, but its session cookie is a full account credential rather than a usage-only token.
The app must not request, store, or replay `sessionKey`, and users should never paste it into configuration or issue reports.
Browser scraping also violates the clean first-party authentication boundary and can break with Cloudflare or dashboard changes.

### The transcript double-count, and a correction

An earlier note here claimed transcripts *undercount* input tokens by 100-174x, sourced from third-party write-ups.
Measured against this machine's own transcripts, that is not the failure mode.

The real problem is duplication: Claude Code re-logs an assistant message as it streams, so the same `message.id` appears with an identical usage block several times.
Across 40 transcripts, 3074 assistant rows collapsed to 1312 unique messages, meaning **65.8% of the tokens being counted were duplicates** - roughly a 3x inflation of the chart, the burn rate and the usage-share figures.

`aggregateTranscriptLines` now banks each `message.id` once. Every message in the sample carried an id, so the de-duplication is complete rather than best-effort; messages without one are still counted, since there is no way to tell them apart.

The lesson worth keeping: this was measurable locally in a few minutes and the published claim pointed the wrong direction. Verify token-accounting claims against real files before encoding them.

### Staleness handling

Surface the snapshot's age (mtime), but remove its percentages once it exceeds ten minutes.
The next provider refresh asks the signed-in Claude CLI for live values, so opening an interactive Claude session is only the fallback.

## codex

### Sources, best first

| Source | Type | Auth | Fields | Reliability |
| --- | --- | --- | --- | --- |
| `GET https://chatgpt.com/backend-api/wham/usage` | HTTP, private (what Codex CLI's `/status` polls, ~60s) | `Authorization: Bearer <access_token>` + `ChatGPT-Account-Id: <account_id>` | `plan_type`, primary window (5h) and secondary window (weekly): `used_percent`, `resets_in_seconds`, `window_minutes`, credits | Private endpoint, may change; the whole tracker ecosystem (CodexBar, pi-codex-status) relies on it |
| `x-codex-primary-used-percent` / `x-codex-secondary-used-percent` | HTTP response headers | same token | live used-percent on any Codex API call | Real-time but only when traffic flows |
| `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | local files | none | `token_count` events: cumulative tokens + nullable `rate_limits` snapshot | Offline fallback; `rate_limits` is sometimes null (openai/codex#14880); not present on this machine |
| `api.openai.com/v1/billing/usage` | HTTP, official | platform API key | API billing usage | Wrong billing system for ChatGPT-plan users; irrelevant here |

### The CLI RPC path (best, when Codex is installed)

CodexBar's `docs/codex.md` documents a route the earlier research missed entirely: Codex CLI can be driven as a JSON-RPC server, so limits come from the tool itself with no token handling and no private endpoint.

```
codex -s read-only -a untrusted app-server
```

Methods: `initialize` (client name/version), then `account/read` and `account/rateLimits/read`.
Sandboxed read-only and untrusted, with a per-method timeout and the child killed on overrun.
This should be the first choice wherever the CLI exists, because it survives endpoint changes and never touches a credential.

### Exact wire format

Response nests the windows under `rate_limit`: `rate_limit.primary_window` is the session lane, `rate_limit.secondary_window` the weekly lane, each with `used_percent`, `reset_at`, `limit_window_seconds`.
`additional_rate_limits[]` carries per-model lanes, and a credits snapshot carries `balance`, `hasCredits`, `unlimited`.
Headers are `Authorization: Bearer <access_token>`, `ChatGPT-Account-Id: <account_id>`, `User-Agent: codex-cli`.
Fallback endpoint: `{base_url}/api/codex/usage`. Related: `GET .../wham/rate-limit-reset-credits`.

### Token refresh

```
POST https://auth.openai.com/oauth/token
{ "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "grant_type": "refresh_token",
  "refresh_token": "<refresh_token>",
  "scope": "openid profile email" }
```

Returns a new `id_token`, `access_token` and `refresh_token`; CodexBar refreshes when `last_refresh` is over 8 days old, and treats a missing `last_refresh` as due immediately.

### This machine, and the hazard that blocks it

No `~/.codex`, and no `codex` on PATH, so both the CLI RPC path and the `auth.json` path are unavailable.
The only OpenAI credential here is the `openai` entry in opencode's `auth.json` (`access`, `refresh`, `expires`, `accountId`) - and as of 2026-08-01 that access token is already **expired**.

That makes refresh mandatory rather than optional, which is the problem: OpenAI rotates refresh tokens, so spending opencode's refresh token would likely invalidate the copy opencode still holds and break the user's opencode login.
Writing the rotated token back into opencode's `auth.json` avoids that but means Limitless mutating another tool's credential store, which this app has so far deliberately never done.

### Implemented

Codex CLI 0.146.0 was installed, which made the CLI RPC route available, so no token is ever read, refreshed or transmitted by this app.
`src/data/real/codex-app-server.ts` spawns `codex -s read-only -a untrusted app-server`, sends `initialize`, then `account/rateLimits/read`, `account/read`, and `account/usage/read`, and kills the child on every path including timeout and cancellation.

Ground truth beat the third-party docs in three places, all verified against `codex app-server generate-json-schema` and a live call:

- Fields are camelCase (`usedPercent`, `resetsAt`, `windowDurationMins`), not the snake_case in CodexBar's write-up. `resetsAt` is unix **seconds**.
- `primary` is not necessarily the session window. This Plus account reports a single **weekly** window (`windowDurationMins: 10080`) as `primary` with `secondary: null`, so windows are classified by their own reported duration - anything at or under six hours is the session lane - and position is only a fallback when the duration is absent.
- The response also carries `rateLimitResetCredits`, a free "reset my limits" grant. It surfaces on the card because it is the way out of a capped week.

`account/read` supplies the real plan name, which replaces the opencode-derived stand-in label.

### Usage history

`account/usage/read` returns server-side history and is the best token source available for any provider here:

```
summary: { lifetimeTokens, peakDailyTokens, longestRunningTurnSec, currentStreakDays, longestStreakDays }
dailyUsageBuckets: [{ startDate: "YYYY-MM-DD", tokens }]
```

Buckets are sparse - idle days are absent rather than zero - so they are mapped onto the chart's date keys rather than consumed positionally.
This supersedes the opencode-derived series for codex, which only ever saw traffic opencode itself sent: server history reports a 110M peak day against opencode's 4M.
The call is treated as a bonus, so limits still render if a future CLI drops the method.

### On whether opencode shares this pool

This flip-flopped twice, so the evidence is recorded here rather than the conclusion alone.

The live limit reading is 0% used, which first looked like proof that opencode's OpenAI traffic bills to a different pool.
It is not: the weekly window opened on 1 Aug (`resetsAt` 8 Aug, `windowDurationMins` 10080) and the last recorded activity was 29 Jul, so an empty current window is expected regardless.
The daily buckets then land on 22, 23 and 29 Jul - the same days opencode.db records OpenAI activity - which points to one shared account with the server counting everything and opencode counting only what it sent.

Account identity is still not directly proven, so nothing in the UI asserts it.

### Cost and freshness

Spawning a process is heavier and visible to coding-agent observers such as Herdr.
Codex therefore refreshes only when the user presses `r` by default; onboarding and Settings offer an explicit startup-refresh preference.
The 60-second application interval never launches Codex, hidden providers are never queried, failures back off for five minutes, and copied values expire after 15 minutes.
Any failed refresh clears the copied account snapshot instead of extending an old percentage; the next successful `account/rateLimits/read` restores it.
Tests inject `stubCodexLimitsSource` so the suite never launches a real codex process.

### Re-verified 2026-08-02

CLI 0.146.0 is current, and the core `account/*` methods are stable enough that the official VSCode extension depends on them.
The app-server carries no breaking-change guarantee, so the parser stays defensive.

`openai/codex#32707` reports Pro accounts losing the 5-hour bucket from `account/rateLimits/read`.
That is the exact shape our duration-based classification already handles - a lone window is placed by its own `windowDurationMins` - whereas a positional `primary → session` mapping would mislabel it. The choice made under uncertainty turns out to be the one that survives the schema moving.

Fields left unread, and why: `rateLimitsByLimitId`, `individualLimit` and `spendControlReached` only populate on Team/Business plans with workspace spend controls; `rateLimits.credits` reads `balance: "0"` on a Plus account with no add-on credits. None reach a Plus user, so reading them would add branches nothing exercises.

`account/usage/read` counts cached input tokens toward its totals with no separate breakdown, which is consistent with how those tokens count against the rate-limit windows.

### Deliberately not built: redeeming a reset credit

`account/rateLimitResetCredit/consume` would let the app spend the free reset it already displays.
That is a one-way account action, and this is a read-only dashboard: every other call it makes can be repeated with no consequence.
Burning a scarce credit from a background poller - or from a mis-keyed keystroke - is not a failure mode worth introducing for convenience. If it is ever added it should require an explicit confirmation, never a bare keybinding.

## opencode go

### Sources, best first

| Source | Type | Auth | Fields | Reliability |
| --- | --- | --- | --- | --- |
| `~/.local/share/opencode/opencode.db` | SQLite | none | `session` table: `cost` (USD), `tokens_input/output/reasoning/cache_*`, `model`, `time_created`; `message`/`part` JSON blobs | Official local store, already read by the app; 154MB and active on this machine |
| Published Go plan caps | docs | none | $12 per 5h, $30 per week, $60 per month (Go plan, 2026 pricing; verify against the dashboard before shipping) | Documented but must be re-checked when plans change |
| `https://opencode.ai/_server` | Internal server query | browser session cookie | rolling, weekly, and monthly usage percent and reset | Exact dashboard values; server-function ids can change on deploy |
| Gateway `x-ratelimit-*` headers | HTTP | API key | undocumented | Unverified; capture opportunistically if we ever proxy a request, do not depend on it |

### Key finding

OpenCode's internal server query publishes exact percent-of-limit and reset data to an authenticated dashboard session.
Without a session cookie, Limitless computes an estimate locally by summing `message.cost` inside each window and dividing by the Go plan cap.
The UI labels only locally computed windows as estimates.
There is still no supported public OpenCode Go quota endpoint, CLI command, local server route, or SDK method.
Open issue `anomalyco/opencode#16017` and unmerged PR `#16513` propose `GET /zen/go/v1/usage`; production currently returns 404.
Adopt that API-key-authenticated route if it is merged and documented.

### Implemented

Both paths now ship, with the server one preferred and the estimate as the always-available floor.

`src/data/real/opencode-go-spend.ts` sums `message.cost` for `providerID = 'opencode-go'` into three windows and scores them against the published caps.
Rolling windows report when the oldest spend in them ages out ("frees up in"), since a rolling window never resets wholesale.
The monthly window is anchored to the day-of-month of the first spend ever recorded rather than the 1st, because the billing cycle follows the subscription date - without that anchor a cycle that just rolled over reads near-zero while the weekly window reads high.

`src/data/real/opencode-server.ts` sends the dashboard's `GET https://opencode.ai/_server?id=<functionId>&args=<seroval>` query form with the filtered session cookie.
The workspaces query uses id `def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f` and omits `args`.
The `queryLiteSubscription_query` query uses id `c7389bd0e731f80f49593e5ee53835475f4e28594dd6bd83eb229bab753498cd` and receives one workspace id in a seroval array envelope.
The parser reads rolling, weekly, and monthly windows from both JSON and serialized-JavaScript response forms.
`go-limits-source.ts` polls it at most once a minute, backs off five minutes on failure, and degrades to the estimate on any error.

### Enabling server limits

Server limits currently need an opencode.ai session cookie, which is a full dashboard credential:

```bash
# from a logged-in opencode.ai tab: devtools > application > cookies
echo '{ "opencodeCookie": "auth=<value>" }' > ~/.config/limitless/config.json
# or, per-shell:
export LIMITLESS_OPENCODE_COOKIE='auth=<value>'
```

Only the `auth` / `__Host-auth` cookies are sent; anything else in a pasted header is stripped before the request.
The cookie's Iron seal carries its own expiry, and the app warns during its final seven days.
Any session failure produces the same visible warning while the local estimate continues.
Without a cookie the app shows the local estimate and says so, which is why the cookie is optional rather than a setup step.
This private integration is opt-in and not recommended for general distribution: OpenCode's hosted Terms prohibit programmatic extraction and reverse engineering.
Do not request a user's cookie during support, and do not add automatic browser-cookie extraction.

### Known fragility

The server function ids are content hashes that rotate whenever opencode.ai redeploys.
They can technically be discovered from public deployment assets, but doing so would deepen the scraping and Terms risk, so the app intentionally does not automate discovery.
When they rotate, the parse fails, the UI falls back to the estimate with a note, and the ids need refreshing from `SERVER_FUNCTION_IDS`.

## Cross-cutting

### What the user must provide

Nothing today: all three providers ride on credentials already on disk from the tools' own logins.
Optional future inputs: a plan-cap override for opencode go, and a manual OpenAI OAuth re-login if the stored refresh token dies.

### Polling and freshness

Local files (`usage-snapshot.json`, `opencode.db`) are re-read on the existing 60s app poll and on `r` refresh.
Claude CLI usage is requested at most every three minutes, while the optional OpenCode server source uses a 60-second minimum interval.
Codex app-server is manual by default, with one optional startup request and no interval polling.
Claude's copied limits expire after ten minutes; Codex and OpenCode server copies expire after 15 minutes.
Recognized and unexpected live-source failures clear exact cached values immediately rather than presenting an old result as current.

### Staying up to date

The two HTTP sources are unofficial; pin our request shapes in one module each and fail soft to the local fallback when the schema drifts.
Watch these repos when something breaks, since they track the same endpoints: `openai/codex`, `steipete/codexbar`, `lhl/pi-codex-status`, `ryoppippi/ccusage`, `slkiser/opencode-quota`, `anthropics/claude-code` issues.
Re-verify the Go plan dollar caps and Claude CLI `/usage` text shape on each release.

### Risks

`wham/usage` is private and can change or be blocked without notice, which is why Codex access stays behind its official app-server boundary.
Anthropic consumer OAuth tokens are locked to first-party clients, which is why both Claude sources are first-party CLI outputs.
OpenCode Go's local percentage is only an estimate: local data omits other devices, server-side model multipliers, deleted sessions, and exact window anchors.
