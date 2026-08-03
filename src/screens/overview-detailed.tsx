import { formatTokens, sparkline, stackedBar, sum } from "../lib/chart";
import { columnWidth, padEnd } from "../lib/text";
import { COLORS, PROVIDER_COLORS, THRESHOLDS } from "../theme";
import { PROVIDER_IDS, STATUS_PRESENTATION, type ProviderId, type UsageSnapshot } from "../data/types";
import { isProviderLive, type AppState } from "../state/app-state";
import type { AppActions } from "../state/actions";
import type { DerivedState } from "../state/derive";
import { CardLimitMeter } from "../components/limit-meter";
import { Line, Rule, SplitLine, Spacer, leftClick, type Segment } from "../components/primitives";

const CARD_MAX_WIDTH = 44;
const CARD_GAP = 2;
const DAY_LABEL_WIDTH = 9;
const MIN_COLUMN_WIDTH = 20;
const SPARKLINE_WIDTH = 40;

interface OverviewDetailedProps {
  state: AppState;
  derived: DerivedState;
  snapshot: UsageSnapshot;
  width: number;
  actions: AppActions;
}

function columnWidthFor(width: number, count: number): number {
  if (count <= 0) return width;
  if (width < MIN_COLUMN_WIDTH * count + CARD_GAP * (count - 1)) return width;
  return Math.min(CARD_MAX_WIDTH, Math.floor((width - CARD_GAP * (count - 1)) / count));
}

function columnsStack(width: number, count: number): boolean {
  return count > 1 && width < MIN_COLUMN_WIDTH * count + CARD_GAP * (count - 1);
}

function pressureColor(percent: number, dangerThreshold: number): string {
  if (percent >= dangerThreshold) return COLORS.danger;
  if (percent >= THRESHOLDS.warn) return COLORS.warn;
  return COLORS.textGhost;
}

function shareBarSegments(percent: number, width: number, color: string): Segment[] {
  const barWidth = Math.max(1, width);
  const filled = percent > 0 ? Math.max(1, Math.round((percent / 100) * barWidth)) : 0;
  return [
    { text: "━".repeat(filled), color },
    { text: "─".repeat(barWidth - filled), color: COLORS.track },
  ];
}

function closestToLimitSegments(
  worstId: ProviderId | null,
  worstPercent: number,
  snapshot: UsageSnapshot,
): Segment[] {
  return [
    {
      text: worstId
        ? `${snapshot.providers[worstId].meta.name} ${worstPercent}%`
        : "nothing is being tracked",
      color: COLORS.text,
    },
  ];
}

function mostHeadroomSegments(
  bestId: ProviderId | null,
  bestPercent: number,
  snapshot: UsageSnapshot,
): Segment[] {
  return [
    {
      text: bestId
        ? `${snapshot.providers[bestId].meta.name} ${100 - bestPercent}% free`
        : "open settings",
      color: COLORS.text,
    },
  ];
}

function ColumnGap({ isStacked }: { isStacked: boolean }) {
  return isStacked ? <Spacer /> : <box width={CARD_GAP} flexShrink={0} />;
}

function DisconnectedNotice({
  id,
  state,
  width,
  onOpenSettings,
}: {
  id: ProviderId;
  state: AppState;
  width: number;
  onOpenSettings: () => void;
}) {
  const connection = state.connections[id];
  const status = STATUS_PRESENTATION[connection.status];
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
      <Line segments={[{ text: status.label, color: status.color, isBold: true }]} />
      <Line segments={[{ text: connection.note, color: COLORS.textSoft }]} />
      <Spacer />
      <Line
        segments={[
          { text: "no limits to read - ", color: COLORS.textGhost, onClick: onOpenSettings },
          { text: "5", color: COLORS.textSoft, onClick: onOpenSettings },
          { text: " settings to reconnect", color: COLORS.textGhost, onClick: onOpenSettings },
        ]}
      />
    </box>
  );
}

function ProviderCard({
  id,
  state,
  snapshot,
  width,
  isSelected,
  actions,
}: {
  id: ProviderId;
  state: AppState;
  snapshot: UsageSnapshot;
  width: number;
  isSelected: boolean;
  actions: AppActions;
}) {
  const provider = snapshot.providers[id];
  const isLive = isProviderLive(state.connections[id]);

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={width}
      onMouseDown={leftClick(() => actions.selectProvider(id))}
    >
      <SplitLine
        width={width}
        left={[
          { text: "▎", color: isSelected ? PROVIDER_COLORS[id] : COLORS.markIdle },
          { text: provider.meta.name, color: isSelected ? COLORS.textBright : COLORS.textSoft, isBold: true },
        ]}
        right={[{ text: provider.meta.planShort, color: COLORS.textGhost }]}
      />
      <Spacer />
      {isLive ? (
        provider.limits.map((limit, index) => (
          <box key={limit.id} flexDirection="column" flexShrink={0}>
            {index > 0 ? <Spacer /> : null}
            <CardLimitMeter
              limit={limit}
              width={width}
              accentColor={PROVIDER_COLORS[id]}
              useSeverityColors={state.useSeverityColors}
              dangerThreshold={state.warnThreshold}
            />
          </box>
        ))
      ) : (
        <DisconnectedNotice
          id={id}
          state={state}
          width={width}
          onOpenSettings={() => actions.setView("settings")}
        />
      )}
    </box>
  );
}

