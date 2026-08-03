import { barLabels, bars, formatTokens, sum } from "../lib/chart";
import { buildMeter } from "../lib/meter";
import { columnWidth, padStart } from "../lib/text";
import { COLORS, PROVIDER_COLORS } from "../theme";
import {
  STATUS_PRESENTATION,
  type DetailSection,
  type ProviderId,
  type ProviderNotice,
  type UsageSnapshot,
} from "../data/types";
import { isProviderLive, type AppState } from "../state/app-state";
import type { DerivedState } from "../state/derive";
import { DetailLimitMeter } from "../components/limit-meter";
import { Chart, Line, SplitLine, Spacer, type Segment } from "../components/primitives";

/** Colors the footer stats locally: numbers bright, "▏" separators dim. */
function footerSegments(footer: string): Segment[] {
  return footer.split(/(\s+)/).map((token) => ({
    text: token,
    color: token === "▏" ? COLORS.rule : /^\d/.test(token) ? COLORS.text : COLORS.textGhost,
  }));
}

interface ProviderDetailProps {
  id: ProviderId;
  state: AppState;
  derived: DerivedState;
  snapshot: UsageSnapshot;
  width: number;
  chartHeight: number;
}

function Notice({ notice, width }: { notice: ProviderNotice; width: number }) {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={width}
      border
      borderColor={COLORS.borderPanel}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        {notice.icon ? <span fg={notice.iconColor ?? COLORS.info}>{`${notice.icon}  `}</span> : null}
        {notice.segments.map((segment, index) => (
          <span key={`notice-${index}`} fg={segment.isEmphasis ? COLORS.text : COLORS.textMuted}>
            {segment.text}
          </span>
        ))}
      </text>
    </box>
  );
}

function StaleBanner({ id, state, width }: { id: ProviderId; state: AppState; width: number }) {
  const connection = state.connections[id];
  const status = STATUS_PRESENTATION[connection.status];
  const label = connection.isEnabled ? status.label : "hidden in settings";
  const color = connection.isEnabled ? status.color : COLORS.textFaint;
  const note = connection.isEnabled
    ? `${connection.note} - figures below are the last values read`
    : "the credential is preserved - figures below are the last values read";
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={width}
      border
      borderColor={COLORS.noticeBorder}
      backgroundColor={COLORS.noticeBg}
      paddingLeft={1}
      paddingRight={1}
    >
      <Line
        segments={[
          { text: label, color, isBold: true },
          { text: " ▏ ", color: COLORS.rule },
          { text: note, color: COLORS.textSoft },
        ]}
      />
    </box>
  );
}

const DETAIL_BAR_WIDTH = 12;
const DETAIL_COLUMN_GAP = 2;
const DETAIL_COLUMN_COUNT = 3;
const DETAIL_WIDE_MINIMUM = 110;
const DETAIL_STACKED_WIDTH = 60;

function DetailSectionColumn({
  section,
  width,
  color,
}: {
  section: DetailSection;
  width: number;
  color: string;
}) {
  const valueWidth = Math.max(1, ...section.rows.map((row) => columnWidth(row.value)));

  return (
    <box flexDirection="column" flexShrink={0} width={width}>
      <Line
        width={width}
        segments={[{ text: section.title, color: COLORS.textMuted, isBold: true }]}
      />
      {section.rows.map((row, rowIndex) => {
        const rowColor = row.color ?? color;
        const meter = row.percent === null || row.percent === undefined
          ? null
          : buildMeter(row.percent, DETAIL_BAR_WIDTH, rowColor);
        return (
          <SplitLine
            key={`${row.label}-${rowIndex}`}
            width={width}
            left={[{ text: row.label, color: COLORS.textFaint }]}
            right={[
              ...(meter
                ? [
                    { text: meter.fill, color: rowColor },
                    { text: meter.track, color: COLORS.track },
                    { text: " ", color: COLORS.rule },
                  ]
                : []),
              { text: padStart(row.value, valueWidth), color: COLORS.text },
            ]}
          />
        );
      })}
    </box>
  );
}

