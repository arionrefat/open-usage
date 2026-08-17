import { barLabels, bars, formatTokens, sum } from "../lib/chart";
import { buildMeter } from "../lib/meter";
import { columnWidth, padEnd, padStart } from "../lib/text";
import { formatMoney, modelShares, shortModelName } from "../lib/spend";
import { COLORS, PROVIDER_COLORS } from "../theme";
import {
  STATUS_PRESENTATION,
  type DetailSection,
  type ProviderId,
  type ProviderNotice,
  type SpendSummary,
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

function chartFooter(axis: readonly [string, string, string], width: number): Segment[] | null {
  const left = `└─ ${axis[0]} `;
  const center = ` ${axis[1]} `;
  const right = ` ${axis[2]} ─┘`;
  const centerStart = Math.floor((width - columnWidth(center)) / 2);
  const rightStart = width - columnWidth(right);
  if (columnWidth(left) + 1 > centerStart || centerStart + columnWidth(center) + 1 > rightStart) {
    return null;
  }
  return [
    { text: "└─ ", color: COLORS.borderPanel },
    { text: `${axis[0]} `, color: COLORS.textGhost },
    { text: "─".repeat(centerStart - columnWidth(left)), color: COLORS.borderPanel },
    { text: center, color: COLORS.textGhost },
    {
      text: "─".repeat(rightStart - centerStart - columnWidth(center)),
      color: COLORS.borderPanel,
    },
    { text: ` ${axis[2]} `, color: COLORS.textGhost },
    { text: "─┘", color: COLORS.borderPanel },
  ];
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

function Details({ sections, width, color }: {
  sections: DetailSection[];
  width: number;
  color: string;
}) {
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

const SPEND_BAR_WIDTH = 10;
/** Enough rows to show where the money went without pushing the chart offscreen. */
const SPEND_MODEL_ROWS = 5;

function Spend({ spend, width, color }: { spend: SpendSummary; width: number; color: string }) {
  const { current } = spend;
  const models = current.models.slice(0, SPEND_MODEL_ROWS);
  const shares = modelShares(current.models).slice(0, SPEND_MODEL_ROWS);
  const nameWidth = Math.max(
    columnWidth("total"),
    ...models.map((model) =>
      columnWidth(shortModelName(model.model) + (model.isFast ? " fast" : "")),
    ),
  );
  const valueWidth = Math.max(
    current.total ? columnWidth(formatMoney(current.total)) : 1,
    ...models.map((model) => (model.cost ? columnWidth(formatMoney(model.cost)) : 1)),
  );

  const heading = `spend · ${current.label}`;
  const tag =
    current.exactness === "exact"
      ? "exact"
      : current.exactness === "estimated"
        ? `est · api rates ${spend.pricesAsOf}`
        : "no figure";

  const split = current.models.reduce(
    (totals, model) => ({
      input: totals.input + model.tokens.input,
      output: totals.output + model.tokens.output,
      cacheWrite: totals.cacheWrite + model.tokens.cacheWrite,
      cacheRead: totals.cacheRead + model.tokens.cacheRead,
    }),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  );

  return (
    <box flexDirection="column" flexShrink={0} width={width}>
      <SplitLine
        width={width}
        left={[
          { text: "─ ", color: COLORS.borderPanel },
          { text: `${heading} `, color: COLORS.textMuted, isBold: true },
        ]}
        right={[{ text: ` ${tag} `, color: COLORS.textGhost }]}
        filler="─"
        fillerColor={COLORS.borderPanel}
      />
      {models.map((model, index) => {
        const meter = buildMeter(shares[index] ?? 0, SPEND_BAR_WIDTH, color);
        const name = shortModelName(model.model) + (model.isFast ? " fast" : "");
        return (
          <Line
            key={`${model.model}-${index}`}
            width={width}
            segments={[
              { text: padEnd(name, nameWidth), color: COLORS.textFaint },
              { text: "  ", color: COLORS.rule },
              {
                text: padStart(model.cost ? formatMoney(model.cost) : "-", valueWidth),
                color: model.cost ? COLORS.text : COLORS.textGhost,
              },
              { text: "  ", color: COLORS.rule },
              { text: meter.fill, color },
              { text: meter.track, color: COLORS.track },
              { text: `  ${padStart(meter.percentLabel, 4)}`, color: COLORS.textGhost },
            ]}
          />
        );
      })}
      <Line
        width={width}
        segments={[
          { text: padEnd("total", nameWidth), color: COLORS.textMuted, isBold: true },
          { text: "  ", color: COLORS.rule },
          {
            text: padStart(current.total ? formatMoney(current.total) : "-", valueWidth),
            color: current.total ? COLORS.textBright : COLORS.textGhost,
            isBold: true,
          },
          ...(current.limit
            ? [
                { text: "  of ", color: COLORS.textGhost },
                { text: formatMoney(current.limit), color: COLORS.textFaint },
              ]
            : []),
          // The money's window when it is not this period's - never conflate them.
          ...(current.totalWindowLabel
            ? [{ text: `  ${current.totalWindowLabel}`, color: COLORS.textGhost }]
            : []),
        ]}
      />
      <Line
        width={width}
        segments={[
          { text: "in ", color: COLORS.textGhost },
          { text: formatTokens(split.input / 1_000_000), color: COLORS.text },
          { text: " ▏ out ", color: COLORS.textGhost },
          { text: formatTokens(split.output / 1_000_000), color: COLORS.text },
          { text: " ▏ cache-w ", color: COLORS.textGhost },
          { text: formatTokens(split.cacheWrite / 1_000_000), color: COLORS.text },
          { text: " ▏ cache-r ", color: COLORS.textGhost },
          { text: formatTokens(split.cacheRead / 1_000_000), color: COLORS.text },
        ]}
      />
      {spend.history.length > 0 ? (
        <Line
          width={width}
          segments={spend.history.flatMap((period, index) => [
            ...(index > 0 ? [{ text: " ▏ ", color: COLORS.rule }] : []),
            { text: `${period.label} `, color: COLORS.textGhost },
            {
              text: period.total ? formatMoney(period.total) : "not recorded",
              color: period.total ? COLORS.textFaint : COLORS.textGhost,
            },
          ])}
        />
      ) : null}
      {spend.unpricedModels.length > 0 ? (
        <Line
          width={width}
          segments={[
            { text: "unpriced ", color: COLORS.textGhost },
            { text: spend.unpricedModels.map(shortModelName).join(", "), color: COLORS.textFaint },
          ]}
        />
      ) : null}
    </box>
  );
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
  const chartLabels = barLabels(series, chartWidth, chartHeight, formatTokens, COLORS.text).map((label) => ({
    ...label,
    offset: label.offset + 1,
  }));
  const activeDays = series.filter((value) => value > 0).length;
  const totalTokens = sum(series);
  const chartTokenLabel = provider.activityScope === "account" ? "account tokens" : "tokens";
  const chartFooterSegments = chartFooter(derived.axis, width);

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
            dangerThreshold={state.warnThreshold}
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
      {/* An empty frame reads as a broken chart, so no history collapses to a rule. */}
      {totalTokens <= 0 ? (
        <SplitLine
          width={width}
          left={[
            { text: "─ ", color: COLORS.borderPanel },
            {
              text: `${chartTokenLabel} ${derived.rangeName} · no activity `,
              color: COLORS.textMuted,
              isBold: true,
            },
          ]}
          filler="─"
          fillerColor={COLORS.borderPanel}
        />
      ) : (
        <>
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
            right={[{ text: "─┐", color: COLORS.borderPanel }]}
            filler="─"
            fillerColor={COLORS.borderPanel}
          />
          <Chart
            rows={chartRows}
            labels={chartLabels}
            labelWidth={width}
            labelBorderColor={COLORS.borderPanel}
          />
          {chartFooterSegments ? (
            <Line width={width} segments={chartFooterSegments} />
          ) : (
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
          )}
        </>
      )}

      {provider.spend ? (
        <>
          <Spacer />
          <Spend spend={provider.spend} width={width} color={PROVIDER_COLORS[id]} />
        </>
      ) : null}

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
