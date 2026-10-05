# Provider integration research

Researched 2026-08-01, re-verified 2026-08-03 (official documentation, upstream source, and local ground-truthing on this machine).
Where a published claim disagreed with this machine's own files, the measurement won; those cases are kept as corrections rather than quietly overwritten.
This is the implementation reference for wiring real limit data into open-usage for all three providers.

Verdict up front: all three providers can show real or near-real limit data, each through a different mechanism.

| Provider | Real percent-of-limit? | Best source | User must provide | Status |
| --- | --- | --- | --- | --- |
| claude code | Yes (5h, weekly, and every scoped weekly lane) | First-party `claude -p "/usage"`, then a fresh statusline snapshot | Claude Code installed and signed in | Shipped |
| codex | Yes, from the CLI itself | Codex CLI `app-server` JSON-RPC | Codex CLI installed and signed in | Shipped |
| opencode go | Yes with a cookie, else a spend estimate | `opencode.ai/console/api` REST, falling back to `opencode.db` spend vs caps | Optional session cookie for exact figures | Shipped |

## claude code

### Sources, best first

| Source | Type | Auth | Fields | Reliability |
| --- | --- | --- | --- | --- |
| `claude --safe-mode -p "/usage" --output-format stream-json --verbose --no-session-persistence` | first-party CLI | Claude Code's own login | `usage_report`: every meter by `kind` with an ISO reset time, plus extra-usage spend; the same reply's text as a fallback | Live account fetch with no model turn; the structured report is marked experimental, so the text stays the fallback |
| `~/.claude/usage-snapshot.json` | local file, rewritten every ~3s by the statusline | none | `rate_limits.five_hour.{used_percentage,resets_at}`, `rate_limits.seven_day.{used_percentage,resets_at}`, `context_window`, `cost`, `model` | Official schema and high confidence while fresh; goes stale otherwise |
| `GET https://api.anthropic.com/api/oauth/usage` | HTTP, undocumented (powers `/usage`) | OAuth bearer token + `anthropic-beta: oauth-2025-04-20` + `User-Agent: claude-code/<version>` | session %, weekly all-models %, weekly per-model %, reset timestamps | Reverse-engineered; 429s hard without the User-Agent header; poll no faster than ~180s |
| `~/.claude/projects/**/*.jsonl` | local transcripts | none | per-message token usage, model, timestamps | Usable for activity shape once de-duplicated (see below); never for accounting |
| `v1/organizations/usage_report/*` | HTTP, official | Admin API key | org-level tokens/costs | Official but orgs only; not applicable to a personal Max/Pro plan |

### Recommendation

Use the signed-in Claude CLI as the live source, with a conservative three-minute minimum poll interval and a ten-minute cache cutoff.
The command was verified locally on Claude Code 2.1.220: it completed in 627 ms with zero turns, zero tokens, and zero cost, and matched the Claude web dashboard at 10% session and 95% weekly usage.
Use the documented statusline schema only while its file is under ten minutes old.

### The structured /usage report

Re-verified 2026-10-06 against Claude Code 2.1.289.
In `stream-json` mode the CLI attaches a `usage_report` to the synthetic assistant line that carries the `/usage` text, and the result line repeats the text.
`usage_report.rate_limits.limits[]` holds one row per meter: `kind` (`session`, `weekly_all`, `weekly_scoped`), `group`, `percent`, `resets_at` as ISO 8601, `scope` naming a model or a surface by `display_name`, `severity` and `is_active`.
`usage_report.rate_limits.extra_usage` holds `is_enabled`, `monthly_limit`, `used_credits`, `utilization` and `currency`, with amounts in minor units of that currency.
The schema in the binary says to classify a row on `kind`, never on its label, and that a new meter needs no client release; `rate_limits` is null while the usage fetch is failing.

What open-usage does with it:

