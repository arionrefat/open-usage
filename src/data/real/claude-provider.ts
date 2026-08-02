import { COLORS } from "../../theme";
import type { ProviderMeta, ProviderUsage, UsageLimit } from "../types";
import { HOUR_MS, formatAge, formatClock, formatCountdown, formatRate, seriesFromBuckets, tokensPerHour } from "./aggregate";
import type { HistoryStats } from "./claude-history";
import type { TranscriptAggregate } from "./claude-transcripts";
import { NO_CAP_DATA, capLessLimit, localBurn, resetText } from "./provider-helpers";
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

function claudeLimits(
  snapshotFile: SnapshotFile | null,
  projection: ClaudeProjection,
  rateLabel: string,
  nowMs: number,
  hasStatusline: boolean,
): UsageLimit[] {
  const staleNote =
    snapshotFile === null
      ? hasStatusline
        ? "statusline snapshot missing - open a claude code session to refresh"
        : "no statusline configured - claude code writes limits from one"
      : `statusline snapshot stale (${formatAge(snapshotFile.ageMs)} old) - open a claude code session to refresh`;
  const isFresh = snapshotFile !== null && snapshotFile.ageMs < SNAPSHOT_FRESH_MS;
  const five = snapshotFile?.reading.fiveHour ?? null;
  const seven = snapshotFile?.reading.sevenDay ?? null;
  const session: UsageLimit = five
    ? {
        id: "session",
        label: "current session",
        percent: Math.round(five.percent),
        reset: resetText(five.resetsAtMs, nowMs),
        ...(isFresh ? {} : { footnote: staleNote }),
      }
    : capLessLimit("session", "current session", "current session", "no snapshot", staleNote);
  const weekly: UsageLimit = seven
    ? {
        id: "weekly",
        label: "weekly · all models",
        percent: Math.round(seven.percent),
        reset: resetText(seven.resetsAtMs, nowMs),
        resetLong:
          seven.resetsAtMs !== null
            ? `${resetText(seven.resetsAtMs, nowMs)} · ${formatClock(seven.resetsAtMs)}`
            : undefined,
        ...(projection.projectedPercent > 100
          ? {
              alert: {
                text: `▲ burn ${rateLabel} → projected ${projection.projectedPercent}% before reset`,
                color: COLORS.danger,
              },
            }
          : {}),
      }
    : capLessLimit("weekly", "weekly · all models", "weekly · all models", "no snapshot", staleNote);
  return [session, weekly];
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
    ...(isFresh
      ? {}
      : {
          notice: {
            icon: "ⓘ",
            iconColor: COLORS.info,
            segments: [
              {
                text:
                  snapshotFile !== null
                    ? "statusline snapshot stale - open a claude code session to refresh limits"
                    : hasStatusline
                      ? "statusline snapshot missing - open a claude code session to refresh limits"
                      : "no statusline configured - claude code writes its limits from a statusline command",
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
