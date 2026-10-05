import { formatMoney } from "../../lib/spend";
import { COLORS } from "../../theme";
import type {
  BurnOutcome,
  DetailRow,
  DetailSection,
  ProviderMeta,
  ProviderUsage,
  SpendSummary,
  UsageLimit,
} from "../types";
import { DAY_MS, HOUR_MS, formatAge, formatClock, formatCountdown, formatRate, seriesFromBuckets, toMillions, tokensPerHour } from "./aggregate";
import type { ClaudeWeeklyBreakdown } from "./claude-account-usage";
import type { HistoryStats } from "./claude-history";
import type { TranscriptAggregate } from "./claude-transcripts";
import {
  CLAUDE_LIMITS_STALE_MS,
  CLAUDE_SCOPED_STALE_MS,
  type ClaudeCliUsage,
  type ClaudeLimitsSource,
  type ClaudeScopedWindow,
  type ClaudeUsageWindow,
} from "./claude-usage";
import { capLessLimit, formatTokenCount, localBurn, resetText, trimResetProse } from "./provider-helpers";
import type { ClaudeAuthInfo, ClaudeAuthSource } from "./claude-auth";
import { SNAPSHOT_FRESH_MS, type RateWindowReading, type SnapshotFile, type WeeklyTrend } from "./statusline-snapshot";

export function createClaudeMeta(): ProviderMeta {
  return {
    id: "cl",
    name: "claude code",
    plan: "Claude subscription",
    planShort: "Claude subscription",
    planDetail: "Claude subscription",
    requirement: "claude code installed and signed in",
    source: "claude cli /usage + ~/.claude",
  };
}

interface ClaudeProjection {
  projectedPercent: number;
  outcome: BurnOutcome;
}

function projectWeekly(
  seven: RateWindowReading | null,
  trendRate: number | null,
  nowMs: number,
): ClaudeProjection {
  if (!seven) return { projectedPercent: 0, outcome: { kind: "no-cap" } };
  const current = Math.round(seven.percent);
  if (trendRate === null || seven.resetsAtMs === null) {
    // No usable snapshot delta yet - the projection is just the current figure.
    return {
      projectedPercent: current,
      outcome: current >= 100 ? { kind: "capped" } : { kind: "clear" },
    };
  }
  const hoursToReset = Math.max(0, (seven.resetsAtMs - nowMs) / HOUR_MS);
  const projectedPercent = Math.round(seven.percent + trendRate * hoursToReset);
  if (projectedPercent <= 100) return { projectedPercent, outcome: { kind: "clear" } };
  const hoursToCap = (100 - seven.percent) / trendRate;
  return {
    projectedPercent,
    outcome: { kind: "caps-out", at: formatClock(nowMs + hoursToCap * HOUR_MS) },
  };
}

function staleSnapshotNote(
  snapshotFile: SnapshotFile | null,
  hasStatusline: boolean,
  live: ClaudeCliUsage | null,
  useLive: boolean,
  nowMs: number,
): string {
  if (live && useLive && nowMs - live.fetchedAtMs > CLAUDE_LIMITS_STALE_MS) {
    return `cached live limits stale (${formatAge(nowMs - live.fetchedAtMs)} old) - press r for live limits`;
  }
  if (snapshotFile) {
    return `statusline snapshot stale (${formatAge(snapshotFile.ageMs)} old) - press r for live limits`;
  }
  return hasStatusline
    ? "statusline snapshot missing - press r for live limits"
    : "live limits unavailable - press r to query claude cli";
}

interface ClaudeWindow extends RateWindowReading {
  resetLabel?: string;
}

function cliWindow(
  window: ClaudeUsageWindow,
  snapshotWindow: RateWindowReading | null,
): ClaudeWindow {
  return {
    percent: window.percent,
    resetsAtMs: window.resetsAtMs ?? snapshotWindow?.resetsAtMs ?? null,
    resetLabel: trimResetProse(window.reset),
  };
}

/** A countdown whenever a time is known, so stacked rows never mix it with the CLI's prose. */
function windowReset(window: ClaudeWindow, nowMs: number): string {
  if (window.resetsAtMs !== null) return resetText(window.resetsAtMs, nowMs);
  return window.resetLabel ?? resetText(null, nowMs);
}

function sessionLimit(
  five: ClaudeWindow | null,
  isFresh: boolean,
  staleNote: string,
  nowMs: number,
): UsageLimit {
  if (!five) {
    return capLessLimit("session", "current session", "current session", "no snapshot", staleNote);
  }

  const limit: UsageLimit = {
    id: "session",
    label: "current session",
    percent: Math.round(five.percent),
    reset: windowReset(five, nowMs),
  };
  if (five.resetsAtMs !== null) {
    limit.resetLong = `${resetText(five.resetsAtMs, nowMs)} · ${formatClock(five.resetsAtMs)}`;
  }
  if (!isFresh) limit.footnote = staleNote;
  return limit;
}

