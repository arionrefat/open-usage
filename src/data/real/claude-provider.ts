import { COLORS } from "../../theme";
import type { DetailRow, DetailSection, ProviderMeta, ProviderUsage, UsageLimit } from "../types";
import { HOUR_MS, formatAge, formatClock, formatCountdown, formatRate, seriesFromBuckets, tokensPerHour } from "./aggregate";
import type { HistoryStats } from "./claude-history";
import type { TranscriptAggregate } from "./claude-transcripts";
import { NO_CAP_DATA, capLessLimit, formatTokenCount, localBurn, resetText } from "./provider-helpers";
import { SNAPSHOT_FRESH_MS, type RateWindowReading, type SnapshotFile, type WeeklyTrend } from "./statusline-snapshot";

export function createClaudeMeta(): ProviderMeta {
  return {
    id: "cl",
    name: "claude code",
    plan: "local data",
    planShort: "local data",
    planDetail: "local data",
    requirement: "claude code installed (oauth)",
    source: "~/.claude",
    fake: "oauth · claude code",
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
    return `statusline snapshot stale (${formatAge(snapshotFile.ageMs)} old) - open a claude code session to refresh`;
  }
  return hasStatusline
    ? "statusline snapshot missing - open a claude code session to refresh"
    : "no statusline configured - claude code writes limits from one";
}

function sessionLimit(
  five: RateWindowReading | null,
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
    reset: resetText(five.resetsAtMs, nowMs),
  };
  if (!isFresh) limit.footnote = staleNote;
  return limit;
}

function weeklyLimit(
  seven: RateWindowReading | null,
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
    reset: resetText(seven.resetsAtMs, nowMs),
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
  snapshotFile: SnapshotFile | null,
  projection: ClaudeProjection,
  rateLabel: string,
  nowMs: number,
  hasStatusline: boolean,
): UsageLimit[] {
  const staleNote = staleSnapshotNote(snapshotFile, hasStatusline);
  const isFresh = snapshotFile !== null && snapshotFile.ageMs < SNAPSHOT_FRESH_MS;
  const five = snapshotFile?.reading.fiveHour ?? null;
  const seven = snapshotFile?.reading.sevenDay ?? null;
  const session = sessionLimit(five, isFresh, staleNote, nowMs);
  const weekly = weeklyLimit(seven, projection, rateLabel, staleNote, nowMs);
  return [session, weekly];
}

function claudeNoticeText(snapshotFile: SnapshotFile | null, hasStatusline: boolean): string {
  if (snapshotFile) {
    return "statusline snapshot stale - open a claude code session to refresh limits";
  }
  if (hasStatusline) {
    return "statusline snapshot missing - open a claude code session to refresh limits";
  }
  return "no statusline configured - claude code writes its limits from a statusline command";
}

interface ClaudeProviderInput {
  meta: ProviderMeta;
  transcripts: TranscriptAggregate;
  history: HistoryStats;
  snapshotFile: SnapshotFile | null;
  hasStatusline: boolean;
  trend: WeeklyTrend;
  dates: string[];
  now: Date;
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
    contextWindow.totalOutputTokens !== null &&
    contextWindow.contextWindowSize !== null
  ) {
    const used = contextWindow.totalInputTokens + contextWindow.totalOutputTokens;
    rows.push({
      label: "context used",
      value: `${formatTokenCount(used)} of ${formatTokenCount(contextWindow.contextWindowSize)}`,
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

export function buildClaudeProvider(input: ClaudeProviderInput): ProviderUsage {
  const { meta, transcripts, history, snapshotFile, hasStatusline, trend, dates, now } = input;
  const nowMs = now.getTime();
  const rate = tokensPerHour(transcripts.buckets, now);
  const rateLabel = formatRate(rate);
  const five = snapshotFile?.reading.fiveHour ?? null;
  const seven = snapshotFile?.reading.sevenDay ?? null;
  const isFresh = snapshotFile !== null && snapshotFile.ageMs < SNAPSHOT_FRESH_MS;
  const trendRate =
    isFresh && seven !== null ? trend.observe(snapshotFile.writtenAtMs, seven.percent) : null;
  const projection = projectWeekly(seven, trendRate, nowMs);
  const details = [sessionDetails(snapshotFile), ...transcriptDetails(transcripts)].filter(
    (section): section is DetailSection => section !== null,
  );

  return {
    id: "cl",
    meta,
    series: seriesFromBuckets(transcripts.buckets, dates, now),
    limits: claudeLimits(snapshotFile, projection, rateLabel, nowMs, hasStatusline),
    scopes: {
      session: {
        percent: five ? Math.round(five.percent) : null,
        window: "5h rolling",
        reset: five ? resetText(five.resetsAtMs, nowMs) : "no snapshot",
      },
      weekly: {
        percent: seven ? Math.round(seven.percent) : null,
        window: "7d · all models",
        reset: seven ? resetText(seven.resetsAtMs, nowMs) : "no snapshot",
      },
    },
    burn: seven
      ? {
          limit: "weekly · all models",
          timeToReset:
            seven.resetsAtMs !== null
              ? `${formatCountdown(seven.resetsAtMs - nowMs)} to reset`
              : "reset unknown",
          rate: rateLabel,
          projectedPercent: projection.projectedPercent,
          capsOutAt: projection.capsOutAt,
        }
      : localBurn(rate),
    ...(details.length > 0 ? { details } : {}),
    ...(isFresh
      ? {}
      : {
          notice: {
            icon: "ⓘ",
            iconColor: COLORS.info,
            segments: [
              {
                text: claudeNoticeText(snapshotFile, hasStatusline),
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
