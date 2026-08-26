# Provider integration research

Researched 2026-08-01, re-verified 2026-08-03 (official documentation, upstream source, and local ground-truthing on this machine).
Where a published claim disagreed with this machine's own files, the measurement won; those cases are kept as corrections rather than quietly overwritten.
This is the implementation reference for wiring real limit data into open-usage for all three providers.

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

Rows are keyed `messageId:requestId`, not by message id alone.
On the transcripts measured here the two are identical - 60,047 of 60,066 rows carry a request id and no id maps to more than one - so the pair costs nothing and removes the case where one id is reused across requests.
CodexBar reached the same key independently, which is some evidence it is the right one.

There is a second copy that per-file de-duplication cannot see.
Resuming or forking a session writes a new transcript that carries the earlier assistant messages forward, so the same `message.id` appears in two different files and each file banks it once.
Measured across 538 transcripts: 484 ids in more than one file, **2,003,189 tokens overcounted, or 1.63%**, on top of the 31,883 within-file copies the per-file pass already caught.
Smaller than the streaming duplication, but it inflated the priced spend estimate too, since `dayModelTokens` feeds the money figure.
`readClaudeTranscripts` now holds a run-level set of ids across every file, and fills the hour buckets from that de-duplicated stream rather than merging each file's own.

The lesson worth keeping: this was measurable locally in a few minutes and the published claim pointed the wrong direction. Verify token-accounting claims against real files before encoding them.

### Cache reads are shown, not summed

`parseTranscriptLine` sums `input + output + cache_creation` and holds `cache_read_input_tokens` out.
That looks like a 40x undercount - on the machine this was measured on, cache reads are 2,684.1M of 2,753.3M, or 97.5% - and it was briefly "fixed" by folding them in. That was wrong, for two reasons found afterwards.

**Codex's own convention excludes them.** `TokenUsage::blended_total` in `codex-rs/protocol` is `non_cached_input + output`, commented as the "primary count for display as a single absolute value".
Anthropic's schema splits the same quantity differently - `input_tokens` already excludes both cache kinds - so `input + output + cache_creation` is the near-equivalent shape.
Folding cache reads into the Claude figure alone inverted the usage share to claude code 82% / codex 18%, comparing one provider's full throughput against another's blended figure.

