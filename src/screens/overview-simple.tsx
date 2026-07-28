import { DONUT_INNER_RADIUS, donutChart } from "../lib/chart";
import { buildMeter, emptyMeter } from "../lib/meter";
import { padEnd, truncate } from "../lib/text";
import { COLORS, PROVIDER_COLORS } from "../theme";
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
const DONUT_MIN_CONTENT_WIDTH = 88;
const DONUT_GAP = 4;

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
        right={[{ text: `${entry.share} of all consumption`, color: COLORS.textGhost }]}
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

const DONUT_MAX_WIDTH = 34;
const DONUT_MIN_WIDTH = 22;
/** Share of the content width the donut is allowed to take. */
const DONUT_WIDTH_RATIO = 0.26;
/**
 * Half-block rendering gives two samples per row, so a cell row spans two
 * sub-rows. A terminal cell is about twice as tall as it is wide, which makes
 * a sub-row roughly square — half the width in rows draws a true circle.
 */
const DONUT_ASPECT = 0.5;
/** Columns of clearance kept between the caption and the ring. */
const CAPTION_MARGIN = 2;

function donutSize(contentWidth: number): { width: number; height: number; holeWidth: number } {
  const raw = Math.round(contentWidth * DONUT_WIDTH_RATIO);
  const width = Math.max(DONUT_MIN_WIDTH, Math.min(DONUT_MAX_WIDTH, raw % 2 === 0 ? raw : raw + 1));
  return {
    width,
    height: Math.round(width * DONUT_ASPECT),
    // Derived from the ring itself so the two can never drift apart.
    holeWidth: Math.floor(width * DONUT_INNER_RADIUS) - CAPTION_MARGIN,
  };
}

function DonutSummary({
  derived,
  snapshot,
  size,
}: {
  derived: DerivedState;
  snapshot: UsageSnapshot;
  size: { width: number; height: number; holeWidth: number };
}) {
  const rows = donutChart(
    PROVIDER_IDS.map((id) => derived.scopeConsumption[id]),
    PROVIDER_IDS.map((id) => PROVIDER_COLORS[id]),
    size.width,
    size.height,
  );

  const hasData = derived.scopeTotal > 0;
  const leadId = derived.leadId;
  const share =
    hasData && leadId
      ? `${Math.round((derived.scopeConsumption[leadId] / derived.scopeTotal) * 100)}%`
      : "no data";
  const holeWidth = size.holeWidth;

  // Captions are laid out unpadded and centered so only their glyphs paint —
  // padding them to the hole width would cut a rectangle out of the ring. The
  // copy is kept short enough to fit the hole; truncation is the last resort.
  const captions: Segment[] = [
    {
      text: share,
      color: leadId && hasData ? PROVIDER_COLORS[leadId] : COLORS.textFaint,
      isBold: true,
    },
    {
      text: leadId && hasData ? snapshot.providers[leadId].meta.name : "nothing connected",
      color: COLORS.text,
    },
    {
      text: hasData ? "of all consumption" : "see settings",
      color: COLORS.textGhost,
    },
  ].map((caption) => ({ ...caption, text: truncate(caption.text, holeWidth) }));

  const captionTop = Math.floor((size.height - captions.length) / 2);

  return (
    <box flexDirection="column" flexShrink={0} width={size.width} height={size.height}>
      <Chart rows={rows} />
      <box
        position="absolute"
        top={captionTop}
        left={0}
        width={size.width}
        flexDirection="column"
        alignItems="center"
      >
        {captions.map((caption, index) => (
          <Line key={`caption-${index}`} segments={[caption]} />
        ))}
      </box>
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
  const showDonut = width >= DONUT_MIN_CONTENT_WIDTH;
  const size = donutSize(width);
  const legendWidth = showDonut ? width - size.width - DONUT_GAP : width;
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
          { text: "share of limit consumed across providers", color: COLORS.textGhost },
        ]}
      />
      <Rule width={width} />
      <Spacer />

      <box flexDirection="row" flexShrink={0}>
        {showDonut ? <DonutSummary derived={derived} snapshot={snapshot} size={size} /> : null}
        {showDonut ? <box width={DONUT_GAP} flexShrink={0} /> : null}
        <box flexDirection="column" flexShrink={0} width={legendWidth}>
          {PROVIDER_IDS.map((id, index) => (
            <box key={id} flexDirection="column" flexShrink={0}>
              {index > 0 ? <Spacer /> : null}
              <ProviderLegend
                id={id}
                name={snapshot.providers[id].meta.name}
                entry={buildLegend(id, state, derived, snapshot, barWidth)}
                width={legendWidth}
                onSelect={() => actions.selectProvider(id)}
              />
            </box>
          ))}
          <Spacer />
          <Rule width={legendWidth} />
          <Line
            segments={[
              {
                text: "▲ ",
                color: worstPercent >= 85 ? COLORS.danger : worstPercent >= 70 ? COLORS.warn : COLORS.textGhost,
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