- Every `weekly_scoped` row becomes its own limit, model or surface, where the text parser only ever caught "current week (fable)".
- A lane's id comes from its scope alone, so notifications keep their state across polls: a model lane is its slugged name (Fable stays `fable`) and a surface lane is `surface-` plus its slug.
- `resets_at` gives every window a timestamp, so the reset countdown and the weekly burn projection work when the CLI is the only source; the text twin's reset prose still heads each row.
- Extra usage is shown as credits used of the monthly limit, and only while it is switched on.
- Rows of kinds open-usage does not render are skipped; a malformed row of a kind it does render, or a report without well-formed session and all-models rows, drops the whole report and the text from the same reply is parsed instead.
- The text parser learned every "current week (X)" lane too, under the same ids, so falling back loses only the reset timestamps.
- `severity` is not used: the meters already grade themselves at the 70% and 85% thresholds, and a server colour on the readout alone would disagree with its own bar.
- The child gets a closed stdin, because `stream-json` mode otherwise waits three seconds for piped input ("no stdin data received in 3s").

The persisted cache stores the scoped lanes and reset times, and still decodes entries written with the older `fable` key, so an upgrade keeps a valid reading.
While a fresh statusline snapshot covers the session and weekly windows, the CLI still runs every twenty minutes to keep the scoped lanes and extra usage current.

### Weekly share by surface

`~/.claude.json` caches `cachedUsageUtilization.utilization.seven_day_breakdown` as `{as_of, window_started_at, rows: [{key, display_name, percent}]}`, one row per surface such as Claude Code, Chats and Cowork.
It is a passthrough of the server's raw reply that Claude Code itself never reads, so nothing upstream holds its shape steady.
open-usage shows it as a "weekly share by surface" detail section, checks every field, requires the shares to sum to a whole within rounding, and omits the section on any mismatch or once the week it describes has ended.

### Plan tier

`claude auth status --json` reports `subscriptionType: "max"` for both Max plans.
`~/.claude.json` `oauthAccount.organizationRateLimitTier` carries the multiplier, `default_claude_max_20x` or `default_claude_max_5x`, which the card shows as "Max 20x" or "Max 5x".
Team seats carry the same tier strings, so the mapping applies only to a "max" subscription; an unknown tier, or a user-level tier that contradicts the organisation's, keeps the plain label.
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

`series` is therefore blended for every provider without exception, and that is now stated as an invariant on the type.
The rule has a second half, which opencode go later forced: a source may cover more than this device only if it reports every token kind separately, so the blended figure can be computed exactly rather than approximated.
Codex's bucket is a single pre-blended number, so it fails that test; opencode go's usage table passes it.
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

The table was last checked on 2026-10-06 against Anthropic's pricing page (platform.claude.com/docs/en/about-claude/pricing).
That check found Opus 5.5 unpriced, which on a machine that mostly used it left nearly the whole spend estimate unpriced.
Opus 5.5 is $4 / $20 per MTok with cache reads at $0.20, 5% of input rather than the usual tenth, and fast mode at $8 / $40.
Sonnet 5.5 is $2 / $10, and Sonnet 5 is $2 / $10 too, since its scheduled rise to $3 / $15 was cancelled.
Caching multipliers stack on fast-mode rates, so a model's own cache read rate scales with the fast input rate.

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

### Subscription end date: no trustworthy source

Researched 2026-09-18 against Claude Code on a Max account.
Nothing first-party states when the paid period ends: `claude auth status --json` carries `subscriptionType` only, `/usage` prints limits and no billing date, and `cachedUsageUtilization` has no cycle boundary.
The one derivable figure is a monthly anniversary of `oauthAccount.subscriptionCreatedAt` in `~/.claude.json`, and it was checked against the account's own billing page before being built.
It failed twice on the same account: the anniversary fell on the 17th while the billing page said the 18th, and the page said the plan would be *canceled* on that day, which a creation date cannot know.
The account's invoices were dated the 18th of each month, so the billing anchor is not the creation date at all, most likely because a plan change moved it.
A scan of the Claude Code 2.1.274 binary for period-end, next-billing, renewal and cancel-at field names found none, so the CLI never receives the date and no future local file can be expected to hold it.
A header reading "renews Oct 17" beside a plan that ends on Sep 18 is worse than no date, so the claude card states none.
The billing page itself is behind the web session cookie, which stays off limits for the reasons above.

