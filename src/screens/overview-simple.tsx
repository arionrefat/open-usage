import { planChart, type PlanChart } from "../lib/chart";
import { buildMeter, emptyMeter } from "../lib/meter";
import { columnWidth, padEnd } from "../lib/text";
import { COLORS, PROVIDER_COLORS, THRESHOLDS } from "../theme";
import {
  PROVIDER_IDS,
  STATUS_PRESENTATION,
  type ProviderId,
  type ScopeKey,
  type UsageSnapshot,
} from "../data/types";
import { isProviderLive, type AppState } from "../state/app-state";
import type { AppActions } from "../state/actions";
import type { DerivedState } from "../state/derive";
import { Chart, Line, Rule, SplitLine, Spacer, leftClick, type Segment } from "../components/primitives";
import { toggleChip, toggleSegments, type ToggleOption } from "../components/toggle";

const PERCENT_COLUMN = 7;
const LEGEND_BAR_MAX_WIDTH = 46;
const PLAN_CHART_MIN_CONTENT_WIDTH = 88;
const PLAN_CHART_GAP = 4;

const PLAN_LABELS: Record<ProviderId, string> = {
  cl: "claude",
  cx: "codex",
  go: "go",
};

interface OverviewSimpleProps {
  state: AppState;
  derived: DerivedState;
  snapshot: UsageSnapshot;
  width: number;
  scopeTitle: string;
  actions: AppActions;
}

interface LegendEntry {
  percentLabel: string;
  percentColor: string;
  fill: string;
  track: string;
  fillColor: string;
  window: string;
  reset: string;
  slice: string;
}

function unavailablePercentLabel(state: AppState, id: ProviderId): string {
  const connection = state.connections[id];
  if (!connection.isEnabled) return "off";
  if (connection.status !== "active") return "-";
  return "n/a";
}

function unavailableWindow(state: AppState, id: ProviderId): string {
  const connection = state.connections[id];
  return connection.isEnabled ? STATUS_PRESENTATION[connection.status].label : "hidden in settings";
}

function unavailableReset(state: AppState, id: ProviderId): string {
  const connection = state.connections[id];
  return connection.isEnabled ? connection.note : "space in settings to show it again";
}

function pressureColor(percent: number): string {
  if (percent >= THRESHOLDS.danger) return COLORS.danger;
  if (percent >= THRESHOLDS.warn) return COLORS.warn;
  return COLORS.textGhost;
}

function closestToLimitSegments(
  worstId: ProviderId | null,
  worstPercent: number,
  snapshot: UsageSnapshot,
): Segment[] {
  const providerLabel = worstId
    ? `${snapshot.providers[worstId].meta.name} ${worstPercent}%`
    : "nothing is being tracked";
  return [
    { text: "▲ ", color: pressureColor(worstPercent) },
    { text: providerLabel, color: COLORS.text },
    {
      text: worstId ? " closest to cap" : " - every provider is off or disconnected",
      color: COLORS.textFaint,
    },
  ];
}

function mostHeadroomSegments(
  bestId: ProviderId | null,
  bestPercent: number,
  snapshot: UsageSnapshot,
): Segment[] {
  const providerLabel = bestId
    ? `${snapshot.providers[bestId].meta.name} ${100 - bestPercent}% free`
    : "open settings";
  return [
    { text: "→ ", color: COLORS.ok },
    { text: providerLabel, color: COLORS.text },
    {
      text: bestId ? " most headroom" : " to enable a provider or paste a key",
      color: COLORS.textFaint,
    },
  ];
}

function buildLegend(
  id: ProviderId,
  state: AppState,
  snapshot: UsageSnapshot,
  consumption: Record<ProviderId, number>,
  consumptionTotal: number,
  barWidth: number,
): LegendEntry {
  const connection = state.connections[id];
  const scope = snapshot.providers[id].scopes[state.scope];
  const isLive = isProviderLive(connection);
  const hasCap = isLive && scope.percent !== null;
  const status = STATUS_PRESENTATION[connection.status];
  const meter = hasCap
    ? buildMeter(scope.percent ?? 0, barWidth, PROVIDER_COLORS[id], state.useSeverityColors)
    : emptyMeter(barWidth);

  return {
    percentLabel: hasCap ? meter.percentLabel : unavailablePercentLabel(state, id),
    percentColor: hasCap ? meter.percentColor : status.color,
    fill: meter.fill,
    track: meter.track,
    fillColor: meter.color,
    window: isLive ? scope.window : unavailableWindow(state, id),
    reset: isLive ? scope.reset : unavailableReset(state, id),
    slice:
      hasCap && consumptionTotal > 0
        ? `${Math.round((consumption[id] / consumptionTotal) * 100)}%`
        : "-",
  };
}

function ProviderLegend({
  id,
  name,
  entry,
  width,
  onSelect,
}: {
  id: ProviderId;
  name: string;
  entry: LegendEntry;
  width: number;
  onSelect: () => void;
}) {
  return (
    <box flexDirection="column" flexShrink={0} onMouseDown={leftClick(onSelect)}>
      <SplitLine
        width={width}
        left={[
          { text: "▎", color: PROVIDER_COLORS[id] },
          { text: name, color: COLORS.textBright, isBold: true },
        ]}
        right={entry.slice === "-" ? [] : [{ text: `${entry.slice} share`, color: COLORS.textGhost }]}
      />
      <Line
        segments={[
          { text: padEnd(entry.percentLabel, PERCENT_COLUMN), color: entry.percentColor, isBold: true },
          { text: entry.fill, color: entry.fillColor },
          { text: entry.track, color: COLORS.track },
        ]}
      />
      <Line
        width={width}
        segments={[
          { text: " ".repeat(PERCENT_COLUMN) },
          { text: entry.window, color: COLORS.textGhost },
          { text: " · ", color: COLORS.rule },
          { text: entry.reset, color: COLORS.textGhost },
        ]}
      />
    </box>
  );
}