function weeklyLimit(
  seven: ClaudeWindow | null,
  projection: ClaudeProjection,
  rateLabel: string,
  staleNote: string,
  nowMs: number,
): UsageLimit {
  if (!seven) {
    return capLessLimit(
      "weekly",
      "weekly · all models",
      "weekly · all models",
      "no snapshot",
      staleNote,
    );
  }

  const limit: UsageLimit = {
    id: "weekly",
    label: "weekly · all models",
    percent: Math.round(seven.percent),
    reset: windowReset(seven, nowMs),
  };
  if (seven.resetsAtMs !== null) {
    limit.resetLong = `${resetText(seven.resetsAtMs, nowMs)} · ${formatClock(seven.resetsAtMs)}`;
  }
  if (projection.projectedPercent > 100) {
    limit.alert = {
      text: `▲ burn ${rateLabel} → projected ${projection.projectedPercent}% before reset`,
      color: COLORS.danger,
    };
  }
  return limit;
}

function scopedLimit(
  window: ClaudeScopedWindow,
  isFresh: boolean,
  staleNote: string,
  nowMs: number,
): UsageLimit {
  const limit: UsageLimit = {
    id: window.id,
    label: `weekly · ${window.name}`,
    percent: Math.round(window.percent),
    reset:
      window.resetsAtMs !== undefined ? resetText(window.resetsAtMs, nowMs) : trimResetProse(window.reset),
  };
  if (window.resetsAtMs !== undefined) {
    limit.resetLong = `${resetText(window.resetsAtMs, nowMs)} · ${formatClock(window.resetsAtMs)}`;
  }
  if (!isFresh) limit.footnote = staleNote;
  return limit;
}

function claudeLimits(
  five: ClaudeWindow | null,
  seven: ClaudeWindow | null,
  scoped: ClaudeScopedWindow[],
  isFresh: boolean,
  scopedIsFresh: boolean,
  snapshotFile: SnapshotFile | null,
  live: ClaudeCliUsage | null,
  useLive: boolean,
  sourceNote: string | null,
  projection: ClaudeProjection,
  rateLabel: string,
  nowMs: number,
  hasStatusline: boolean,
): UsageLimit[] {
  const staleNote = sourceNote ?? staleSnapshotNote(snapshotFile, hasStatusline, live, useLive, nowMs);
  const scopedStaleNote =
    sourceNote ?? staleSnapshotNote(snapshotFile, hasStatusline, live, true, nowMs);
  const session = sessionLimit(five, isFresh, staleNote, nowMs);
  const weekly = weeklyLimit(seven, projection, rateLabel, staleNote, nowMs);
  if (!isFresh) weekly.footnote = staleNote;
  return [
    session,
    weekly,
    ...scoped.map((window) => scopedLimit(window, scopedIsFresh, scopedStaleNote, nowMs)),
  ];
}

function claudeNoticeText(snapshotFile: SnapshotFile | null, hasStatusline: boolean): string {
  if (snapshotFile) {
    return "cached statusline values shown - press r to query live limits via claude cli";
  }
  if (hasStatusline) {
    return "statusline snapshot missing - press r to query live limits via claude cli";
  }
  return "live limits unavailable - press r to query the signed-in claude cli";
}

interface ClaudeProviderInput {
  meta: ProviderMeta;
  transcripts: TranscriptAggregate;
  history: HistoryStats;
  snapshotFile: SnapshotFile | null;
  limitsSource: ClaudeLimitsSource;
  hasStatusline: boolean;
  trend: WeeklyTrend;
  dates: string[];
  now: Date;
  authSource?: ClaudeAuthSource;
  /** Money and per-model history; absent when neither source has anything. */
  spend?: SpendSummary;
  weeklyBreakdown?: ClaudeWeeklyBreakdown | null;
  rateLimitTier?: string | null;
}