function SummaryTrio({
  state,
  derived,
  snapshot,
  width,
}: OverviewDetailedProps) {
  const column = columnWidthFor(width, 3);
  const isStacked = columnsStack(width, 3);
  const worstId = derived.worstId;
  const bestId = derived.bestId;
  const worstPercent = worstId ? (snapshot.providers[worstId].scopes[state.scope].percent ?? 0) : 0;
  const bestPercent = bestId ? (snapshot.providers[bestId].scopes[state.scope].percent ?? 0) : 0;
  const burn = worstId ? snapshot.providers[worstId].burn : null;
  const isOverBudget = burn !== null && burn.projectedPercent > 100;

  return (
    <box flexDirection={isStacked ? "column" : "row"} flexShrink={0}>
      <box flexDirection="column" flexShrink={0} width={column}>
        <Line
          segments={[
            {
              text: "▲ closest to running out",
              color: pressureColor(worstPercent, state.warnThreshold),
              isBold: true,
            },
          ]}
        />
        <Line segments={closestToLimitSegments(worstId, worstPercent, snapshot)} />
        <Line
          segments={[
            {
              text: burn ? `${burn.limit} · ${burn.timeToReset}` : "every provider is off or disconnected",
              color: COLORS.textFaint,
            },
          ]}
        />
      </box>
      <ColumnGap isStacked={isStacked} />
      <box flexDirection="column" flexShrink={0} width={column}>
        <Line
          segments={[
            { text: "◈ burn rate", color: isOverBudget ? COLORS.warn : COLORS.textFaint, isBold: true },
          ]}
        />
        {burn ? (
          <>
            <Line
              segments={[
                { text: "projected ", color: COLORS.text },
                {
                  text: `${burn.projectedPercent}%`,
                  color: isOverBudget ? COLORS.danger : COLORS.ok,
                },
                { text: " at reset", color: COLORS.text },
              ]}
            />
            <Line
              segments={[
                { text: `at ${burn.rate} you cap out ${burn.capsOutAt}`, color: COLORS.textFaint },
              ]}
            />
          </>
        ) : (
          <>
            <Line segments={[{ text: "nothing to project", color: COLORS.text }]} />
            <Line segments={[{ text: "no provider is being polled", color: COLORS.textFaint }]} />
          </>
        )}
      </box>
      <ColumnGap isStacked={isStacked} />
      <box flexDirection="column" flexShrink={0} width={column}>
        <Line
          segments={[
            { text: "→ route here now", color: bestId ? COLORS.ok : COLORS.textFaint, isBold: true },
          ]}
        />
        <Line segments={mostHeadroomSegments(bestId, bestPercent, snapshot)} />
        <Line
          segments={[
            {
              text: bestId ? "has the most headroom right now" : "to enable a provider or paste a key",
              color: COLORS.textFaint,
            },
          ]}
        />
      </box>
    </box>
  );
}

function UsageShare({ state, derived, snapshot, width }: OverviewDetailedProps) {
  const column = columnWidthFor(width, Math.max(1, derived.visibleIds.length));
  const isStacked = columnsStack(width, derived.visibleIds.length);
  const total = derived.visibleTotal;

  return (
    <box flexDirection="column" flexShrink={0}>
      <SplitLine
        width={width}
        left={[
          { text: "usage share", color: COLORS.textMuted, isBold: true },
          { text: " ▏ ", color: COLORS.rule },
          { text: `${derived.rangeName} · tokens`, color: COLORS.textGhost },
        ]}
        right={[{ text: `${formatTokens(derived.visibleTotal)} total`, color: COLORS.textGhost }]}
      />
      <Spacer />
      <box flexDirection={isStacked ? "column" : "row"} flexShrink={0}>
        {derived.visibleIds.map((id, index) => {
          const provider = snapshot.providers[id];
          const tokens = derived.totals[id];
          const share = total > 0 ? (tokens / total) * 100 : 0;
          const sharePercent = Math.round(share);
          const sessions30d = state.range === "30d" ? provider.sessions30d : undefined;
          const sessionLabel = id === "cx"
            ? sessions30d === 1
              ? "local session"
              : "local sessions"
            : sessions30d === 1
              ? "session"
              : "sessions";
          const tokenLabel = provider.activityScope === "account" ? "account tokens" : "tokens";
          return (
            <box key={id} flexDirection={isStacked ? "column" : "row"} flexShrink={0}>
              {index > 0 ? <ColumnGap isStacked={isStacked} /> : null}
              <box flexDirection="column" flexShrink={0} width={column}>
                <Line
                  segments={[
                    { text: "▎", color: PROVIDER_COLORS[id] },
                    { text: ` ${provider.meta.name}`, color: COLORS.textFaint, isBold: true },
                    { text: ` ${sharePercent}%`, color: PROVIDER_COLORS[id], isBold: true },
                  ]}
                />
                <Line
                  width={column}
                  segments={[
                    ...shareBarSegments(share, column, PROVIDER_COLORS[id]),
                  ]}
                />
                <SplitLine
                  width={column}
                  left={[{ text: `${formatTokens(tokens)} ${tokenLabel}`, color: COLORS.textGhost }]}
                  right={
                    sessions30d === undefined
                      ? []
                      : [{ text: `${sessions30d} ${sessionLabel}`, color: COLORS.textGhost }]
                  }
                />
                <Line
                  width={column}
                  segments={[
                    { text: "trend ", color: COLORS.textFaint },
                    {
                      text: sparkline(derived.series[id], Math.max(1, Math.min(SPARKLINE_WIDTH, column - 6))),
                      color: PROVIDER_COLORS[id],
                    },
                  ]}
                />
              </box>
            </box>
          );
        })}
      </box>
    </box>
  );
}

