# Spend and history

Status: draft, awaiting review.
Date: 2026-08-17.

## Problem

Today `open-usage` answers "how much of my plan is left right now".
It cannot answer "what did this month cost me, and where did the money go".

The concrete request that started this:

> total input and output token for the whole month and how much did it cost [...]
> akhon ami just per day koto token input/output hoise just oitai dekhtesi
> also kon model kokhon change hoise

Three questions, none currently answerable:

1. What did I spend this month, in money.
2. How many input and output tokens, split by model.
3. Which model was I on, and when did that change.

The asker is running on credits, so for them question 1 is about real money leaving a real balance.

## Guiding rule

Every number on screen is either exact and labelled exact, or estimated and labelled estimated.
Nothing is a guess wearing the costume of a fact.

This is the same rule that already governs the OpenCode Go percentages, which are labelled local estimates in the UI.

## What the sources actually provide

Verified on 2026-08-17 against Claude Code 2.1.233 and the live opencode.ai dashboard.

### Claude Code

| Source | Gives | Exact | Needs install |
| --- | --- | --- | --- |
| `~/.claude.json` → `cachedUsageUtilization.utilization` | credits used, monthly limit, balance, per window dollars | yes | no |
| `~/.claude/projects/**/*.jsonl` | tokens per model per message, with timestamps | yes | no |
| statusline JSON | session total cost | yes | yes, rejected |
| Stop / SessionEnd hooks | nothing cost bearing | - | - |
| OTEL `claude_code.cost.usage` | cost metrics | yes | needs a collector, rejected |

The shape of the account usage block:

```
five_hour   { utilization, resets_at, limit_dollars, used_dollars, remaining_dollars }
seven_day   { utilization, resets_at, limit_dollars, used_dollars, remaining_dollars }
extra_usage { is_enabled, monthly_limit, used_credits, utilization, currency,
              decimal_places, spend_limit_reached, credits_ever_enabled, daily, weekly }
spend       { used: { amount_minor, currency, exponent }, limit, percent,
              balance, cap, auto_reload, severity, enabled }
```

Transcript assistant lines carry no cost field.
Only `usage` counts: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, plus the `ephemeral_5m` / `ephemeral_1h` cache split, `service_tier` and `speed`.

Two hard constraints follow.

Claude prunes transcripts at `cleanupPeriodDays`, default 30.
So token history older than roughly a month is already gone from disk and cannot be recovered.

`cachedUsageUtilization` reports only current windows.
There is no month-over-month history anywhere in Claude Code's local state.

Therefore any history beyond the current window has to be recorded by `open-usage` itself, starting from the day it is installed.

### OpenCode Go

The dashboard's Usage page calls two server functions through `https://opencode.ai/_server`, the same endpoint `opencode-server.ts` already uses:

```
bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c   GET, args in query
15702f3a12ff8bff357f8c2aa154a17e65b746d5f6b96adc9002c86ee0c15205   POST, args in body
```

They return rows shaped `{ date, model, totalCost, keyId, plan }`.
That is exact cost, per day, per model, with server side history across months.

OpenCode Go therefore needs no local rollup at all.
The server already keeps what the Claude side has to reconstruct.

`opencode.db` remains a valid zero network fallback.
`DAILY_COST_ROWS_SQL` already computes per day cost from `$.cost`, and needs only `model` added to its `GROUP BY` to match the dashboard chart.
It is limited to one machine, and is absent entirely on setups that reach OpenCode Go through another client.

### Codex

Rollout files carry only blended `total_tokens` with no input and output split.
No honest dollar figure is derivable.
Codex is out of scope for cost in this spec and keeps its token only presentation.

## Design

### 1. Pricing is an apportioner, not an oracle

A shipped pricing table exists, but it never produces the headline figure where an exact one is available.

Where Claude reports an exact total, the per model breakdown is computed by pricing each model's tokens, normalising those weights to sum to one, and multiplying by the exact total.
The parts therefore always sum to the truth.
A stale price shifts the split slightly and can never make the headline wrong.

Where no exact total exists, the priced figure is shown directly and labelled as an estimate.

The table lives in `src/data/real/pricing.ts` with an explicit `PRICES_AS_OF` date rendered in the UI.
Unknown models are never priced at zero.
They are surfaced as an `unpriced` bucket so a missing entry is visible rather than silently swallowed.

The table is overridable at `~/.config/open-usage/pricing.json` so a price change does not require a release.

### 2. The rollup store

New module `src/data/real/spend-store.ts`, writing `~/.config/open-usage/spend-history.json`.

It keeps two things.

Monthly token totals per model, derived from transcripts, banked before Claude prunes them.

Monthly spend, recorded by sampling the account usage odometer.
`used_credits` and `spend.used` are cumulative within a billing month and reset at the boundary.
The store keeps the high water mark per month.
A reading lower than the stored maximum for that month means the month rolled over, so the previous maximum is banked as final and a new month begins.