## codex

### Sources, best first

| Source | Type | Auth | Fields | Reliability |
| --- | --- | --- | --- | --- |
| `GET https://chatgpt.com/backend-api/wham/usage` | HTTP, private (what Codex CLI's `/status` polls, ~60s) | `Authorization: Bearer <access_token>` + `ChatGPT-Account-Id: <account_id>` | `plan_type`, primary window (5h) and secondary window (weekly): `used_percent`, `resets_in_seconds`, `window_minutes`, credits | Private endpoint, may change; the whole tracker ecosystem (CodexBar, pi-codex-status) relies on it |
| `x-codex-primary-used-percent` / `x-codex-secondary-used-percent` | HTTP response headers | same token | live used-percent on any Codex API call | Real-time but only when traffic flows |
| `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | local files | none | `token_usage_record` lines (one per model response, since CLI 0.153.4); `token_count` events: cumulative tokens + nullable `rate_limits` snapshot | Offline fallback; `rate_limits` is sometimes null (openai/codex#14880); not present on this machine |
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
- `primary` is not necessarily the session window.
  A Plus or Pro 100 (`prolite`) account reports a single **weekly** window (`windowDurationMins: 10080`) as `primary` with `secondary: null`, so windows are classified by their own reported duration - anything at or under six hours is the session lane - and position is only a fallback when the duration is absent.
- The response also carries `rateLimitResetCredits`, a free "reset my limits" grant. It surfaces on the card because it is the way out of a capped week.
  Each grant carries an `expiresAt`, so the card states the soonest deadline - the grant is use-it-or-lose-it and expires roughly a month after it is issued.
- `spendControlReached` is read as well. A spend control blocks the account at any percentage, so the meter beside it cannot explain why codex refuses to run, and this line outranks the grant when both apply.
- `rateLimitReachedType` and `individualLimit` are read too, though both are null on every account seen so far.
  A workspace credits-depleted or usage-limit classification puts a red line on the card, and any other value stays quiet, since an unknown value is likelier a not-reached sentinel than a new block.
  `individualLimit` becomes the `monthly-credit` lane, as a percentage only until a real workspace payload settles whether its figures are dollars or cents.
- `ordinaryUsageAllowed`, on the response rather than the snapshot, is the backend's own verdict on included usage, and its schema says clients must not infer recovery from percentages or reset times.
  A `false` shows "included usage blocked" in red whatever the meters read.
  A spend control or workspace block outranks it, because each names the reason the bare verdict leaves out; it outranks the grant, which rides along as a count.
  A null or missing value is unknown, not allowed.
  Desktop notifications consult it too: the same causes become the provider's `usageBlock`, so a week that resets under a standing block is announced as a partial reset rather than as ready.
- A per-model lane is named by `limitName`, then `normalModelSlug` - the model the schema says describes the quota alias - and only then by its opaque `limitId`.

`account/read` supplies the real plan name, which replaces the opencode-derived stand-in label.
The wire names are not the marketed ones, so the card uses the labels codex's own `/status` prints (`codex-rs/tui/src/subscription.rs`): `prolite`, `pro` and `promax` are Pro 100, Pro 200 and Pro 500, `go` is Go, `team` is Business, and `self_serve_business_prolite` is Business Premium.
A plan added after that falls back to its title-cased wire name.

### Usage history

`account/usage/read` returns server-side history and is the best token source available for any provider here:

```
summary: { lifetimeTokens, peakDailyTokens, longestRunningTurnSec, currentStreakDays, longestStreakDays }
dailyUsageBuckets: [{ startDate: "YYYY-MM-DD", tokens }]
```

Buckets are sparse - idle days are absent rather than zero - so they are mapped onto the chart's date keys rather than consumed positionally.
This supersedes the opencode-derived series for codex, which only ever saw traffic opencode itself sent: server history reports a 110M peak day against opencode's 4M.
The call is treated as a bonus, so limits still render if a future CLI drops the method.

### Local rollouts

The chart, burn rate and local footer come from the rollout files, counted on the blended basis: input minus cached input, plus output.

Since codex-cli 0.153.4 a rollout carries a top-level `token_usage_record` line per model response: `{thread_id, turn_id, response_id, usage, turn_token_usage, thread_token_usage}`, each usage block holding `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` and `total_tokens`.
A record is written just before the `token_count` for the same call, and its own `timestamp` is the one bucketed.
A file with records is counted from them alone, deduplicated by `response_id`; the `token_count` events an older CLI wrote before a resumed session's first record still count.
A record without the input and output breakdown is treated as drift and skipped, so the file falls back to its token counts rather than charting the session idle or passing a cache-inclusive total off as blended.

The records replaced summing `token_count.info.last_token_usage`, which drifted both ways.
Codex re-emits `token_count` with a stale `last`, so the sum over-counted, and a compaction call gets no `token_count` at all, so every session that compacted was under-counted.
Older rollouts with no records now step through the cumulative `total_token_usage` instead, which a re-emit leaves unchanged.
The first event uses its own `last`, because a forked session's cumulative total opens on its parent's usage, which the parent's rollout already counts.

Checked 2026-10-06 against 26 real rollouts, 25 of them with records.
Each file's reference is codex's own running total: the last record's `thread_token_usage` less what the thread inherited, or for the one older file its final cumulative total.
The old sum was off by 6.2% in aggregate, from +9.6% to -19.0% per file, the worst being sessions that compacted; the new reader matches every file exactly.

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

`account/rateLimits/read` accepts `excludeResetCreditDetails: true` for background polls, which skips a backend lookup but leaves only the grant count.
It is not sent: without the grant list there is no expiry, and the deadline on a use-it-or-lose-it grant is the part of that line worth reading.

### Re-verified 2026-08-02

CLI 0.146.0 is current, and the core `account/*` methods are stable enough that the official VSCode extension depends on them.
The app-server carries no breaking-change guarantee, so the parser stays defensive.

`openai/codex#32707` reports Pro accounts losing the 5-hour bucket from `account/rateLimits/read`.
That is the exact shape our duration-based classification already handles - a lone window is placed by its own `windowDurationMins` - whereas a positional `primary → session` mapping would mislabel it. The choice made under uncertainty turns out to be the one that survives the schema moving.

Fields then left unread: `rateLimitsByLimitId`, `individualLimit` and `spendControlReached`, which only carry anything beyond the main bucket on Team/Business plans with workspace spend controls, and `rateLimits.credits`, which reads `balance: "0"` on an account with no add-on credits.
All four are read now, defensively: the by-id map supplies the per-model lanes, and a positive or unlimited credit balance gets its own detail section.

`account/usage/read` counts cached input tokens toward its totals with no separate breakdown, which is consistent with how those tokens count against the rate-limit windows.

### Deliberately not built: redeeming a reset credit

`account/rateLimitResetCredit/consume` would let the app spend the free reset it already displays.
That is a one-way account action, and this is a read-only dashboard: every other call it makes can be repeated with no consequence.
Burning a scarce credit from a background poller - or from a mis-keyed keystroke - is not a failure mode worth introducing for convenience. If it is ever added it should require an explicit confirmation, never a bare keybinding.

### Subscription end date

The app-server reports `planType` but not when the plan runs out.
The id token in `~/.codex/auth.json` does: its `https://api.openai.com/auth` claim carries `chatgpt_subscription_active_until`, beside `chatgpt_subscription_active_start` and `chatgpt_subscription_last_checked`.
`codex-subscription.ts` decodes that one claim from the local file and nothing else; the token is never kept, logged or sent, so this adds no credential handling to the RPC path above.
Checked 2026-09-18 against the ChatGPT billing page, which read "Your plan auto-renews on Oct 5, 2026" while the claim read 2026-10-05.
The card header shows it as `Plus · until Oct 5`, on the existing header row so no meter moves.
The wording is "until" rather than "renews" because the claim states when the paid period stops, not whether it will be renewed.
Codex only rewrites the token when it next refreshes its sign-in, so a date already in the past is a stale reading rather than a lapsed plan, and the header omits it instead of guessing which.

A token refresh does not refresh the claim either.
Observed in October 2026: an id token reissued days earlier still carried a `chatgpt_subscription_last_checked` a month old and a `chatgpt_subscription_active_until` already past, on an account that was still active.
The subscription fields are a snapshot the auth server re-checks on its own schedule, so the date can lapse while the plan renews, and the header showing nothing then is the intended behavior rather than a fault.

## opencode go

### Sources, best first

| Source | Type | Auth | Fields | Reliability |
| --- | --- | --- | --- | --- |
| `~/.local/share/opencode/opencode.db` | SQLite | none | `session` table: `cost` (USD), `tokens_input/output/reasoning/cache_*`, `model`, `time_created`; `message`/`part` JSON blobs | Official local store, already read by the app; 154MB and active on this machine |
| Published Go plan caps | docs | none | $12 per 5h, $30 per week, $60 per month (Go plan, 2026 pricing; verify against the dashboard before shipping) | Documented but must be re-checked when plans change |
| `https://opencode.ai/console/api` | Console REST API | browser session cookie | Go meters in dollars with their resets; per-day cost, tokens and requests; per-request usage rows; balance and auto-recharge | Exact console values; the routes are the console's own and can change on deploy |
| Gateway `x-ratelimit-*` headers | HTTP | API key | undocumented | Unverified; capture opportunistically if we ever proxy a request, do not depend on it |

### Key finding

OpenCode's console publishes exact dollars-of-limit and reset data to an authenticated session.
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

`src/data/real/opencode-server.ts` calls the console's REST API with the filtered session cookie and an `x-org-id` header naming the workspace.
`GET /console/api/orgs` discovers that id once; `GET /console/api/go/status` returns the plan.
Its `access.meters` carries `fiveHour`, `week` and `month`, each `{ startsAt, resetsAt, limitMicroCents, usedMicroCents }`, so the percentage is computed from dollars rather than read off the wire.
The month meter has no `resetsAt` of its own: `access.endsAt`, the plan's renewal, is what clears it, which is what the console's own card shows.
An unused five-hour window reports `resetsAt: null`, which the card states rather than inventing a reset five hours out.
`go-limits-source.ts` polls it at most once a minute, backs off five minutes on failure, and degrades to the estimate on any error.

### The September 2026 console migration

The dashboard moved to `opencode.ai/console` and dropped the serialized-JavaScript `_server` RPC entirely.
Every workspace-scoped function id - `lite.subscription.get`, `usage.list`, `getCosts`, `billing.get` - now answers `302 -> /console/login` regardless of the session, so the content-hash self-healing that recovered rotated ids (`opencode-bundle.ts`, `seroval-text.ts`) had nothing left to recover and was deleted.
The console authenticates with its own `__Host-console_session` cookie; the older Iron-sealed `auth` cookie still works against the legacy app and is refused by `/console/api/*` with `401 {"_tag":"Unauthorized"}`, which is why an upgrade had to be a re-paste rather than a migration.
A 400, 404 or 422 from the API is reported as drift rather than a network failure: the console answers a query it no longer understands with `400 {"_tag":"BadRequest"}`, and retrying that on the normal schedule would never recover.

### Enabling server limits

Server limits currently need an opencode.ai session cookie, which is a full dashboard credential:

```bash
# from a logged-in opencode.ai/console tab: devtools > application > cookies
echo '{ "opencodeCookie": "__Host-console_session=<value>" }' > ~/.config/open-usage/config.json
# or, per-shell:
export OPEN_USAGE_OPENCODE_COOKIE='__Host-console_session=<value>'
```

Only the `__Host-console_session` / `console_session` / `auth` / `__Host-auth` cookies are sent; anything else in a pasted header is stripped before the request, so pasting the whole header is safe.
The console session id carries no expiry, so there is nothing to warn on; a pasted `auth` cookie still has its Iron seal, and the app warns during its final seven days.
Any session failure produces the same visible warning while the local estimate continues.
Without a cookie the app shows the local estimate and says so, which is why the cookie is optional rather than a setup step.

`src/data/real/opencode-api.ts` implements the proposed `GET /zen/go/v1/usage` route against `opencodeApiKey` / `OPEN_USAGE_OPENCODE_API_KEY`.
That route is not merged and 404s in production, so `readCredential` deliberately ranks the cookie above it: a configured key must never cost a user readings they already had.
Flip that precedence once the endpoint ships and its response shape is known, and narrow the field aliases in `opencode-api.ts` to the documented ones at the same time.
A cookie is also sufficient on its own: it counts as a go source with no opencode install present, so uninstalling opencode leaves the limits intact and costs only the local history.
That case is labelled rather than left blank - the card reads "no local history", the chart collapses to a rule, and the stated source becomes the dashboard instead of `opencode.db`.
This private integration is opt-in and not recommended for general distribution: OpenCode's hosted Terms prohibit programmatic extraction and reverse engineering.
Do not request a user's cookie during support, and do not add automatic browser-cookie extraction.

### Usage history

Two console routes feed the history: the per-day cost chart for money, and the request log for tokens, models and sessions.
Both were re-verified against live responses on 2026-10-06, after the console's backend move broke each of them in a different way.

#### The request log replaced the usage table

Verified against live responses on 2026-10-06.

`GET /console/api/usage/rows` now answers `404` with an empty body.
The console's request log took its place: `GET /console/api/request-logs?since=<epoch ms>&category=inference&limit=<1-100>`.
A page is `{ items, nextCursor, until, retentionDays: 30 }`, newest first.
The next page repeats `cursor=<nextCursor>` together with `until=<until>` from the first page, which is how the console's own "older" button pins the walk so a request landing mid-walk cannot shift every later page by a row.
A cursor the server no longer honours answers `409 RequestLogCursorRestartRequired`, which the client treats as a transient failure and walks again on the next poll.
A light workspace's 30 days take about a dozen pages.

An item carries `id` and `requestID` (both unique per request), `startedAt` and `finishedAt` in epoch milliseconds, `sessionID`, `model` and `requestedModel`, `product`, `app`, `statusCode`, `outcome`, `errorCode`, `durationMs`, `timeToFirstTokenMs`, `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cacheWrite1hTokens` and `cost`, plus request metadata the client never reads.
Unlike the cost chart, counts are numbers and `cost` is plain dollars (`0.16084381`), not micro-cents.
The walk joins rows across polls by `id`, as it joined the old table's row ids.
Old table ids share nothing with request ids, so the cache moved to version 2 and a version 1 file keeps its cost months but drops its rows.

`outcome` is `succeeded`, `failed` or `rejected`.
A rejected request is refused before inference ran, such as the `429` at a Go cap, and carries no counts and no cost.
A succeeded request missing its counts fails the page as drift, since a renamed field would otherwise read as a month of zero usage.

`reasoningTokens` is part of `outputTokens`, not a sibling: across 506 live requests that reported reasoning it never exceeded output, and one grok-4.7 request reported 16855 of its 16926 output tokens as reasoning.
The parser stores output net of reasoning, which is the shape `opencode.db` uses, so every downstream sum stays exact and nothing is counted twice.
The console lists `cacheWriteTokens` and `cacheWrite1hTokens` on separate lines, as the old table's 5m and 1h fields were, and the client adds them.
No Go model has reported a cache write yet, so that the two never overlap is the console's presentation rather than a measurement.

There is no billing source any more; `product` names what served the request.
Every request seen on a Go plan is `go`.
The console's own code treats `standard`, `go` and `go-plus` as opencode-served and every other product as a request through the workspace's own provider connection.
So `standard`, Zen's pay-as-you-go drawn from credit, is reported as billed, and everything else as allowance: `go` and `go-plus` consume a subscription already paid for, and opencode does not bill a request routed through the workspace's own provider.
Whether a request served from credit after a Go cap ("extra usage", `useBalance`) is labelled `go` or `standard` has not been observed.

The log's retention is 30 days, but it only reached back to the console migration on 2026-09-20; earlier requests are in the cost chart's totals and nowhere else.

#### The cost chart reaches back 30 days and no further

`GET /console/api/usage/cost-by-day?range=30d&bucket=day` backs the console's cost chart.
A row is `{ date: "YYYY-MM-DD", totalCostMicroCents, totalTokens, totalRequests }`, dated in UTC; a day with no traffic is simply absent.
It names no model, which is why a closed month's cost rows carry `model: null` rather than a guess.

**Money is micro-cents on the chart: `1e8` to the dollar.** Taking `totalCostMicroCents` at face value overstates by a factor of 100 million.
Token counts and costs both arrive as decimal strings, not numbers.

Until the October 2026 backend move one call with `since=<first day of the oldest month>` covered three months.
Now any `since`, with or without `range`, answers with the last two days alone, whatever date it names, while `range=30d` without `since` returns the full 30 days and `range=7d` the last week.
`includeLegacyKeys=true` and `userId`, which the console adds for a member's own view, change nothing.
The console's bundle shows why it never noticed: it sends `since` only with `range=24h` for its "today" view, and `range` alone for 7 and 30 days.
Whether anything older than 30 days survives the move is unknown, since no route reaches it.

The 30-minute poll used to read three months in that one call and rebuild them from the reply, and `fetchGoUsageHistory` turned a month the reply left out into an empty one.
So once `since` broke, the first poll after the move overwrote the banked August and September with $0 months.
Now the client asks for `range=30d` and folds the reply into what it already holds, in `go-cost-history.ts`:

- a day inside the reply's window takes the server's figure;
- a day outside it is kept as banked, since the reply never asked about it;
- the window's first day is cut part way through, so coverage starts the day after and that partial figure never replaces a whole one;
- a reply that leaves out a day with spend it once reported inside its own window is not trusted for coverage, and the card says "opencode cost history changed - showing saved months".

Alongside the days the reading keeps `costCoverage`, the merged runs of days some reply has answered for in full.
That is what tells an unspent month from an unknown one, which `SpendPeriod` already expresses: a month with no coverage and no banked days is `exactness: "unavailable"` with `isBeforeRecordsBegan`, and the history line reads "not recorded" instead of dropping it as zero.
A month covered only from some day on keeps its figure with `totalWindowLabel` "from sep 6", and one with scattered coverage, or banked days from a version 1 cache that recorded none, reads "partial record".
Only a month wholly covered and unspent is dropped from the line.

These are parsed by `src/data/real/opencode-usage.ts`, merged by `go-cost-history.ts`, assembled by `go-spend-summary.ts`, and polled by `go-history-source.ts` every 30 minutes for the open month plus two closed ones.
Money for every month comes from the day chart; the per-model breakdown comes from the request log, which reaches back 30 days, so the open month names its models and closed ones report totals alone.

`usage.list`, the console table's predecessor, was parsed but never fetched until 2026-08-26, which left the cookie a second-class source: it reported exact limits and per-day cost, and then said "no history" because `opencode.db` was the only thing wired to `series`.
That database does not exist until opencode has been installed and used, so a cookie-only setup - which the dashboard fully supports - had no activity chart at all.
`fetchGoUsageRows` now walks the request log back over the 30-day window and `go-activity.ts` folds it into the same shape `opencode.db` produces, so one rendering path serves both.

Two properties make this safe to put on the shared axis.
The log reports every token kind separately, so the blended basis is computed exactly rather than approximated - `input + output + cacheWrite + cacheWrite1h`, with reasoning already inside output, which matches the local `TOKENS_SQL` term for term once output is stored net of reasoning; cache reads are carried in `cacheRead30d` as they are everywhere else.
And it covers the whole workspace rather than this device, which is a wider population than the other providers report, so the provider sets `seriesScope: "workspace"` and the UI says so rather than leaving the reader to assume.
`sessionID` is back on every request, so the workspace card reports a session count again, and rejected requests are kept out of the token totals and the top model.

The dashboard outranks `opencode.db` when both exist, and replaces it rather than adding to it: the two describe overlapping sessions, so summing them would double count.
The walk ends when the console stops sending a cursor, capped at 60 pages, and walks only back to the newest row already held, so a poll half an hour after the last costs a page or two.
A failure part way through fails the walk and keeps the rows already held: returning the newest pages alone would leave a hole between them and the held rows that no later walk would fill.
If the log changes shape the held rows stay on screen and the card says "opencode request log changed - showing saved activity"; that flag is persisted with the reading, so a dashboard adopting the daemon's reading says so too.
On a live Go account cache reads ran to several times the blended total, which is why they are held out of it.

Two wire details are easy to miss and both silently empty the result: a month with no traffic answers `usage:[]`, which is a valid response rather than a parse failure, and booleans are minified to `!0` / `!1` rather than `true` / `false`.

**These dollars are usage value, not money charged.**
`plan` decides which: `payg` rows are billed, while `sub` and `lite` rows are allowance consumption against a subscription that was already paid for at a flat rate.
The dashboard keeps the three in separate chart stacks for this reason, so any summary must keep the split rather than adding them into one "spend" figure.
Verified on a Go account whose `billing.get` reports `balance = 0`, `monthlyUsage = null` and `subscription = null` with only `lite` set: every row is `lite`, totalling $40.9177 in July, none of which was billed.

The real-money surface for a go account is `GET /console/api/billing/status` (`balanceMicroCents`, `creditLimitMicroCents`) alongside `GET /console/api/billing/auto-recharge` (`enabled`, `thresholdDollars`, `rechargeAmountDollars`).
The console publishes no metered month total, so the spend view reports the cost rows rather than a figure it was never given.

The monthly window's reset doubles as the plan's end date: the header reads `Go · until Oct 9`, on the same terms as codex and only when the server reports the window.
The local estimate never states one, since its cycle anchor is inferred rather than reported.

Do not reconcile a calendar-month cost total against the `go/status` monthly meter.
That percent covers a billing cycle rather than a calendar month, and `GO_QUOTA_WEIGHTS` records that some models burn quota four times faster per raw dollar, so dollars do not map linearly onto percent.

### Known fragility

The console's routes and response shapes are its own, not a published API, and the September 2026 migration showed how completely they can change.
When a route moves or a field is renamed, the parse fails, the UI falls back to the estimate with the drift note, and the paths in `opencode-server.ts` need refreshing against a logged-in console tab.

There is no self-healing here, and deliberately so: the ids that once justified it are gone, and a REST path cannot be re-derived the way a content hash could.
What the client does instead is keep the three failure classes apart, since only one of them is drift.
A 401 or 403 is credentials, a 429 carries the console's own `Retry-After`, a 400/404/422 is drift, and anything else is a network failure.
Credential and rate-limit failures are never retried as drift, because a different query cannot fix either.

### No plan attached

A workspace whose subscription has ended answers `GET /console/api/go/status` with `access: null` rather than an error or a changed shape.
That is an account state the user chose, so it is reported as "no opencode go subscription" instead of the drift note, and the source reads as having nothing to fetch rather than as a failed read.
Drift is not confusable with it: a payload missing `access` entirely is a parse failure, while `access` present and null is the account state.
`billing/status` keeps answering through all of this, and is where the balance behind the fuller warning comes from.

The API-key path meets the same state as a `401` carrying `{"type":"CreditsError","message":"Insufficient balance..."}`, which is the response opencode gives an agent once a workspace has neither a plan nor credit.
It shares the status code with a rejected key, so the body is what tells the user to top up rather than to re-paste a key that is fine.

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