/** Greedy word wrap; the design's lead line occupies a fixed 39ch column. */
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && columnWidth(candidate) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function PlanUsage({ chart, leadLine }: { chart: PlanChart; leadLine: string }) {
  return (
    <box flexDirection="column" flexShrink={0} width={chart.width}>
      <SplitLine
        width={chart.width}
        left={[{ text: "plan usage", color: COLORS.textMuted, isBold: true }]}
        right={[{ text: "%", color: COLORS.textGhost }]}
      />
      <Spacer />
      <Chart rows={chart.rows} />
      <Line segments={[{ text: chart.baseline, color: COLORS.rule }]} />
      <Line segments={chart.names.map((label) => ({ text: label.text, color: label.color }))} />
      <Line
        segments={chart.values.map((label) => ({
          text: label.text,
          color: label.color,
          isBold: true,
        }))}
      />
      <Spacer />
      {wrapWords(leadLine, chart.width).map((line, index) => (
        <Line key={`lead-${index}`} segments={[{ text: line, color: COLORS.textFaint }]} />
      ))}
    </box>
  );
}

export function OverviewSimple({
  state,
  derived,
  snapshot,
  width,
  scopeTitle,
  actions,
}: OverviewSimpleProps) {
  // The design plots all three providers regardless of filter or visibility;
  // consumption counts live providers only. Candidate to lift into derive.ts.
  const consumption = Object.fromEntries(
    PROVIDER_IDS.map((id) => [
      id,
      isProviderLive(state.connections[id])
        ? (snapshot.providers[id].scopes[state.scope].percent ?? 0)
        : 0,
    ]),
  ) as Record<ProviderId, number>;
  const consumptionTotal = PROVIDER_IDS.reduce((acc, id) => acc + consumption[id], 0);

  const chart = planChart(
    PROVIDER_IDS.map((id) => {
      const scope = snapshot.providers[id].scopes[state.scope];
      const isLive = isProviderLive(state.connections[id]);
      return {
        value: isLive && scope.percent !== null ? scope.percent : null,
        color: PROVIDER_COLORS[id],
        label: PLAN_LABELS[id],
      };
    }),
  );

  const leadLine = consumptionTotal ? "" : "nothing connected - 5 settings to enable a provider";

  const showChart = width >= PLAN_CHART_MIN_CONTENT_WIDTH;
  const legendWidth = showChart ? width - chart.width - PLAN_CHART_GAP : width;
  const barWidth = Math.max(10, Math.min(LEGEND_BAR_MAX_WIDTH, legendWidth - PERCENT_COLUMN));

  const worstId = derived.worstId;
  const bestId = derived.bestId;
  const worstPercent = worstId ? (snapshot.providers[worstId].scopes[state.scope].percent ?? 0) : 0;
  const bestPercent = bestId ? (snapshot.providers[bestId].scopes[state.scope].percent ?? 0) : 0;

  return (
    <box flexDirection="column" flexShrink={0}>
      <SplitLine
        width={width}
        left={[
          { text: "window ", color: COLORS.textDim },
          ...scopeToggleSegments(state.scope, actions),
        ]}
        right={[{ text: scopeTitle, color: COLORS.textMuted, isBold: true }]}
      />
      <Rule width={width} />
      <Spacer />

      <box flexDirection="row" flexShrink={0}>
        {showChart ? <PlanUsage chart={chart} leadLine={leadLine} /> : null}
        {showChart ? <box width={PLAN_CHART_GAP} flexShrink={0} /> : null}
        <box flexDirection="column" flexShrink={0} width={legendWidth}>
          {PROVIDER_IDS.map((id, index) => (
            <box key={id} flexDirection="column" flexShrink={0}>
              {index > 0 ? <Spacer /> : null}
              <ProviderLegend
                id={id}
                name={snapshot.providers[id].meta.name}
                entry={buildLegend(id, state, snapshot, consumption, consumptionTotal, barWidth)}
                width={legendWidth}
                onSelect={() => actions.openProvider(id)}
              />
            </box>
          ))}
          <Spacer />
          <Rule width={legendWidth} />
          <Line
            width={legendWidth}
            segments={closestToLimitSegments(worstId, worstPercent, snapshot)}
          />
          <Line
            width={legendWidth}
            segments={mostHeadroomSegments(bestId, bestPercent, snapshot)}
          />
          <Line
            width={legendWidth}
            segments={[{ text: derived.windowNote, color: COLORS.textGhost }]}
          />
        </box>
      </box>
    </box>
  );
}

const SCOPE_OPTIONS: ToggleOption<ScopeKey>[] = [
  { label: "session", value: "session" },
  { label: "weekly", value: "weekly" },
];

function scopeToggleSegments(scope: ScopeKey, actions: AppActions): Segment[] {
  return [
    ...toggleSegments(SCOPE_OPTIONS, scope, COLORS.info, (value) => actions.setScope(value)),
    ...toggleChip("w", () => actions.toggleScope()),
  ];
}