function DailySplit({ derived, snapshot, width }: OverviewDetailedProps) {
  const dates = snapshot.dailyDates.slice(-7);
  const dateOffset = snapshot.dailyDates.length - dates.length;
  const days = dates.map((date, index) => {
    const dayIndex = dateOffset + index;
    const label = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
      weekday: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const parts = derived.visibleIds.map((id) => ({
      value: snapshot.providers[id].series.daily[dayIndex] ?? 0,
      color: PROVIDER_COLORS[id],
    }));
    return { date, label, parts, total: formatTokens(sum(parts.map((part) => part.value))) };
  });
  // The design left-aligns totals one column after the bar.
  const totalWidth = Math.max(0, ...days.map((day) => columnWidth(day.total)));
  const barWidth = Math.max(10, width - DAY_LABEL_WIDTH - 1 - totalWidth);

  return (
    <box flexDirection="column" flexShrink={0}>
      <Line
        segments={[
          { text: "daily split", color: COLORS.textMuted, isBold: true },
          { text: " ▏ ", color: COLORS.rule },
          { text: "last 7 days, share of tokens per day", color: COLORS.textGhost },
        ]}
      />
      <Spacer />
      {days.map((day) => (
        <text key={day.date}>
          <span fg={COLORS.textFaint}>{padEnd(day.label, DAY_LABEL_WIDTH)}</span>
          {stackedBar(day.parts, barWidth).map((segment, segmentIndex) => (
            <span key={`seg-${segmentIndex}`} fg={segment.color}>
              {segment.text}
            </span>
          ))}
          <span fg={COLORS.textGhost}>{` ${day.total}`}</span>
        </text>
      ))}
      <Spacer />
      <text>
        <span>{" ".repeat(DAY_LABEL_WIDTH)}</span>
        {derived.visibleIds.map((id, index) => (
          <span key={id}>
            <span fg={PROVIDER_COLORS[id]}>{index > 0 ? "  ▀" : "▀"}</span>
            <span fg={COLORS.textGhost}>{` ${snapshot.providers[id].meta.name}`}</span>
          </span>
        ))}
      </text>
    </box>
  );
}

export function OverviewDetailed(props: OverviewDetailedProps) {
  const { state, derived, snapshot, width } = props;
  const cardWidth = columnWidthFor(width, Math.max(1, derived.visibleIds.length));
  const cardsStack = columnsStack(width, derived.visibleIds.length);

  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection={cardsStack ? "column" : "row"} flexShrink={0}>
        {derived.visibleIds.map((id, index) => (
          <box key={id} flexDirection={cardsStack ? "column" : "row"} flexShrink={0}>
            {index > 0 ? <ColumnGap isStacked={cardsStack} /> : null}
            <ProviderCard
              id={id}
              state={state}
              snapshot={snapshot}
              width={cardWidth}
              isSelected={PROVIDER_IDS[state.selection] === id}
              actions={props.actions}
            />
          </box>
        ))}
      </box>

      <Spacer />
      <Rule width={width} />
      <Spacer />
      <SummaryTrio {...props} />

      {derived.visibleIds.length > 0 ? (
        <>
          <Spacer />
          <Rule width={width} />
          <Spacer />
          <UsageShare {...props} />
        </>
      ) : null}

      {state.isDailySplitVisible && derived.visibleIds.length >= 2 ? (
        <>
          <Spacer />
          <Rule width={width} />
          <Spacer />
          <DailySplit {...props} />
        </>
      ) : null}
    </box>
  );
}
