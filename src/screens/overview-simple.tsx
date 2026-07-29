import type { ChartRow } from "../lib/chart";
import { buildMeter, emptyMeter } from "../lib/meter";
import { columnWidth, padEnd, truncate } from "../lib/text";
import { BLOCK_RAMP, COLORS, PROVIDER_COLORS, THRESHOLDS } from "../theme";
import {
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
const HISTOGRAM_MIN_CONTENT_WIDTH = 88;
const HISTOGRAM_GAP = 4;

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
  share: string;
}

function buildLegend(
  id: ProviderId,
  state: AppState,
  derived: DerivedState,
  snapshot: UsageSnapshot,
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
    percentLabel: hasCap
      ? meter.percentLabel
      : !connection.isEnabled
        ? "off"
        : connection.status !== "active"
          ? "—"
          : "n/a",
    percentColor: hasCap ? meter.percentColor : status.color,
    fill: meter.fill,
    track: meter.track,
    fillColor: meter.color,
    window: isLive ? scope.window : !connection.isEnabled ? "hidden in settings" : status.label,
    reset: isLive
      ? scope.reset
      : !connection.isEnabled
        ? "space in settings to show it again"
        : connection.note,
    share:
      hasCap && derived.scopeTotal > 0
        ? `${Math.round((derived.scopeConsumption[id] / derived.scopeTotal) * 100)}%`
        : "—",
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
        right={[{ text: `${entry.share} share of active limits`, color: COLORS.textGhost }]}
      />
      <Line
        segments={[
          { text: padEnd(entry.percentLabel, PERCENT_COLUMN), color: entry.percentColor, isBold: true },
          { text: entry.fill, color: entry.fillColor },
          { text: entry.track, color: COLORS.track },
        ]}
      />
      <Line
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

const HISTOGRAM_MAX_WIDTH = 34;
const HISTOGRAM_MIN_WIDTH = 22;
const HISTOGRAM_WIDTH_RATIO = 0.26;
const HISTOGRAM_AXIS_WIDTH = 4;
const HISTOGRAM_PLOT_HEIGHT = 10;
const HISTOGRAM_BAR_MAX_WIDTH = 6;

const HISTOGRAM_LABELS: Record<ProviderId, string> = {
  cl: "claude",
  cx: "codex",
  go: "go",
};

function histogramWidth(contentWidth: number): number {
  const raw = Math.round(contentWidth * HISTOGRAM_WIDTH_RATIO);
  return Math.max(HISTOGRAM_MIN_WIDTH, Math.min(HISTOGRAM_MAX_WIDTH, raw));
}

function center(value: string, width: number): string {
  const clipped = truncate(value, width);
  const left = Math.floor((width - columnWidth(clipped)) / 2);
  return `${" ".repeat(left)}${padEnd(clipped, width - left)}`;
}

function histogramRows(
  entries: Array<{ id: ProviderId; percent: number | null }>,
  width: number,
): ChartRow[] {
  const plotWidth = width - HISTOGRAM_AXIS_WIDTH;
  const baseSlotWidth = Math.floor(plotWidth / entries.length);
  const extraColumns = plotWidth % entries.length;
  const slotWidths = entries.map((_, index) => baseSlotWidth + (index < extraColumns ? 1 : 0));
  const rows: ChartRow[] = [];

  for (let row = 0; row < HISTOGRAM_PLOT_HEIGHT; row++) {
    const tick = row === 0 ? "100" : row === HISTOGRAM_PLOT_HEIGHT / 2 ? " 50" : "   ";
    const segments: ChartRow["segments"] = [
      { text: tick, color: COLORS.textGhost },
      { text: tick.trim() ? "┤" : "│", color: COLORS.divider },
    ];

    entries.forEach((entry, index) => {
      const slotWidth = slotWidths[index] ?? 0;
      const barWidth = Math.max(1, Math.min(HISTOGRAM_BAR_MAX_WIDTH, slotWidth - 2));
      const left = Math.floor((slotWidth - barWidth) / 2);
      const right = slotWidth - barWidth - left;
      const scaled = ((entry.percent ?? 0) / 100) * HISTOGRAM_PLOT_HEIGHT;
      const level = scaled - (HISTOGRAM_PLOT_HEIGHT - row - 1);
      const block =
        entry.percent === null || level <= 0
          ? " "
          : level >= 1
            ? "█"
            : BLOCK_RAMP[Math.max(1, Math.min(8, Math.round(level * 8)))]!;

      segments.push(
        { text: " ".repeat(left), color: COLORS.bg },
        {
          text: block.repeat(barWidth),
          color: entry.percent === null ? COLORS.track : PROVIDER_COLORS[entry.id],
        },
        { text: " ".repeat(right), color: COLORS.bg },
      );
    });
    rows.push({ segments });
  }

  rows.push({
    segments: [
      { text: "  0└", color: COLORS.textGhost },
      { text: "─".repeat(plotWidth), color: COLORS.divider },
    ],
  });
  rows.push({
    segments: [
      { text: " ".repeat(HISTOGRAM_AXIS_WIDTH), color: COLORS.bg },
      ...entries.map((entry, index) => ({
        text: center(HISTOGRAM_LABELS[entry.id], slotWidths[index] ?? 0),
        color: COLORS.textMuted,
      })),
    ],
  });
  rows.push({
    segments: [
      { text: " ".repeat(HISTOGRAM_AXIS_WIDTH), color: COLORS.bg },
      ...entries.map((entry, index) => ({
        text: center(entry.percent === null ? "—" : `${entry.percent}%`, slotWidths[index] ?? 0),
        color: entry.percent === null ? COLORS.textFaint : PROVIDER_COLORS[entry.id],
      })),
    ],
  });
  return rows;
}

function HistogramSummary({
  state,
  derived,
  snapshot,
  width,
}: {
  state: AppState;
  derived: DerivedState;
  snapshot: UsageSnapshot;
  width: number;
}) {
  const entries = derived.visibleIds.map((id) => ({
    id,
    percent: isProviderLive(state.connections[id])
      ? snapshot.providers[id].scopes[state.scope].percent
      : null,
  }));

  return (
    <box flexDirection="column" flexShrink={0} width={width}>
      <SplitLine
        width={width}
        left={[{ text: "plan usage", color: COLORS.text, isBold: true }]}
        right={[{ text: "%", color: COLORS.textGhost }]}
      />
      <Spacer />
      <Chart rows={histogramRows(entries, width)} />
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
  const showHistogram = width >= HISTOGRAM_MIN_CONTENT_WIDTH && derived.visibleIds.length > 0;
  const summaryWidth = histogramWidth(width);
  const legendWidth = showHistogram ? width - summaryWidth - HISTOGRAM_GAP : width;
  const barWidth = Math.max(10, legendWidth - PERCENT_COLUMN);

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
        right={[
          { text: scopeTitle, color: COLORS.textMuted, isBold: true },
          { text: " ▏ ", color: COLORS.rule },
          { text: "relative usage across active plan limits", color: COLORS.textGhost },
        ]}
      />
      <Rule width={width} />
      <Spacer />

      <box flexDirection="row" flexShrink={0}>
        {showHistogram ? (
          <HistogramSummary
            state={state}
            derived={derived}
            snapshot={snapshot}
            width={summaryWidth}
          />
        ) : null}
        {showHistogram ? <box width={HISTOGRAM_GAP} flexShrink={0} /> : null}
        <box flexDirection="column" flexShrink={0} width={legendWidth}>
          {derived.visibleIds.map((id, index) => (
            <box key={id} flexDirection="column" flexShrink={0}>
              {index > 0 ? <Spacer /> : null}
              <ProviderLegend
                id={id}
                name={snapshot.providers[id].meta.name}
                entry={buildLegend(id, state, derived, snapshot, barWidth)}
                width={legendWidth}
                onSelect={() => actions.openProvider(id)}
              />
            </box>
          ))}
          {derived.visibleIds.length === 0 ? (
            <Line segments={[{ text: "no providers match the current filter", color: COLORS.textFaint }]} />
          ) : null}
          <Spacer />
          <Rule width={legendWidth} />
          <Line
            segments={[
              {
                text: "▲ ",
                 color:
                   worstPercent >= THRESHOLDS.danger
                     ? COLORS.danger
                     : worstPercent >= THRESHOLDS.warn
                       ? COLORS.warn
                       : COLORS.textGhost,
              },
              {
                text: worstId
                  ? `${snapshot.providers[worstId].meta.name} ${worstPercent}%`
                  : "nothing is being tracked",
                color: COLORS.text,
              },
              {
                text: worstId ? " is closest to its cap" : " — every provider is off or disconnected",
                color: COLORS.textFaint,
              },
            ]}
          />
          <Line
            segments={[
              { text: "→ ", color: COLORS.ok },
              {
                text: bestId
                  ? `${snapshot.providers[bestId].meta.name} ${100 - bestPercent}% free`
                  : "open settings",
                color: COLORS.text,
              },
              {
                text: bestId
                  ? " has the most headroom right now"
                  : " to enable a provider or paste a key",
                color: COLORS.textFaint,
              },
            ]}
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
