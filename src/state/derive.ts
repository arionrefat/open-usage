import { sum } from "../lib/chart";
import { COLORS } from "../theme";
import {
  PROVIDER_IDS,
  STATUS_PRESENTATION,
  type ProviderId,
  type RangeKey,
  type UsageSnapshot,
} from "../data/types";
import { isProviderLive, type AppState } from "./app-state";

const RANGE_NAMES: Record<RangeKey, string> = {
  today: "today",
  "7d": "last 7 days",
  "30d": "last 30 days",
  month: "calendar month",
};

/** Half of the fixed window behind the week-over-week recency signal. */
const WEEK_DAYS = 7;

const RANGE_LABELS: Record<RangeKey, string> = {
  today: "today",
  "7d": "7d",
  "30d": "30d",
  month: "cal month",
};

export interface ProviderPressure {
  percent: number;
  /** The limit the figure came from, so the headline can name its window. */
  label: string;
  /** That limit's own reset text, which is the one that matters for routing. */
  reset: string;
}

export interface DerivedState {
  /** Providers passing both the enabled flag and the current name filter. */
  visibleIds: ProviderId[];
  /** Enabled providers whose credential currently works. */
  liveIds: ProviderId[];
  enabledCount: number;
  /** Enabled but unusable - expired or missing credential. */
  disconnectedIds: ProviderId[];
  /** Live providers at or past the danger threshold on their tightest limit. */
  hotIds: ProviderId[];
  alertText: string;
  alertColor: string;
  series: Record<ProviderId, number[]>;
  totals: Record<ProviderId, number>;
  /**
   * Tokens in the last 7 days against the 7 before them. Deliberately fixed
   * rather than tied to the selected range, so the recency signal keeps one
   * meaning as the range cycles - and so it stays available at 30d, where the
   * sources' own 30-day history leaves no prior window to compare against.
   * null per provider when history cannot fill both halves.
   */
  weekOverWeek: Record<ProviderId, { recent: number; prior: number } | null>;
  visibleTotal: number;
  axis: readonly [string, string, string];
  rangeName: string;
  rangeLabel: string;
  /**
   * The tightest capped limit each provider reports, whatever window it covers.
   * null when the provider publishes no cap at all. `scopes` holds only session
   * and weekly, so ranking on it hid limits like a monthly cycle entirely.
   */
  pressure: Record<ProviderId, ProviderPressure | null>;
  /** Live providers with a cap, most-pressured first. */
  ranked: ProviderId[];
  /** Unfiltered live-provider ranking used by simplified mode, which renders every provider. */
  unfilteredRanked: ProviderId[];
  worstId: ProviderId | null;
  bestId: ProviderId | null;
  windowNote: string;
}

function dailyStartIndex(range: RangeKey, dates: string[]): number {
  if (range === "7d") return Math.max(0, dates.length - 7);
  if (range === "30d") return Math.max(0, dates.length - 30);
  if (range === "month") {
    const latestMonth = dates.at(-1)?.slice(0, 7);
    const index = latestMonth ? dates.findIndex((date) => date.startsWith(latestMonth)) : -1;
    return Math.max(0, index);
  }
  return 0;
}