**Anthropic weights them far below input.** Cache reads bill at 10% of the input rate and count *nothing* toward ITPM ([rate limits](https://platform.claude.com/docs/en/api/rate-limits) - only Haiku 3.5 counts them).
On a subscription they do draw plan usage, but at the cached rate, not whole.
Claude Code's own `/usage` never merges them either; it prints the four kinds side by side.

What *was* a real defect: `modelTokens` counted cache reads while the headline did not, so the overview read 68.2M while the detail screen's per-model bars summed to 2.70B off the same events. Both now use the blended figure, and `tokenSplit` still carries all four kinds for the detail screen.

The same defect existed in opencode go and was missed the first time, because it lives in SQL rather than in the aggregation code: `MODEL_ROWS_SQL` added `$.tokens.cache.read` to its sum while `SESSION_ROWS_SQL` did not, so the "models 30d" bars again contradicted the card above them.
Both queries now share one `TOKENS_SQL` expression, and the test asserts the bars sum to the headline rather than checking a hard-coded figure.

**Excluding them is not the same as hiding them.** A figure this large going unstated on the main screen is its own kind of wrong: a heavy Claude user reads a 10% share and reasonably concludes the tool is undercounting them.
So `ProviderUsage.cacheRead30d` carries the volume to the overview's usage share, in its own column, held apart from the token figure rather than added to it.
The field is deliberately optional. Claude and opencode go report a cache split and set it; Codex has no such breakdown, so it stays absent and the column renders `-`.
That is the honest reading - "this source does not say" is a different fact from "this source measured zero", and the column keeps them apart.

**Settled: it does not.** The server-side `dailyUsageBuckets[].tokens` is cache-inclusive, measured 2026-08-26 by summing local rollouts per local day and comparing them to the same day's bucket.

| Day | Server bucket | Local `total_tokens` | Local `blended_total` |
| --- | --- | --- | --- |
| 2026-08-16 | 57,460,283 | 64,014,395 | 3,307,938 |
| 2026-08-18 | 7,521,756 | 9,842,441 | 620,041 |
| 2026-08-19 | 16,367,111 | 14,526,677 | 1,100,757 |

The server tracks `total_tokens` within the margin that UTC-versus-local day boundaries and rollout retention explain, and sits roughly 17x above `blended_total`.
The payload carries no breakdown to correct it with - each bucket is `{startDate, tokens}` and nothing else - so there is no arithmetic that recovers a comparable figure.

Two consequences, one fixed and one accepted.

Fixed: the *local* reader in `codex-sessions.ts` was summing `last_token_usage.total_tokens`, which is cache-inclusive for the same reason.
On this machine that was 154.5M against a blended 8.7M, a 17.7x overstatement, with `cached_input_tokens` making up 94.3% of the counted figure.
It now computes `non_cached_input + output`, matching Codex's own convention and the two other providers, and falls back to `total_tokens` only for rollouts predating the breakdown.

Also fixed: `codex-provider.ts` no longer takes the daily series from the server at all.

It had been doing so because the server covers the whole account rather than this device, which is true and is a real advantage.
The cost was not only that the codex bar could not be compared to the other two.
`series.hourly` and the burn rate were built from local rollouts the whole time, so pressing `t` to move between 30d and today silently changed what a codex token meant, by a factor of seventeen, inside one provider's own card.
A field cannot be both the widest available measurement and the comparable one, and `series` is read by the cross-provider charts, so it has to be the comparable one.

`series` is therefore local and blended for every provider, without exception, and that is now stated as an invariant on the type.
The account-wide figure is not lost: it is reported on the codex detail screen as `account 30d · incl. cached`, beside the lifetime and peak-day records that were already sourced from the same payload.
Naming the basis in the label is what keeps it honest - the same reasoning that gives cache reads their own column instead of a place in the bar.
`activityScope` was deleted along with the mismatch, since it existed only to caption a series that could be one of two things.

On this machine the share chart went from `codex 84% / claude 16%` to `claude 93% / codex 7%`, and codex's row picked up the local session count it had been hiding behind the word `account`.

Limit percentages and the burn projection were unaffected throughout, since those come from the statusline percentages rather than token counts.

### Staleness handling

Surface the snapshot's age (mtime), but remove its percentages once it exceeds ten minutes.
The next provider refresh asks the signed-in Claude CLI for live values, so opening an interactive Claude session is only the fallback.

### Spend: where the money comes from

Verified 2026-08-17 against Claude Code 2.1.233.

Cost per token is stored nowhere. Transcript assistant lines carry `usage` counts only - no `costUSD`.
`Stop` and `SessionEnd` hooks were probed directly and carry no cost data at all, only `session_id` and `transcript_path`.
Claude Code's own `costLedger` is in memory and dies with the session, so `total_cost_usd` and its per-model `modelUsage` map are reachable only from a headless `claude -p --output-format json` run or the statusline payload, neither of which covers ordinary interactive use.

What is available is the account block Claude Code caches in `~/.claude.json` under `cachedUsageUtilization.utilization`:

- `spend` - `used` as `{amount_minor, currency, exponent}`, plus `limit`, `balance`, `cap`, `percent`, `enabled`.
- `extra_usage` - `is_enabled`, `monthly_limit`, `used_credits`, `utilization`, `spend_limit_reached`, `credits_ever_enabled`.
- `five_hour` / `seven_day` - each with `limit_dollars`, `used_dollars`, `remaining_dollars`.

`spend.used` is the figure used, because its shape is unambiguous.
`extra_usage.used_credits` is paired with a sibling `decimal_places`, and the intended scaling of that pair was not observable on the account this was built against (credits were off, so every credit field read null), so it is deliberately not parsed rather than guessed.

Two mechanics follow, and they must not be swapped:

**Spend is an odometer.** `used_credits` is cumulative within a billing cycle and resets at the boundary.
Readings are sampled and the running maximum kept; a reading below that maximum means the cycle rolled over, so the peak is banked as that cycle's final total.
Summing the samples instead would multiply the real figure by the poll count - roughly 1000x per day at a 60s interval.
Sampling the account odometer also captures usage from other machines and from claude.ai, which local session data structurally cannot see; Claude's own `/usage` output says so outright.

**Tokens are events.** They carry timestamps, so they are bucketed per local day and re-measured on every poll.
Day granularity rather than month because a billing cycle rarely starts on the 1st, and only per-day figures can be summed over an arbitrary window without mixing one window's tokens with another's money.

### Spend: what is estimated, and what that costs

The shipped price table only apportions.
Where an exact total covers the same window, per-model costs are priced, normalised, and scaled to that total, with the rounding remainder given to the largest row so the parts sum exactly to the headline.
A stale price therefore shifts the split and can never move the total.

A cycle's start is only learned when it is first observed, so a cycle first seen mid-month cannot be spread across that whole month's tokens.
In that case the exact total keeps its own window label and the per-model split stays an estimate - the two windows are never silently merged.

Cache writes are priced by TTL: `ephemeral_5m_input_tokens` at 1.25x input and `ephemeral_1h_input_tokens` at 2x.
Transcripts predating that breakdown attribute the remainder to the 5m rate, which is the cheaper multiplier and so never over-bills.
Fast-mode usage is kept in a separate bucket because it bills at its own rate.

### Spend: the retention constraint

`cleanupPeriodDays` defaults to 30, and the account block reports only the current window.
Neither answers "what did last month cost", so `open-usage` keeps its own record in its config directory, written from first run.
The oldest day on disk is only partly covered, so re-measuring it takes the element-wise maximum against what was already banked rather than replacing it - otherwise Claude's pruning would erase history we had already recorded.

None of that worked until 2026-08-26.
The store serialised its day map under a `months` key while the parser read `days`, so every run parsed an empty map and re-derived the whole record from whatever transcripts were still on disk.
The retention constraint the file exists to solve was therefore never solved, and the partial-day maximum above never fired either, since there was never a banked value to compare against.
The writer now uses `days` and the parser accepts `days ?? months`, so records banked by 0.6.0 and earlier are recovered rather than discarded on upgrade.
Worth noting how it survived: the store had unit tests, but they exercised the pure fold functions and never wrote a file and read it back.
A round-trip test through `updateSpendStore` now covers both the current key and the legacy one.

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
codex -s read-only -a never app-server
```

Methods: `initialize` (client name/version), then `account/read` and `account/rateLimits/read`.
Sandboxed read-only with approvals off, a per-method timeout, and the child killed on overrun.
The original write-up used `-a untrusted`; codex-cli 0.149.1 dropped that value, so the flag is now `-a never`.
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
Writing the rotated token back into opencode's `auth.json` avoids that but means open-usage mutating another tool's credential store, which this app has so far deliberately never done.

### Implemented

Codex CLI 0.146.0 was installed, which made the CLI RPC route available, so no token is ever read, refreshed or transmitted by this app.
`src/data/real/codex-app-server.ts` spawns `codex -s read-only -a never app-server`, sends `initialize`, then `account/rateLimits/read`, `account/read`, and `account/usage/read`, and kills the child on every path including timeout and cancellation.

Ground truth beat the third-party docs in three places, all verified against `codex app-server generate-json-schema` and a live call:

- Fields are camelCase (`usedPercent`, `resetsAt`, `windowDurationMins`), not the snake_case in CodexBar's write-up. `resetsAt` is unix **seconds**.
- `primary` is not necessarily the session window. This Plus account reports a single **weekly** window (`windowDurationMins: 10080`) as `primary` with `secondary: null`, so windows are classified by their own reported duration - anything at or under six hours is the session lane - and position is only a fallback when the duration is absent.
- The response also carries `rateLimitResetCredits`, a free "reset my limits" grant. It surfaces on the card because it is the way out of a capped week.
  Each grant carries an `expiresAt`, so the card states the soonest deadline - the grant is use-it-or-lose-it and expires roughly a month after it is issued.
- `spendControlReached` is read as well. A spend control blocks the account at any percentage, so the meter beside it cannot explain why codex refuses to run, and this line outranks the grant when both apply.
- Still unread: `rateLimitReachedType` and `individualLimit`, both null on every account seen so far. Nothing renders them until there is a live reply to check against.

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
Codex therefore refreshes at startup and joins the 60-second application poll.
Hidden providers are never queried, failures back off for five minutes, and copied values expire after 15 minutes.
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
| `https://opencode.ai/_server` | Internal server query | browser session cookie | rolling, weekly, and monthly usage percent and reset; per-day per-model cost; per-session token and cost history | Exact dashboard values; server-function ids can change on deploy |
| Gateway `x-ratelimit-*` headers | HTTP | API key | undocumented | Unverified; capture opportunistically if we ever proxy a request, do not depend on it |

### Key finding

OpenCode's internal server query publishes exact percent-of-limit and reset data to an authenticated dashboard session.
Without a session cookie, open-usage computes an estimate locally by summing `message.cost` inside each window and dividing by the Go plan cap.
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
echo '{ "opencodeCookie": "auth=<value>" }' > ~/.config/open-usage/config.json
# or, per-shell:
export OPEN_USAGE_OPENCODE_COOKIE='auth=<value>'
```

Only the `auth` / `__Host-auth` cookies are sent; anything else in a pasted header is stripped before the request.
The cookie's Iron seal carries its own expiry, and the app warns during its final seven days.
Any session failure produces the same visible warning while the local estimate continues.
Without a cookie the app shows the local estimate and says so, which is why the cookie is optional rather than a setup step.
A cookie is also sufficient on its own: it counts as a go source with no opencode install present, so uninstalling opencode leaves the limits intact and costs only the local history.
That case is labelled rather than left blank - the card reads "no local history", the chart collapses to a rule, and the stated source becomes the dashboard instead of `opencode.db`.
This private integration is opt-in and not recommended for general distribution: OpenCode's hosted Terms prohibit programmatic extraction and reverse engineering.
Do not request a user's cookie during support, and do not add automatic browser-cookie extraction.

### Usage history

Verified against a live response on 2026-08-18, and cross-checked between the two endpoints below: every fully covered day agrees to the cent.

`getCosts(workspaceID, year, month, tzOffset)` backs the dashboard's Cost chart.
`month` is zero-based and `tzOffset` is a `+HH:MM` string, which is what decides the calendar day each row lands in.
It returns `{ usage, keys }`, where a usage row is `{ date: "YYYY-MM-DD", model, totalCost, keyId, plan }` and a key is `{ id, displayName, deleted }`.
`plan` is `"sub"`, `"lite"`, or absent for pay-as-you-go, and the dashboard stacks the three separately.

`usage.list(workspaceID, page)` backs the Usage History table, 50 rows a page.
A row is `{ id, workspaceID, timeCreated, timeUpdated, timeDeleted, model, provider, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens, cost, keyID, sessionID, byok, enrichment: { plan } }`.
Absent counts are an explicit `null`, and `timeCreated` arrives as a live `new Date("...")` constructor behind a `$R[n]=` binding rather than a number or a quoted string.

**Both endpoints report money in hundred-millionths of a dollar.** The client divides by `1e8`; taking `totalCost` at face value overstates by a factor of 100 million.
The dashboard counts cache reads and both cache writes as input: `inputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens`.

These are parsed by `src/data/real/opencode-usage.ts`, assembled by `go-spend-summary.ts`, and polled by `go-history-source.ts` every 30 minutes for the open month plus two closed ones.

Two wire details are easy to miss and both silently empty the result: a month with no traffic answers `usage:[]`, which is a valid response rather than a parse failure, and booleans are minified to `!0` / `!1` rather than `true` / `false`.

**These dollars are usage value, not money charged.**
`plan` decides which: `payg` rows are billed, while `sub` and `lite` rows are allowance consumption against a subscription that was already paid for at a flat rate.
The dashboard keeps the three in separate chart stacks for this reason, so any summary must keep the split rather than adding them into one "spend" figure.
Verified on a Go account whose `billing.get` reports `balance = 0`, `monthlyUsage = null` and `subscription = null` with only `lite` set: every row is `lite`, totalling $40.9177 in July, none of which was billed.

The real-money surface for a go account is `billing.get`: `balance`, `reloadAmount`, `reloadTrigger`, `monthlyLimit`.

Do not reconcile a calendar-month cost total against the `lite.subscription.get` monthly percent.
That percent covers a billing cycle rather than a calendar month, and `GO_QUOTA_WEIGHTS` records that some models burn quota four times faster per raw dollar, so dollars do not map linearly onto percent.

### Known fragility

The server function ids are content hashes that rotate whenever opencode.ai redeploys.
When they rotate, the parse fails, the UI falls back to the estimate with a note, and the ids need refreshing from `SERVER_FUNCTION_IDS`.

`src/data/real/opencode-bundle.ts` can recover most ids from the public client bundle, which pairs each `createServerReference("<hash>")` with the `query`/`action` key it was registered under - `workspaces`, `lite.subscription.get`, `usage.list`.
Those keys survive redeploys; the hashes do not.
Two details make a naive scan wrong: the bundle aliases a reference before registering it (`const getUsageInfo = getUsageInfo_1`), and the same key is registered by more than one route, so `usage.list` has two distinct hashes and callers must try candidates rather than trust the first.
`getCosts` is the one id with no recovery path, because the bundle calls it directly instead of registering it.

Discovery runs at runtime, as a recovery path only.
`callAndParse` tries the shipped id first and re-derives candidates from the bundle only once a response fails to parse, caching the result for the process.
Credential and rate-limit failures are rethrown rather than treated as drift, since a fresh id cannot fix either.

## Cross-cutting

### What the user must provide

Nothing today: all three providers ride on credentials already on disk from the tools' own logins.
Optional future inputs: a plan-cap override for opencode go, and a manual OpenAI OAuth re-login if the stored refresh token dies.

### Polling and freshness

Local files (`usage-snapshot.json`, `opencode.db`) are re-read on the existing 60s app poll and on `r` refresh.
Claude CLI usage is requested at most every three minutes, while the optional OpenCode server source uses a 60-second minimum interval.
Codex app-server runs during startup and interval polling, as well as on manual refresh.
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