function sessionDetails(snapshotFile: SnapshotFile | null): DetailSection | null {
  if (!snapshotFile || snapshotFile.ageMs >= SNAPSHOT_FRESH_MS) return null;
  const { model, contextWindow, cost, effort } = snapshotFile.reading;
  const rows: DetailRow[] = [];
  const modelName = model?.displayName ?? model?.id;
  if (modelName) rows.push({ label: "model", value: modelName });
  if (
    contextWindow !== null &&
    contextWindow.usedPercentage !== null &&
    contextWindow.totalInputTokens !== null &&
    contextWindow.contextWindowSize !== null
  ) {
    // total_input_tokens already includes cache reads/writes; output tokens
    // do not count toward the context window in Claude's own percentage.
    rows.push({
      label: "context used",
      value: `${formatTokenCount(contextWindow.totalInputTokens)} of ${formatTokenCount(contextWindow.contextWindowSize)}`,
      percent: contextWindow.usedPercentage,
    });
  }
  if (cost !== null && cost.totalCostUsd !== null) {
    rows.push({ label: "session cost", value: `$${cost.totalCostUsd.toFixed(2)}` });
  }
  if (cost !== null && (cost.totalLinesAdded !== null || cost.totalLinesRemoved !== null)) {
    rows.push({
      label: "lines",
      value: `+${cost.totalLinesAdded ?? 0} / -${cost.totalLinesRemoved ?? 0}`,
    });
  }
  if (effort) rows.push({ label: "effort", value: effort });
  return rows.length > 0 ? { title: "session", rows } : null;
}

function extraUsageDetails(live: ClaudeCliUsage | null): DetailSection | null {
  const extra = live?.extraUsage;
  if (!extra) return null;
  const used = formatMoney(extra.used);
  return {
    title: "extra usage",
    rows: [
      {
        label: "credits used",
        value: extra.monthlyLimit ? `${used} of ${formatMoney(extra.monthlyLimit)}` : used,
        percent: extra.utilization,
      },
    ],
  };
}

const WEEK_MS = 7 * DAY_MS;

function surfaceDetails(breakdown: ClaudeWeeklyBreakdown | null, nowMs: number): DetailSection | null {
  if (!breakdown || nowMs >= breakdown.windowStartedAtMs + WEEK_MS) return null;
  return {
    title: "weekly share by surface",
    rows: breakdown.rows.map((row) => ({
      label: row.label,
      value: `${Math.round(row.percent)}%`,
      percent: row.percent,
    })),
  };
}

function transcriptDetails(transcripts: TranscriptAggregate): DetailSection[] {
  const modelRows = [...transcripts.modelTokens]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);
  const modelTotal = [...transcripts.modelTokens.values()].reduce((sum, value) => sum + value, 0);
  const models: DetailSection | null = modelRows.length
    ? {
        title: "models 30d",
        rows: modelRows.map(([label, value]) => ({
          label,
          value: formatTokenCount(value),
          percent: modelTotal > 0 ? (value / modelTotal) * 100 : 0,
        })),
      }
    : null;

  const split = transcripts.tokenSplit;
  const tokenRows = [
    { label: "input", value: split.input },
    { label: "output", value: split.output },
    { label: "cache read", value: split.cacheRead },
    { label: "cache write", value: split.cacheWrite },
  ];
  const tokenTotal = tokenRows.reduce((sum, row) => sum + row.value, 0);
  const tokens: DetailSection | null = tokenTotal > 0
    ? {
        title: "tokens 30d",
        rows: tokenRows.map((row) => ({
          label: row.label,
          value: formatTokenCount(row.value),
          percent: (row.value / tokenTotal) * 100,
        })),
      }
    : null;
  return [models, tokens].filter((section): section is DetailSection => section !== null);
}

// Team seats share these tier strings, so they only refine a "max" subscription.
const MAX_TIER_LABELS = new Map([
  ["default_claude_max_5x", "Max 5x"],
  ["default_claude_max_20x", "Max 20x"],
]);

/** Every screen reads a different one of the three labels, so the tier has to land on all three. */
function withAuthPlan(meta: ProviderMeta, auth: ClaudeAuthInfo, rateLimitTier: string | null): ProviderMeta {
  const subType = auth.subscriptionType;
  if (!subType) return meta;
  const tierLabel = subType === "max" && rateLimitTier ? MAX_TIER_LABELS.get(rateLimitTier) : undefined;
  const plan = tierLabel ?? subType.charAt(0).toUpperCase() + subType.slice(1).replace(/[_-]/g, " ");
  return { ...meta, plan, planShort: plan, planDetail: plan };
}