function formatAxisDate(value: string | undefined): string {
  if (!value) return "";
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function axisForDates(dates: string[]): [string, string, string] {
  if (dates.length === 0) return ["", "", ""];
  return [
    formatAxisDate(dates[0]),
    formatAxisDate(dates[Math.floor((dates.length - 1) / 2)]),
    formatAxisDate(dates.at(-1)),
  ];
}

function seriesForRange(snapshot: UsageSnapshot, range: RangeKey, dailyStart: number) {
  const providerSeries = (id: ProviderId) => snapshot.providers[id].series;
  if (range === "today") {
    return {
      cl: providerSeries("cl").hourly,
      cx: providerSeries("cx").hourly,
      go: providerSeries("go").hourly,
    };
  }
  return {
    cl: providerSeries("cl").daily.slice(dailyStart),
    cx: providerSeries("cx").daily.slice(dailyStart),
    go: providerSeries("go").daily.slice(dailyStart),
  };
}

function weekOverWeek(
  snapshot: UsageSnapshot,
): Record<ProviderId, { recent: number; prior: number } | null> {
  const length = snapshot.dailyDates.length;
  if (length < WEEK_DAYS * 2) return { cl: null, cx: null, go: null };
  const windowsFor = (id: ProviderId) => {
    const daily = snapshot.providers[id].series.daily;
    return {
      recent: sum(daily.slice(length - WEEK_DAYS)),
      prior: sum(daily.slice(length - WEEK_DAYS * 2, length - WEEK_DAYS)),
    };
  };
  return { cl: windowsFor("cl"), cx: windowsFor("cx"), go: windowsFor("go") };
}

/**
 * The provider's tightest limit. Whichever window binds first is the one that
 * decides whether to route work here, so an uncapped row contributes nothing
 * and a monthly cycle outranks an idle rolling window.
 */
function providerPressure(snapshot: UsageSnapshot, id: ProviderId): ProviderPressure | null {
  let tightest: ProviderPressure | null = null;
  for (const limit of snapshot.providers[id].limits) {
    if (limit.percent === null) continue;
    if (tightest === null || limit.percent > tightest.percent) {
      tightest = { percent: limit.percent, label: limit.label, reset: limit.reset };
    }
  }
  return tightest;
}

function pressureByProvider(snapshot: UsageSnapshot): Record<ProviderId, ProviderPressure | null> {
  return {
    cl: providerPressure(snapshot, "cl"),
    cx: providerPressure(snapshot, "cx"),
    go: providerPressure(snapshot, "go"),
  };
}

function rankPressure(
  pressure: Record<ProviderId, ProviderPressure | null>,
  liveIds: ProviderId[],
): ProviderId[] {
  return liveIds
    .filter((id) => pressure[id] !== null)
    .sort((first, second) => (pressure[second]?.percent ?? 0) - (pressure[first]?.percent ?? 0));
}

function alertText(liveCount: number, issueCount: number, disconnectedCount: number): string {
  if (disconnectedCount > 0) return "▲ warning";
  if (liveCount === 0) return "○ nothing tracked";
  if (issueCount === 0) return "✓ all clear";
  return "▲ warning";
}

function alertColor(
  liveCount: number,
  hotCount: number,
  disconnectedCount: number,
): string {
  if (disconnectedCount > 0 || hotCount > 0) return COLORS.danger;
  if (liveCount === 0) return COLORS.textFaint;
  return COLORS.ok;
}

function windowNote(
  state: AppState,
  snapshot: UsageSnapshot,
  visibleIds: ProviderId[],
  liveIds: ProviderId[],
  disconnectedIds: ProviderId[],
): string {
  const query = state.filterQuery.trim();
  if (visibleIds.length === 0 && query) return `no providers match “${query}”`;
  if (liveIds.length === 0) {
    return "no live provider - 5 settings to enable one, or o to re-run setup";
  }
  if (disconnectedIds.length === 0) return snapshot.windowNote;
  return disconnectedIds
    .map((id) => {
      const name = snapshot.providers[id].meta.name;
      const status = STATUS_PRESENTATION[state.connections[id].status].label;
      return `${name} - ${status}`;
    })
    .join("   ");
}

export function deriveState(state: AppState, snapshot: UsageSnapshot): DerivedState {
  const query = state.filterQuery.trim().toLowerCase();
  const matchesFilter = (id: ProviderId) =>
    !query || snapshot.providers[id].meta.name.includes(query);

  const isVisible = (id: ProviderId) => state.connections[id].isEnabled && matchesFilter(id);
  const visibleIds = PROVIDER_IDS.filter(isVisible);
  const liveIds = PROVIDER_IDS.filter((id) => isProviderLive(state.connections[id]));
  const visibleLiveIds = visibleIds.filter((id) => isProviderLive(state.connections[id]));
  const enabledCount = PROVIDER_IDS.filter((id) => state.connections[id].isEnabled).length;
  const disconnectedIds = PROVIDER_IDS.filter(
    (id) => state.connections[id].isEnabled && !isProviderLive(state.connections[id]),
  );

  const isHourly = state.range === "today";
  const dailyStart = dailyStartIndex(state.range, snapshot.dailyDates);
  const visibleDates = snapshot.dailyDates.slice(dailyStart);
  const series = seriesForRange(snapshot, state.range, dailyStart);

  const totals = { cl: sum(series.cl), cx: sum(series.cx), go: sum(series.go) };
  const visibleTotal = visibleIds.reduce((acc, id) => acc + totals[id], 0);

  const pressure = pressureByProvider(snapshot);
  const ranked = rankPressure(pressure, visibleLiveIds);
  const unfilteredRanked = rankPressure(pressure, liveIds);

  const hotIds = liveIds.filter((id) => (pressure[id]?.percent ?? 0) >= state.warnThreshold);
  const alertCount = hotIds.length + disconnectedIds.length;

  return {
    visibleIds,
    liveIds,
    enabledCount,
    disconnectedIds,
    hotIds,
    alertText: alertText(liveIds.length, alertCount, disconnectedIds.length),
    alertColor: alertColor(liveIds.length, hotIds.length, disconnectedIds.length),
    series,
    totals,
    weekOverWeek: weekOverWeek(snapshot),
    visibleTotal,
    axis: isHourly ? snapshot.hourlyAxis : axisForDates(visibleDates),
    rangeName: RANGE_NAMES[state.range],
    rangeLabel: RANGE_LABELS[state.range],
    pressure,
    ranked,
    unfilteredRanked,
    worstId: ranked[0] ?? null,
    bestId: ranked.at(-1) ?? null,
    windowNote: windowNote(state, snapshot, visibleIds, liveIds, disconnectedIds),
  };
}
