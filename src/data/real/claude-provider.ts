import { COLORS } from "../../theme";
import type { DetailRow, DetailSection, ProviderMeta, ProviderUsage, UsageLimit } from "../types";
import { HOUR_MS, formatAge, formatClock, formatCountdown, formatRate, seriesFromBuckets, tokensPerHour } from "./aggregate";
import type { HistoryStats } from "./claude-history";
import type { TranscriptAggregate } from "./claude-transcripts";
import type { ClaudeLimitsSource, ClaudeUsageWindow } from "./claude-usage";
import { NO_CAP_DATA, capLessLimit, formatTokenCount, localBurn, resetText } from "./provider-helpers";
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
  capsOutAt: string;
}

function projectWeekly(
  seven: RateWindowReading | null,
  trendRate: number | null,
  nowMs: number,
): ClaudeProjection {
  if (!seven) return { projectedPercent: 0, capsOutAt: NO_CAP_DATA };
  const current = Math.round(seven.percent);
  if (trendRate === null || seven.resetsAtMs === null) {
    // No usable snapshot delta yet - the projection is just the current figure.
    return {
      projectedPercent: current,
      capsOutAt: current > 100 ? "already capped" : "not before reset",
    };
  }
  const hoursToReset = Math.max(0, (seven.resetsAtMs - nowMs) / HOUR_MS);
  const projectedPercent = Math.round(seven.percent + trendRate * hoursToReset);
  if (projectedPercent <= 100) return { projectedPercent, capsOutAt: "not before reset" };
  const hoursToCap = (100 - seven.percent) / trendRate;
  return { projectedPercent, capsOutAt: formatClock(nowMs + hoursToCap * HOUR_MS) };
}

function staleSnapshotNote(snapshotFile: SnapshotFile | null, hasStatusline: boolean): string {
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

/** Merges CLI reset prose with fresh statusline timestamps so projections work while live polling is active. */
function cliWindow(
  window: ClaudeUsageWindow,
  snapshotWindow: RateWindowReading | null,
): ClaudeWindow {
  return {
    percent: window.percent,
    resetsAtMs: snapshotWindow?.resetsAtMs ?? null,
    resetLabel: window.reset,
  };
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
    reset: five.resetLabel ?? resetText(five.resetsAtMs, nowMs),
  };
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
    reset: seven.resetLabel ?? resetText(seven.resetsAtMs, nowMs),
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

function claudeLimits(
  five: ClaudeWindow | null,
  seven: ClaudeWindow | null,
  isFresh: boolean,
  snapshotFile: SnapshotFile | null,
  projection: ClaudeProjection,
  rateLabel: string,
  nowMs: number,
  hasStatusline: boolean,
): UsageLimit[] {
  const staleNote = staleSnapshotNote(snapshotFile, hasStatusline);
  const session = sessionLimit(five, isFresh, staleNote, nowMs);
  const weekly = weeklyLimit(seven, projection, rateLabel, staleNote, nowMs);
  if (!isFresh) weekly.footnote = staleNote;
  return [session, weekly];
}

function claudeNoticeText(snapshotFile: SnapshotFile | null, hasStatusline: boolean): string {
  if (snapshotFile) {
    return "stale statusline ignored - press r to query live limits via claude cli";
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

function authPlanLabel(fallback: string, auth: ClaudeAuthInfo): string {
  const subType = auth.subscriptionType;
  if (!subType) return fallback;
  return subType.charAt(0).toUpperCase() + subType.slice(1).replace(/[_-]/g, " ");
}

export function buildClaudeProvider(input: ClaudeProviderInput): ProviderUsage {
  const { transcripts, history, snapshotFile, limitsSource, hasStatusline, trend, dates, now } = input;
  const auth = input.authSource?.read();
  const meta = auth ? { ...input.meta, plan: authPlanLabel(input.meta.plan, auth) } : input.meta;
  const nowMs = now.getTime();
  const rate = tokensPerHour(transcripts.buckets, now);
  const rateLabel = formatRate(rate);
  const snapshotIsFresh = snapshotFile !== null && snapshotFile.ageMs < SNAPSHOT_FRESH_MS;
  const live = limitsSource.read();
  const five: ClaudeWindow | null = live
    ? cliWindow(live.session, snapshotIsFresh ? snapshotFile.reading.fiveHour : null)
    : snapshotIsFresh
      ? snapshotFile.reading.fiveHour
      : null;
  const seven: ClaudeWindow | null = live
    ? cliWindow(live.weekly, snapshotIsFresh ? snapshotFile.reading.sevenDay : null)
    : snapshotIsFresh
      ? snapshotFile.reading.sevenDay
      : null;
  const isFresh = live !== null || snapshotIsFresh;
  const trendAtMs =
    live ? live.fetchedAtMs : snapshotIsFresh ? snapshotFile.writtenAtMs : null;
  const trendRate =
    seven && trendAtMs !== null ? trend.observe(trendAtMs, seven.percent) : null;
  const projection = projectWeekly(seven, trendRate, nowMs);
  const details = [sessionDetails(snapshotFile), ...transcriptDetails(transcripts)].filter(
    (section): section is DetailSection => section !== null,
  );

  return {
    id: "cl",
    meta,
    series: seriesFromBuckets(transcripts.buckets, dates, now),
    limits: claudeLimits(five, seven, isFresh, snapshotFile, projection, rateLabel, nowMs, hasStatusline),
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
          timeToReset:
            seven.resetLabel
              ? seven.resetLabel.replace(/^resets\s+/i, "") + " to reset"
              : seven.resetsAtMs !== null
              ? `${formatCountdown(seven.resetsAtMs - nowMs)} to reset`
              : "reset unknown",
          rate: rateLabel,
          projectedPercent: projection.projectedPercent,
          capsOutAt: projection.capsOutAt,
        }
      : localBurn(rate),
    ...(history.available ? { sessions30d: history.sessions } : {}),
    ...(details.length > 0 ? { details } : {}),
    ...(isFresh
      ? {}
      : {
          notice: {
            icon: "ⓘ",
            iconColor: COLORS.info,
            segments: [
              {
                text: limitsSource.note() ?? claudeNoticeText(snapshotFile, hasStatusline),
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
