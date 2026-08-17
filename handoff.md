# Handoff

## Goal

Answer, on the Claude Code screen, what a month cost and where the money went: total input and output tokens for the month, cost, per model, plus real credit spend for people running on usage credits.
Originated from a friend of the user who is on credits and can currently only see per-day token counts with no cost and no model attribution.

## Current State

### What works

Claude Code spend is built, committed, and verified end to end against real local data.

- `bun run typecheck` clean, `bun test` **574 pass / 0 fail** across 52 files.
- Verified on this machine: 18 days of transcripts, 5 models, August total `$3,289.72` with the per-model parts summing exactly to the headline.
- Renders correctly in real mode: `bun run preview -- --real --no-poll --screen detail --view claude`.
- Committed as `ad3b3a3`. The design spec is `bf5ac87`.

### What is broken

Nothing known. Working tree is clean.

### What is blocked

**OpenCode Go server history is NOT implemented**, and is the main outstanding work.

It is blocked on verification, not on knowledge.
The dashboard returns seroval-encoded `$R[n]` rows and only fragments of that payload have ever been seen (a DevTools screenshot showing `{ date, model, totalCost, keyId, plan }`).
Writing a parser for a shape never actually decoded would be unverifiable, so it was deliberately not written.

Unblock with either:

1. The user configures the opencode.ai cookie (`OPEN_USAGE_OPENCODE_COOKIE`, or `opencodeCookie` in `~/.config/open-usage/config.json`) so open-usage can call `_server` itself and the real response can be decoded, or
2. A re-run of the browser capture with the response body decoded. Note: the Claude Code permission classifier blocked `mcp__claude-in-chrome__javascript_tool` and `navigate` partway through the last attempt on opencode.ai.

## Active Files

New, this session:

- `/Users/gazirefatul/Projects/open-usage/src/data/real/pricing.ts` - per-model USD rates, cache-TTL multipliers, fast-mode rates, `~/.config/open-usage/pricing.json` overrides. Only ever apportions or estimates.
- `/Users/gazirefatul/Projects/open-usage/src/data/real/claude-account-usage.ts` - parses `~/.claude.json` -> `cachedUsageUtilization.utilization` for real credit spend, cap, balance.
- `/Users/gazirefatul/Projects/open-usage/src/data/real/spend-store.ts` - persists `~/.config/open-usage/spend-history.json`: spend cycles as a high-water mark, tokens per local day per model.
- `/Users/gazirefatul/Projects/open-usage/src/data/real/claude-spend.ts` - assembles account usage + store + price table into the `SpendSummary` the UI renders.
- `/Users/gazirefatul/Projects/open-usage/src/lib/spend.ts` - presentation helpers: `formatMoney`, `shortModelName`, `modelShares`.

Modified, this session:

- `/Users/gazirefatul/Projects/open-usage/src/data/types.ts` - added `Exactness`, `Money`, `TokenSplit`, `ModelSpend`, `SpendPeriod`, `SpendSummary`; `ProviderUsage.spend?`.
- `/Users/gazirefatul/Projects/open-usage/src/data/real/claude-transcripts.ts` - added `dayModelTokens`, `earliestMs`, cache 5m/1h TTL split, `speed`, `emptyTranscriptAggregate()`, `dayStartMs()`.
- `/Users/gazirefatul/Projects/open-usage/src/data/real-provider.ts` - added `claudeConfig`, `spendHistory`, `pricingOverrides` paths; reads account usage, records the store, builds the summary.
- `/Users/gazirefatul/Projects/open-usage/src/data/real/claude-provider.ts` - accepts and passes through `spend`.
- `/Users/gazirefatul/Projects/open-usage/src/screens/provider-detail.tsx` - the `Spend` section component.
- `/Users/gazirefatul/Projects/open-usage/src/data/mock-provider.ts` - sample spend summary for demo/preview.

Relevant but untouched, needed for the OpenCode work:

- `/Users/gazirefatul/Projects/open-usage/src/data/real/opencode-server.ts` - already calls `https://opencode.ai/_server`; holds `SERVER_FUNCTION_IDS` and the generic `callServer()`.
- `/Users/gazirefatul/Projects/open-usage/src/data/real/opencode-db.ts` - `DAILY_COST_ROWS_SQL` already computes per-day cost; needs only `model` added to its `GROUP BY` to match the dashboard chart. **No `opencode.db` exists on this machine** (checked `~/.local/share/opencode`, `~/Library/Application Support/opencode`, `~/.opencode`, `~/.config/opencode`), because the user reaches OpenCode Go through `pi`.

