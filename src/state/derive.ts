import { sum } from "../lib/chart";
import { COLORS, THRESHOLDS } from "../theme";
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
  month: "billing month",
  all: "all time",
};

const RANGE_LABELS: Record<RangeKey, string> = {
  today: "today",
  "7d": "7d",
  "30d": "30d",
  month: "month",
  all: "all",
};

export interface DerivedState {
  /** Providers passing both the enabled flag and the current name filter. */
  visibleIds: ProviderId[];
  /** Enabled providers whose credential currently works. */
  liveIds: ProviderId[];
  enabledCount: number;
  /** Enabled but unusable - expired or missing credential. */
  disconnectedIds: ProviderId[];
  /** Live providers at or past the danger threshold in the current scope. */
  hotIds: ProviderId[];
  alertText: string;
  alertColor: string;
  series: Record<ProviderId, number[]>;
  totals: Record<ProviderId, number>;
  visibleTotal: number;
  axis: readonly [string, string, string];
  rangeName: string;
  rangeLabel: string;
  /** Scope percentages by provider, zero when the provider is not live. */
  scopeConsumption: Record<ProviderId, number>;
  scopeTotal: number;
  /** Live providers with a cap in this scope, most-consumed first. */
  ranked: ProviderId[];
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

function consumptionByProvider(
  snapshot: UsageSnapshot,
  scope: AppState["scope"],
  visibleLiveIds: ProviderId[],
): Record<ProviderId, number> {
  const consumption = (id: ProviderId) => {
    if (!visibleLiveIds.includes(id)) return 0;
    return snapshot.providers[id].scopes[scope].percent ?? 0;
  };
  return { cl: consumption("cl"), cx: consumption("cx"), go: consumption("go") };
}

function rankConsumption(
  snapshot: UsageSnapshot,
  scope: AppState["scope"],
  visibleLiveIds: ProviderId[],
): ProviderId[] {
  const percent = (id: ProviderId) => snapshot.providers[id].scopes[scope].percent;
  return visibleLiveIds
    .filter((id) => percent(id) !== null)
    .sort((first, second) => (percent(second) ?? 0) - (percent(first) ?? 0));
}

function alertText(liveCount: number, issueCount: number): string {
  if (liveCount === 0) return "○ nothing tracked";
  if (issueCount === 0) return "✓ all clear";
  return "▲ warning";
}

function alertColor(
  liveCount: number,
  hotCount: number,
  disconnectedCount: number,
): string {
  if (liveCount === 0) return COLORS.textFaint;
  if (hotCount > 0 || disconnectedCount > 0) return COLORS.danger;
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

  const scopeConsumption = consumptionByProvider(snapshot, state.scope, visibleLiveIds);
  const scopeTotal = visibleIds.reduce((acc, id) => acc + scopeConsumption[id], 0);

  const ranked = rankConsumption(snapshot, state.scope, visibleLiveIds);

  const hotIds = liveIds.filter(
    (id) => (snapshot.providers[id].scopes[state.scope].percent ?? 0) >= THRESHOLDS.danger,
  );
  const alertCount = hotIds.length + disconnectedIds.length;

  return {
    visibleIds,
    liveIds,
    enabledCount,
    disconnectedIds,
    hotIds,
    alertText: alertText(liveIds.length, alertCount),
    alertColor: alertColor(liveIds.length, hotIds.length, disconnectedIds.length),
    series,
    totals,
    visibleTotal,
    axis: isHourly ? snapshot.hourlyAxis : axisForDates(visibleDates),
    rangeName: RANGE_NAMES[state.range],
    rangeLabel: RANGE_LABELS[state.range],
    scopeConsumption,
    scopeTotal,
    ranked,
    worstId: ranked[0] ?? null,
    bestId: ranked.length > 0 ? (ranked[ranked.length - 1] ?? null) : null,
    windowNote: windowNote(state, snapshot, visibleIds, liveIds, disconnectedIds),
  };
}
