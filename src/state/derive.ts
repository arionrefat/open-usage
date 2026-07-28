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

/** How many trailing days each range covers; `today` is served hourly instead. */
const RANGE_DAY_COUNTS: Record<RangeKey, number> = {
  today: 24,
  "7d": 7,
  "30d": 30,
  month: 27,
  all: 30,
};

export interface DerivedState {
  /** Providers passing both the enabled flag and the current name filter. */
  visibleIds: ProviderId[];
  isVisible: (id: ProviderId) => boolean;
  /** Enabled providers whose credential currently works. */
  liveIds: ProviderId[];
  enabledCount: number;
  /** Enabled but unusable — expired or missing credential. */
  disconnectedIds: ProviderId[];
  /** Live providers at or past the danger threshold in the active scope. */
  hotIds: ProviderId[];
  alertText: string;
  alertColor: string;
  series: Record<ProviderId, number[]>;
  pointCount: number;
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
  leadId: ProviderId | null;
  windowNote: string;
}

export function deriveState(state: AppState, snapshot: UsageSnapshot): DerivedState {
  const query = state.filterQuery.trim().toLowerCase();
  const matchesFilter = (id: ProviderId) =>
    !query || snapshot.providers[id].meta.name.includes(query);

  const isVisible = (id: ProviderId) => state.connections[id].isEnabled && matchesFilter(id);
  const visibleIds = PROVIDER_IDS.filter(isVisible);
  const liveIds = PROVIDER_IDS.filter((id) => isProviderLive(state.connections[id]));
  const enabledCount = PROVIDER_IDS.filter((id) => state.connections[id].isEnabled).length;
  const disconnectedIds = PROVIDER_IDS.filter(
    (id) => state.connections[id].isEnabled && !isProviderLive(state.connections[id]),
  );

  const isHourly = state.range === "today";
  const dayCount = RANGE_DAY_COUNTS[state.range];
  const series = Object.fromEntries(
    PROVIDER_IDS.map((id) => {
      const provider = snapshot.providers[id].series;
      return [id, isHourly ? provider.hourly : provider.daily.slice(-dayCount)];
    }),
  ) as Record<ProviderId, number[]>;

  const totals = Object.fromEntries(
    PROVIDER_IDS.map((id) => [id, sum(series[id])]),
  ) as Record<ProviderId, number>;
  const visibleTotal = visibleIds.reduce((acc, id) => acc + totals[id], 0);

  const scopeConsumption = Object.fromEntries(
    PROVIDER_IDS.map((id) => {
      const isLive = liveIds.includes(id);
      return [id, isLive ? (snapshot.providers[id].scopes[state.scope].percent ?? 0) : 0];
    }),
  ) as Record<ProviderId, number>;
  const scopeTotal = PROVIDER_IDS.reduce((acc, id) => acc + scopeConsumption[id], 0);

  const ranked = liveIds
    .filter((id) => snapshot.providers[id].scopes[state.scope].percent !== null)
    .sort(
      (a, b) =>
        (snapshot.providers[b].scopes[state.scope].percent ?? 0) -
        (snapshot.providers[a].scopes[state.scope].percent ?? 0),
    );

  const hotIds = ranked.filter((id) => (snapshot.providers[id].scopes[state.scope].percent ?? 0) >= 85);
  const alertCount = hotIds.length + disconnectedIds.length;

  const leadId =
    scopeTotal > 0
      ? PROVIDER_IDS.reduce((best, id) => (scopeConsumption[id] > scopeConsumption[best] ? id : best))
      : null;

  const windowNote =
    liveIds.length === 0
      ? "no live provider — 5 settings to enable one, or o to re-run setup"
      : disconnectedIds.length > 0
        ? disconnectedIds
            .map((id) => `${snapshot.providers[id].meta.name} — ${STATUS_PRESENTATION[state.connections[id].status].label}`)
            .join("   ")
        : snapshot.windowNote;

  return {
    visibleIds,
    isVisible,
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
    pointCount: isHourly ? 24 : dayCount,
    totals,
    visibleTotal,
    axis: isHourly ? snapshot.hourlyAxis : snapshot.dailyAxis,
    rangeName: RANGE_NAMES[state.range],
    rangeLabel: RANGE_LABELS[state.range],
    scopeConsumption,
    scopeTotal,
    ranked,
    worstId: ranked[0] ?? null,
    bestId: ranked.length > 0 ? (ranked[ranked.length - 1] ?? null) : null,
    leadId,
    windowNote,
  };
}