export function buildClaudeProvider(input: ClaudeProviderInput): ProviderUsage {
  const { transcripts, history, snapshotFile, limitsSource, hasStatusline, trend, dates, now } = input;
  const auth = input.authSource?.read();
  const meta = auth ? withAuthPlan(input.meta, auth, input.rateLimitTier ?? null) : input.meta;
  const nowMs = now.getTime();
  const rate = tokensPerHour(transcripts.buckets, now);
  const rateLabel = formatRate(rate);
  const snapshotIsFresh = snapshotFile !== null && snapshotFile.ageMs < SNAPSHOT_FRESH_MS;
  const live = limitsSource.read();
  const liveIsFresh = live !== null && nowMs - live.fetchedAtMs <= CLAUDE_LIMITS_STALE_MS;
  const useLive =
    liveIsFresh ||
    (!snapshotIsFresh &&
      live !== null &&
      (snapshotFile === null || live.fetchedAtMs >= snapshotFile.writtenAtMs));
  const five: ClaudeWindow | null =
    live && useLive
      ? cliWindow(live.session, snapshotIsFresh ? snapshotFile!.reading.fiveHour : null)
      : snapshotFile
        ? snapshotFile.reading.fiveHour
        : live
          ? cliWindow(live.session, null)
          : null;
  const seven: ClaudeWindow | null =
    live && useLive
      ? cliWindow(live.weekly, snapshotIsFresh ? snapshotFile!.reading.sevenDay : null)
      : snapshotFile
        ? snapshotFile.reading.sevenDay
        : live
          ? cliWindow(live.weekly, null)
          : null;
  // Scoped lanes are polled more slowly than the statusline windows, so the
  // session window's staleness limit would call a current reading stale.
  const scopedIsFresh = live !== null && nowMs - live.fetchedAtMs <= CLAUDE_SCOPED_STALE_MS;
  const isFresh = liveIsFresh || snapshotIsFresh;
  const trendAtMs =
    live && useLive ? live.fetchedAtMs : snapshotFile ? snapshotFile.writtenAtMs : live?.fetchedAtMs ?? null;
  const trendRate =
    seven && trendAtMs !== null ? trend.observe(trendAtMs, seven.percent) : null;
  const projection = projectWeekly(seven, trendRate, nowMs);
  const details = [
    sessionDetails(snapshotFile),
    scopedIsFresh ? extraUsageDetails(live) : null,
    surfaceDetails(input.weeklyBreakdown ?? null, nowMs),
    ...transcriptDetails(transcripts),
  ].filter(
    (section): section is DetailSection => section !== null,
  );

  return {
    id: "cl",
    meta,
    ...(input.spend ? { spend: input.spend } : {}),
    series: seriesFromBuckets(transcripts.buckets, dates, now),
    limits: claudeLimits(
      five,
      seven,
      live?.scoped ?? [],
      isFresh,
      scopedIsFresh,
      snapshotFile,
      live,
      useLive,
      limitsSource.note(),
      projection,
      rateLabel,
      nowMs,
      hasStatusline,
    ),
    scopes: {
      session: {
        percent: five ? Math.round(five.percent) : null,
        window: "5h rolling",
        reset: five ? (five.resetLabel ?? resetText(five.resetsAtMs, nowMs)) : "live limits unavailable",
      },
      weekly: {
        percent: seven ? Math.round(seven.percent) : null,
        window: "7d · all models",
        reset: seven ? (seven.resetLabel ?? resetText(seven.resetsAtMs, nowMs)) : "live limits unavailable",
      },
    },
    burn: seven
      ? {
          limit: "weekly · all models",
          // A countdown beats the CLI's date prose here: this sits in a narrow
          // column where "Aug 26 at 6am to reset" wraps mid-phrase.
          timeToReset:
            seven.resetsAtMs !== null
              ? `${formatCountdown(seven.resetsAtMs - nowMs)} to reset`
              : seven.resetLabel
                ? seven.resetLabel.replace(/^resets\s+/i, "") + " to reset"
                : "reset unknown",
          rate: rateLabel,
          projectedPercent: projection.projectedPercent,
          outcome: projection.outcome,
        }
      : localBurn(rate),
    ...(history.available ? { sessions30d: history.sessions } : {}),
    cacheRead30d: toMillions(transcripts.tokenSplit.cacheRead),
    ...(details.length > 0 ? { details } : {}),
    ...(isFresh
      ? {}
      : {
          notice: {
            icon: "ⓘ",
            iconColor: COLORS.info,
            segments: [
              {
                text:
                  limitsSource.note() ??
                  (live && useLive
                    ? `cached live limits stale (${formatAge(nowMs - live.fetchedAtMs)} old) - press r to refresh`
                    : claudeNoticeText(snapshotFile, hasStatusline)),
              },
            ],
          },
        }),
    detailFooter:
      history.prompts > 0
        ? `prompts 30d ${history.prompts} ▏ sessions ${history.sessions} ▏ tokens from local transcripts (pruned periodically)`
        : undefined,
  };
}
