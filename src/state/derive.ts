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
  const series = Object.fromEntries(
    PROVIDER_IDS.map((id) => {
      const provider = snapshot.providers[id].series;
      return [id, isHourly ? provider.hourly : provider.daily.slice(dailyStart)];
    }),
  ) as Record<ProviderId, number[]>;

  const totals = Object.fromEntries(
    PROVIDER_IDS.map((id) => [id, sum(series[id])]),
  ) as Record<ProviderId, number>;
  const visibleTotal = visibleIds.reduce((acc, id) => acc + totals[id], 0);

  const scopeConsumption = Object.fromEntries(
    PROVIDER_IDS.map((id) => {
      const isLive = visibleLiveIds.includes(id);
      return [id, isLive ? (snapshot.providers[id].scopes[state.scope].percent ?? 0) : 0];
    }),
  ) as Record<ProviderId, number>;
  const scopeTotal = visibleIds.reduce((acc, id) => acc + scopeConsumption[id], 0);

  const ranked = visibleLiveIds
    .filter((id) => snapshot.providers[id].scopes[state.scope].percent !== null)
    .sort(
      (a, b) =>
        (snapshot.providers[b].scopes[state.scope].percent ?? 0) -
        (snapshot.providers[a].scopes[state.scope].percent ?? 0),
    );

  const hotIds = liveIds.filter(
    (id) => (snapshot.providers[id].scopes[state.scope].percent ?? 0) >= THRESHOLDS.danger,
  );
  const alertCount = hotIds.length + disconnectedIds.length;

  const windowNote =
    visibleIds.length === 0 && query
      ? `no providers match “${state.filterQuery.trim()}”`
      : liveIds.length === 0
      ? "no live provider - 5 settings to enable one, or o to re-run setup"
      : disconnectedIds.length > 0
        ? disconnectedIds
            .map((id) => `${snapshot.providers[id].meta.name} - ${STATUS_PRESENTATION[state.connections[id].status].label}`)
            .join("   ")
        : snapshot.windowNote;

  return {
    visibleIds,
    liveIds,
    enabledCount,
    disconnectedIds,
    hotIds,
    alertText:
      liveIds.length === 0
        ? "○ nothing tracked"
        : alertCount > 0
          ? `▲ ${alertCount} ${alertCount > 1 ? "issues" : "issue"}`
          : "✓ all clear",
    alertColor:
      liveIds.length === 0
        ? COLORS.textFaint
        : hotIds.length > 0
          ? COLORS.danger
          : disconnectedIds.length > 0
            ? COLORS.warn
            : COLORS.ok,
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
    windowNote,
  };
}
