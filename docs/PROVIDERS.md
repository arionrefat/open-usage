# Provider integration research

Researched 2026-08-01 (web research + local ground-truthing on this machine).
This is the implementation reference for wiring real limit data into Limitless for all three providers.

Verdict up front: all three providers can show real or near-real limit data, each through a different mechanism.

| Provider | Real percent-of-limit? | Best source | User must provide | Status |
| --- | --- | --- | --- | --- |
| claude code | Yes (5h + weekly) | `~/.claude/usage-snapshot.json` (statusline) | Nothing (already configured) | Shipped |
| codex | Yes, from the CLI itself | Codex CLI `app-server` JSON-RPC | Codex CLI installed and signed in | Shipped |
| opencode go | Yes with a cookie, else a spend estimate | `opencode.ai/_server` RPC, falling back to `opencode.db` spend vs caps | Optional session cookie for exact figures | Shipped |

## claude code

### Sources, best first

| Source | Type | Auth | Fields | Reliability |
| --- | --- | --- | --- | --- |
| `~/.claude/usage-snapshot.json` | local file, rewritten every ~3s by the statusline | none | `rate_limits.five_hour.{used_percentage,resets_at}`, `rate_limits.seven_day.{used_percentage,resets_at}`, `context_window`, `cost`, `model` | High while a session is open; goes stale otherwise |
| `GET https://api.anthropic.com/api/oauth/usage` | HTTP, undocumented (powers `/usage`) | OAuth bearer token + `anthropic-beta: oauth-2025-04-20` + `User-Agent: claude-code/<version>` | session %, weekly all-models %, weekly per-model %, reset timestamps | Reverse-engineered; 429s hard without the User-Agent header; poll no faster than ~180s |
| `~/.claude/projects/**/*.jsonl` | local transcripts | none | per-message token usage, model, timestamps | Structure is fine, but token counts undercount up to ~100-174x on input; use for activity shape only, never for accounting |
| `v1/organizations/usage_report/*` | HTTP, official | Admin API key | org-level tokens/costs | Official but orgs only; not applicable to a personal Max/Pro plan |

### Recommendation

Keep the statusline snapshot as the primary source; it is already wired in and carries exactly the two windows the UI shows.
Do not adopt the OAuth endpoint as a default path: on macOS the token lives in the Keychain (no `~/.claude/.credentials.json` on this machine), and since early 2026 Anthropic rejects consumer OAuth tokens used outside Claude Code / Claude.ai, so a third-party poller risks 401s and ToS trouble.
Treat transcripts as the histogram source only, with the undercount caveat documented in code.

### Staleness handling

Surface the snapshot's age (mtime) and mark the provider stale when it exceeds the statusline refresh by minutes, telling the user to open a Claude Code session.

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
`src/data/real/codex-app-server.ts` spawns `codex -s read-only -a untrusted app-server`, sends `initialize`, then `account/rateLimits/read` and `account/read`, and kills the child on every path including the timeout.

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

### Cost

Spawning a process is heavier than an HTTP call, so the poll interval stays at 60s minimum with a five-minute backoff on failure and a 15-minute staleness cut-off.
Tests inject `stubCodexLimitsSource` so the suite never launches a real codex process.

## opencode go

### Sources, best first

| Source | Type | Auth | Fields | Reliability |
| --- | --- | --- | --- | --- |
| `~/.local/share/opencode/opencode.db` | SQLite | none | `session` table: `cost` (USD), `tokens_input/output/reasoning/cache_*`, `model`, `time_created`; `message`/`part` JSON blobs | Official local store, already read by the app; 154MB and active on this machine |
| Published Go plan caps | docs | none | $12 per 5h, $30 per week, $60 per month (Go plan, 2026 pricing; verify against the dashboard before shipping) | Documented but must be re-checked when plans change |
| `https://opencode.ai/auth` dashboard | HTML | browser session | live usage, limits, reset | No API; community tools scrape it with headless Chromium, which is fragile and heavy; skip |
| Gateway `x-ratelimit-*` headers | HTTP | API key | undocumented | Unverified; capture opportunistically if we ever proxy a request, do not depend on it |

### Key finding

OpenCode publishes no usage API at all; percent-of-limit is not available from any endpoint.
But because the Go plan caps are dollar-denominated and `opencode.db` records per-session cost, Limitless can compute percent used per window locally: sum `session.cost` inside each rolling window and divide by the cap.
This makes opencode go a computed estimate rather than a server truth, and the UI should label it as such.

### Implemented

Both paths now ship, with the server one preferred and the estimate as the always-available floor.

`src/data/real/opencode-go-spend.ts` sums `message.cost` for `providerID = 'opencode-go'` into three windows and scores them against the published caps.
Rolling windows report when the oldest spend in them ages out ("frees up in"), since a rolling window never resets wholesale.
The monthly window is anchored to the day-of-month of the first spend ever recorded rather than the 1st, because the billing cycle follows the subscription date - without that anchor a cycle that just rolled over reads near-zero while the weekly window reads high.

`src/data/real/opencode-server.ts` ports CodexBar's `POST https://opencode.ai/_server` integration: the two server-function ids, the header set, and a parser that reads both the serialized-JavaScript and JSON response forms.
It is verified against CodexBar's own fixture strings.
`go-limits-source.ts` polls it at most once a minute, backs off five minutes on failure, and degrades to the estimate on any error.

### Enabling server limits

Server limits need an opencode.ai session cookie, which the app only ever reads:

```bash
# from a logged-in opencode.ai tab: devtools > application > cookies
echo 'auth=<value>' > ~/.config/limitless/opencode-cookie
# or, per-shell:
export LIMITLESS_OPENCODE_COOKIE='auth=<value>'
```

Only the `auth` / `__Host-auth` cookies are sent; anything else in a pasted header is stripped before the request.
Without a cookie the app shows the local estimate and says so, which is why the cookie is optional rather than a setup step.

### Known fragility

The server function ids are content hashes that rotate whenever opencode.ai redeploys, and there is no runtime discovery mechanism - CodexBar hardcodes them too.
When they rotate, the parse fails, the UI falls back to the estimate with a note, and the ids need refreshing from `SERVER_FUNCTION_IDS`.

## Cross-cutting

### What the user must provide

Nothing today: all three providers ride on credentials already on disk from the tools' own logins.
Optional future inputs: a plan-cap override for opencode go, and a manual OpenAI OAuth re-login if the stored refresh token dies.

### Polling and freshness

Local files (snapshot, opencode.db) can be re-read on the existing 60s poll and on `r` refresh; they are cheap.
`wham/usage` gets its own 60s minimum interval with backoff on 429/5xx.
Every provider carries a fetched-at timestamp so the UI can flag staleness per source, not just globally.

### Staying up to date

The two HTTP sources are unofficial; pin our request shapes in one module each and fail soft to the local fallback when the schema drifts.
Watch these repos when something breaks, since they track the same endpoints: `openai/codex`, `steipete/codexbar`, `lhl/pi-codex-status`, `ryoppippi/ccusage`, `slkiser/opencode-quota`, `anthropics/claude-code` issues.
Re-verify the Go plan dollar caps and the `anthropic-beta` header value on each release.

### Risks

`wham/usage` is private and can change or be blocked without notice; the session-file fallback and a clear "limits unavailable" state must stay.
Anthropic consumer OAuth tokens are locked to first-party clients, which is why the statusline snapshot (first-party output) is the safe channel.
opencode go percent is an estimate; if opencode's cost accounting drifts from billing, our bar drifts with it.