Docs:

- `docs/superpowers/specs/2026-08-17-spend-and-history-design.md` - the approved design spec.
- `docs/PROVIDERS.md` - new "Spend" subsections under claude code, with the verified field shapes.
- `README.md` - new "Spend" section under "What it reads".
- `ARCHITECTURE.md` - new readers added to the module tour table.

## Changes Made

### Verified facts about Claude Code (2.1.233), established by direct probing

These are the load-bearing findings. Do not re-derive them.

- **Cost per token is stored nowhere.** Transcript assistant lines carry `usage` counts only, no `costUSD`.
- **Hooks carry no cost.** `Stop` and `SessionEnd` were probed with a temp `--settings` file: they receive only `session_id`, `transcript_path`, `cwd`, `prompt_id`, and similar. No cost, no usage.
- **Claude Code's internal `costLedger` is in memory** (`pr.costLedger.modelUsage()`, `costLedger.restore(...)` in the binary) and dies with the session. Not persisted anywhere on disk.
- **`total_cost_usd` and the per-model `modelUsage` map** exist, but only via headless `claude -p --output-format json` or the statusline payload, neither of which covers interactive use.
- **Real money IS available, zero-install**, at `~/.claude.json` -> `cachedUsageUtilization.utilization`:
  - `spend` = `{ used: {amount_minor, currency, exponent}, limit, balance, cap, percent, enabled }`
  - `extra_usage` = `{ is_enabled, monthly_limit, used_credits, utilization, currency, decimal_places, spend_limit_reached, credits_ever_enabled, daily, weekly }`
  - `five_hour` / `seven_day` each carry `limit_dollars`, `used_dollars`, `remaining_dollars`
- **On this user's account credits are OFF** (`is_enabled: false`), so every credit field reads `null`. The populated shape has never been observed; the reader parses defensively.
- **Transcripts are pruned at `cleanupPeriodDays`, default 30.** Oldest on disk here is 2026-07-30.

### Key decisions, with rationale

1. **Zero-install only.** An earlier design tapped the statusline for exact per-session cost. The user rejected it: it only works for people who already run a statusline, and it would edit `~/.claude/settings.json`, breaking the README's "nothing is written outside its own config directory" promise. That promise still holds exactly.
2. **The price table only apportions.** Where Claude reports an exact total, per-model costs are priced, normalised, and scaled to it, with the rounding remainder given to the largest row. So the parts always sum to the headline, and a stale price shifts the split but never the total. Where no exact figure exists, the priced value shows directly, labelled `est` with the price date.
3. **Spend is an odometer, tokens are events.** `used_credits` is cumulative within a cycle: readings are sampled and the running **maximum** kept, never summed. Summing would overstate by ~1000x per day at a 60s poll. A drop below the max means the cycle reset, so the peak is banked. Tokens carry timestamps, so they are bucketed **per local day**.
4. **Per-day, not per-month, buckets.** Billing cycles do not align to calendar months, so only per-day figures can be summed over an arbitrary window without mixing one window's tokens with another's money.
5. **Codex is out of scope for cost.** Rollout files carry only blended `total_tokens` with no input/output split, so no honest dollar figure is derivable.
6. **Deviation from the spec:** the spec proposed adding `"all"` to `RANGE_KEYS`. Instead the README was corrected to match the code. Implementing `all` properly means sourcing the chart from the new store rather than the fixed 30-entry series, which is separate work and not needed for spend. This was a deliberate call, not an oversight.

### Two real bugs found and fixed during implementation

- **Window mixing.** The first design apportioned a billing-cycle total across calendar-month tokens. Worse, a cycle's start is only learned when first observed, so on day one you would see an exact total with zero model rows. Fixed: tokens always use the calendar month; the exact total is apportioned only when the observed cycle demonstrably covers that month, otherwise it keeps its own `totalWindowLabel` and the split stays an estimate.
- **Pruning boundary erased history.** The oldest day on disk is only partly covered, so re-measuring it replaced a larger banked figure with a smaller one. Fixed: `recordDayTokens` takes the element-wise maximum for partly covered days and replaces only fully covered ones. Guarded by `earliestMs`.

### OpenCode Go: captured but unused

Two server function ids were captured live from the logged-in dashboard by patching `window.fetch` and reading `X-Server-Id`:

```
bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c   GET,  args in query
15702f3a12ff8bff357f8c2aa154a17e65b746d5f6b96adc9002c86ee0c15205   POST, args in body
```

Both live in the usage route's `index` chunk. They produce the rows behind the Cost chart and Usage History table (per-day, per-model, exact cost, with input/output token counts and month navigation).

**Self-healing discovery:** the client bundle names every server function with a `<name>_query` / `<name>_action` symbol adjacent to its hash. Confirmed by matching `getWorkspaces_query` -> `def39973...`, which is exactly what `opencode-server.ts` already hardcodes. So the ids can be recovered by scanning the bundle rather than shipping hashes that rot on redeploy. Other ids seen: `getUserEmail_query`, `queryBillingInfo_query`, `querySessionInfo_query`, `createCheckoutUrl_action`, `createWorkspace_action`, `_logout_action`.

**Unverified, needs checking:** the hardcoded `liteSubscription` id `c7389bd0e731f80f49593e5ee53835475f4e28594dd6bd83eb229bab753498cd` in `opencode-server.ts` did **not** appear in the chunks loaded on the Usage page. That may mean it has gone stale and Go limits are silently falling back to the local estimate, or it may simply live in a chunk that route does not load. It was never confirmed either way. Worth a separate look.

## Failed Attempts

- **Statusline tap for exact per-session cost.** Technically worked (`cost.total_cost_usd` is cumulative per session; verified `$13.4641` identical across 7 snapshot temp files). Rejected by the user: too specific to their own configuration, does not scale to people without a statusline.
- **`rg -l totalCostUSD ~/.claude`** to find a persisted cost ledger. Only hit the current session's own transcript, which merely echoed the search string. No persisted ledger exists.
- **`mcp__claude-in-chrome__read_network_requests`** does not expose headers or request bodies, so it could not reveal the `_server` function id. Had to patch `window.fetch` in-page instead.
- **First fetch-patch attempt failed silently** because the patch was installed after the usage route had already loaded. Fix: patch on a different page (`/billing`), then SPA-navigate into Usage so the patch survives.
- **The replay loop hung the renderer** (`CDP sendCommand "Runtime.evaluate" timed out after 45000ms`) because the replayed fetches went back through the patched `fetch` and grew the array being iterated. `window.__cap` reached 120 entries.
- **Two `javascript_tool` outputs were rejected** with `[BLOCKED: Cookie/query string data]` for containing query-string-like content. Workaround: return only field names and truncated ids, never raw query strings.
- **`mcp__claude-in-chrome__navigate` to `/go` and a follow-up `javascript_tool` call were both denied** by the Claude Code auto-mode permission classifier, which is what stopped the `liteSubscription` staleness check.
- **`bun run shot` cannot select a screen.** It drives key presses, not `--screen` / `--view`; `--keys 2` and `--view claude` both still rendered the overview. Use `bun run preview -- --screen detail --view claude` for layout checks instead. Note `bun run shot` also writes a stray file named `--screen` into the repo root if the out-path argument is omitted.
- **`timeout` is not installed on this machine** (macOS). Use `gtimeout` or omit.
- **First UI layout right-aligned the meters**, which left a large dead gap at 140 columns. Changed to a left-grouped `name / value / bar / percent` row.

## Next Steps

**First action on resume:** decide whether to implement OpenCode Go server history, and if so unblock verification first by asking the user to configure the opencode.ai cookie so the `_server` response can actually be decoded before a parser is written.

Then, in order:

1. Add the two captured function ids to `SERVER_FUNCTION_IDS` in `/Users/gazirefatul/Projects/open-usage/src/data/real/opencode-server.ts` and write a parser for the seroval `$R[n]` rows, **against a real decoded response**.
2. Add bundle-scan id recovery so the hashes self-heal on redeploy, removing the standing "expected drift" caveat in that file's own header comment.
3. Build a `SpendSummary` for the `go` provider and wire it through `go-provider.ts`. OpenCode needs no local store: the server already keeps the history.
4. Check whether the hardcoded `liteSubscription` id has gone stale.
5. Optional, lower value: add `model` to `DAILY_COST_ROWS_SQL`'s `GROUP BY` in `opencode-db.ts` for the zero-network local fallback. Cannot be tested on this machine, which has no `opencode.db`.

Verify with `bun run typecheck`, `bun test`, and `bun run preview -- --real --no-poll --screen detail --view opencode`.