Never sum readings.
Sampling a cumulative counter and adding the samples would multiply the real figure several times over.

Sampling the account odometer rather than summing local sessions also captures usage from other machines and from claude.ai, which local session data structurally cannot see.
Claude Code's own `/usage` output states this limitation explicitly.

The store follows the existing `usage-cache.ts` conventions and reuses `file-lock.ts` so concurrent instances cannot corrupt it.

Month one answers "this month".
Month four answers all four.
The UI states plainly when a month predates the store rather than rendering a misleading zero.

### 3. Range scoped aggregation

`claude-transcripts.ts` currently applies a hard 30 day cutoff and emits a flat `modelTokens` map and a flat `tokenSplit`.
Both are replaced by a per day, per model structure so any `RangeKey` is a projection rather than a re-read.

The existing per file size and mtime cache is preserved.
It is what keeps a 60 second poll over tens of megabytes effectively free, and it must not regress.

### 4. Model timeline

"Which model, and when did it change" is answered from the per day per model series that step 3 already produces.
No new parsing.
The detail screen renders it as a stacked daily bar reusing `lib/chart.ts`, which already has stacked bar support.

### 5. OpenCode Go server history

`opencode-server.ts` gains the two function ids and a parser for their row payload.

It also gains id recovery.
The client bundle names every server function with a `<name>_query` or `<name>_action` symbol adjacent to its hash, verified by matching `getWorkspaces_query` to the `def39973…` id already hardcoded today.
So the ids can be recovered by scanning the bundle when a hardcoded id stops parsing, instead of shipping hashes that rot on every redeploy.

This removes the standing caveat in that file's own header comment, which currently accepts drift as expected behaviour.

Behaviour is unchanged without a cookie.
The source stays dormant and the local estimate is used, exactly as today.

### 6. Type additions

Added to `data/types.ts`, filled by both the mock and real providers.

```ts
export type Exactness = "exact" | "estimated" | "unavailable";

export interface Money {
  amountMinor: number;
  currency: string;
  exponent: number;
}

/** Promoted from `TranscriptTokenSplit` in claude-transcripts.ts, which is
 *  already this exact shape but is currently private to that reader. */
export interface TokenSplit {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelSpend {
  model: string;
  tokens: TokenSplit;
  cost: Money | null;
  exactness: Exactness;
}

export interface SpendPeriod {
  label: string;
  total: Money | null;
  limit: Money | null;
  exactness: Exactness;
  models: ModelSpend[];
  isBeforeStoreExisted: boolean;
}
```

`RangeKey` gains `"all"`, which the README already documents at line 77 but `RANGE_KEYS` never contained.
That mismatch is a live documentation bug and this is the right change to fix it under, since persisted history is what makes `all` meaningful.

## Open decision

Where this lives in the UI.

Recommendation: extend `provider-detail.tsx` rather than adding a sixth view.
The range cycle on `t` already exists, the screen already owns per provider depth, and a new top level view would duplicate provider selection for one extra dimension of the same data.

The alternative, a dedicated spend view, is better if spend is meant to be compared across providers side by side.
That argument gets stronger once Codex gains a token split and all three can show money.

This is the one thing still to settle.

## Testing

Every reader takes its path as a parameter, so tests feed fixtures and never touch a real home directory.
That existing convention holds throughout.

Fixtures are needed for a populated credit account, since the account this was designed against has credits disabled and reports null for every credit field.
The reader parses defensively and degrades to `unavailable` rather than assuming a shape that was never observed.

Specific cases that must be covered:

Odometer rollover, including a mid month reading lower than the stored maximum.
Sum-instead-of-max is the single most damaging possible bug here and needs a direct regression test.

Apportionment summing exactly to the exact total, including when an unknown model is present.

A stale or missing OpenCode function id falling back cleanly rather than throwing.

Absent `cachedUsageUtilization`, as older Claude Code versions will not have it.

Months predating the store rendering as unknown, never as zero.

## Out of scope

Codex cost.
Any network call beyond the existing opt in opencode.ai one.
Any modification of files outside `~/.config/open-usage`.
The statusline tap, considered and rejected for depending on a configuration most users do not have.

## Rejected alternatives

Statusline tap for exact Claude cost.
Exact and appealing, but only works for users who already run a statusline, and requires editing `~/.claude/settings.json`, which breaks the promise that nothing is written outside the tool's own config directory.

Summing per session costs.
Structurally blind to other machines and to claude.ai, and vulnerable to double counting.

OTEL metrics.
Real, but requires running a collector, which does not fit a tool whose premise is reading what is already there.

Pricing table as the primary figure.
Rejected because an exact figure exists for the users who most need it.