function Details({ sections, width, color }: { sections: DetailSection[]; width: number; color: string }) {
  const visibleSections = sections.filter((section) => section.rows.length > 0);
  if (width < DETAIL_WIDE_MINIMUM) {
    const stackedWidth = Math.min(width, DETAIL_STACKED_WIDTH);
    return visibleSections.map((section, sectionIndex) => (
      <box key={`${section.title}-${sectionIndex}`} flexDirection="column" flexShrink={0}>
        {sectionIndex > 0 ? <Spacer /> : null}
        <DetailSectionColumn section={section} width={stackedWidth} color={color} />
      </box>
    ));
  }

  const bands: DetailSection[][] = [];
  for (let index = 0; index < visibleSections.length; index += DETAIL_COLUMN_COUNT) {
    bands.push(visibleSections.slice(index, index + DETAIL_COLUMN_COUNT));
  }
  const columnWidth = Math.floor(
    (width - DETAIL_COLUMN_GAP * (DETAIL_COLUMN_COUNT - 1)) / DETAIL_COLUMN_COUNT,
  );
  return bands.map((band, bandIndex) => (
    <box key={`detail-band-${bandIndex}`} flexDirection="column" flexShrink={0}>
      {bandIndex > 0 ? <Spacer /> : null}
      <box flexDirection="row" flexShrink={0}>
        {band.map((section, sectionIndex) => (
          <box key={`${section.title}-${sectionIndex}`} flexDirection="row" flexShrink={0}>
            {sectionIndex > 0 ? <box width={DETAIL_COLUMN_GAP} flexShrink={0} /> : null}
            <DetailSectionColumn section={section} width={columnWidth} color={color} />
          </box>
        ))}
      </box>
    </box>
  ));
}

export function ProviderDetail({
  id,
  state,
  derived,
  snapshot,
  width,
  chartHeight,
}: ProviderDetailProps) {
  const provider = snapshot.providers[id];
  const isStale = !isProviderLive(state.connections[id]);
  const limits = provider.limits.filter((limit) => !limit.isCardOnly);
  const series = derived.series[id];
  const chartWidth = Math.max(0, width - 2);
  const chartRows = bars(series, chartWidth, chartHeight, PROVIDER_COLORS[id]).map((row) => ({
    segments: [
      { text: "│", color: COLORS.borderPanel },
      ...row.segments,
      { text: "│", color: COLORS.borderPanel },
    ],
  }));
  const chartLabels = barLabels(series, chartWidth, formatTokens, COLORS.text).map((label) => ({
    ...label,
    offset: label.offset + 1,
  }));
  const activeDays = series.filter((value) => value > 0).length;
  const totalTokens = sum(series);
  const chartTokenLabel = provider.activityScope === "account" ? "account tokens" : "tokens";

  return (
    <box flexDirection="column" flexShrink={0}>
      <SplitLine
        width={width}
        left={[
          { text: "▎", color: PROVIDER_COLORS[id] },
          { text: provider.meta.name, color: COLORS.textBright, isBold: true },
          { text: " ▏ ", color: COLORS.rule },
          { text: provider.meta.planDetail, color: COLORS.textFaint },
        ]}
      />
      {isStale ? (
        <>
          <Spacer />
          <StaleBanner id={id} state={state} width={width} />
        </>
      ) : null}
      <Spacer />

      {limits.map((limit, index) => (
        <box key={limit.id} flexDirection="column" flexShrink={0}>
          {index > 0 ? <Spacer /> : null}
          <DetailLimitMeter
            limit={limit}
            width={width}
            accentColor={PROVIDER_COLORS[id]}
            useSeverityColors={state.useSeverityColors}
          />
        </box>
      ))}

      {provider.notice ? (
        <>
          <Spacer />
          <Notice notice={provider.notice} width={width} />
        </>
      ) : null}

      <Spacer />
      <SplitLine
        width={width}
        left={[
          { text: "┌─ ", color: COLORS.borderPanel },
          {
            text: `${chartTokenLabel} ${derived.rangeName} · ${formatTokens(totalTokens)} total · ${activeDays}/${series.length} active `,
            color: COLORS.textMuted,
            isBold: true,
          },
        ]}
        right={[
          { text: ` peak ${formatTokens(Math.max(0, ...series))} `, color: COLORS.textGhost },
          { text: "─┐", color: COLORS.borderPanel },
        ]}
        filler="─"
        fillerColor={COLORS.borderPanel}
      />
      <Chart
        rows={chartRows}
        labels={chartLabels}
        labelWidth={width}
        labelBorderColor={COLORS.borderPanel}
      />
      <SplitLine
        width={width}
        left={[
          { text: "└─ ", color: COLORS.borderPanel },
          { text: `${derived.axis[0]} `, color: COLORS.textGhost },
        ]}
        right={[
          { text: ` ${derived.axis[2]} `, color: COLORS.textGhost },
          { text: "─┘", color: COLORS.borderPanel },
        ]}
        filler="─"
        fillerColor={COLORS.borderPanel}
      />

      {provider.details?.some((section) => section.rows.length > 0) ? (
        <>
          <Spacer />
          <Details sections={provider.details} width={width} color={PROVIDER_COLORS[id]} />
        </>
      ) : null}

      {provider.detailFooter ? (
        <>
          <Spacer />
          <Line width={width} segments={footerSegments(provider.detailFooter)} />
        </>
      ) : null}
    </box>
  );
}
