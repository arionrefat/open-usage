import { formatTokens, sparkline, stackedBar, sum } from "../lib/chart";
import { padEnd, padStart } from "../lib/text";
import { COLORS, PROVIDER_COLORS } from "../theme";
import { PROVIDER_IDS, STATUS_PRESENTATION, type ProviderId, type UsageSnapshot } from "../data/types";
import { isProviderLive, type AppState } from "../state/app-state";
import type { AppActions } from "../state/actions";
import type { DerivedState } from "../state/derive";
import { CardLimitMeter } from "../components/limit-meter";
import { Line, Rule, SplitLine, Spacer, leftClick } from "../components/primitives";

const CARD_MAX_WIDTH = 44;
const CARD_GAP = 2;
const DAY_LABEL_WIDTH = 9;
const DAY_TOTAL_WIDTH = 8;
const SESSION_TOKENS_PER_SESSION = 22;

interface OverviewDetailedProps {
  state: AppState;
  derived: DerivedState;
  snapshot: UsageSnapshot;
  width: number;
  actions: AppActions;
}

function columnWidthFor(width: number, count: number): number {
  if (count <= 0) return width;
  return Math.max(20, Math.min(CARD_MAX_WIDTH, Math.floor((width - CARD_GAP * (count - 1)) / count)));
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
          { text: "no limits to read — ", color: COLORS.textGhost, onClick: onOpenSettings },
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
  const worstId = derived.worstId;
  const bestId = derived.bestId;
  const worstPercent = worstId ? (snapshot.providers[worstId].scopes[state.scope].percent ?? 0) : 0;
  const bestPercent = bestId ? (snapshot.providers[bestId].scopes[state.scope].percent ?? 0) : 0;
  const burn = worstId ? snapshot.providers[worstId].burn : null;
  const isOverBudget = burn !== null && burn.projectedPercent > 100;

  return (
    <box flexDirection="row" flexShrink={0}>
      <box flexDirection="column" flexShrink={0} width={column}>
        <Line
          segments={[
            {
              text: "▲ closest to running out",
              color: worstPercent >= 85 ? COLORS.danger : worstPercent >= 70 ? COLORS.warn : COLORS.textGhost,
              isBold: true,
            },
          ]}
        />
        <Line
          segments={[
            {
              text: worstId ? `${snapshot.providers[worstId].meta.name} ${worstPercent}%` : "nothing is being tracked",
              color: COLORS.text,
            },
          ]}
        />
        <Line
          segments={[
            {
              text: burn ? `${burn.limit} · ${burn.timeToReset}` : "every provider is off or disconnected",
              color: COLORS.textFaint,
            },
          ]}
        />
      </box>
      <box width={CARD_GAP} flexShrink={0} />
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
      <box width={CARD_GAP} flexShrink={0} />
      <box flexDirection="column" flexShrink={0} width={column}>
        <Line
          segments={[
            { text: "→ route here now", color: bestId ? COLORS.ok : COLORS.textFaint, isBold: true },
          ]}
        />
        <Line
          segments={[
            {
              text: bestId ? `${snapshot.providers[bestId].meta.name} ${100 - bestPercent}% free` : "open settings",
              color: COLORS.text,
            },
          ]}
        />
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

function UsageShare({ derived, snapshot, width }: OverviewDetailedProps) {
  const column = columnWidthFor(width, Math.max(1, derived.visibleIds.length));
  const total = derived.visibleTotal || 1;

  return (
    <box flexDirection="column" flexShrink={0}>
      <Line
        segments={[
          { text: "usage share", color: COLORS.textMuted, isBold: true },
          { text: " ▏ ", color: COLORS.rule },
          { text: `${derived.rangeName} · tokens`, color: COLORS.textGhost },
        ]}
      />
      <Spacer />
      <box flexDirection="row" flexShrink={0}>
        {derived.visibleIds.map((id, index) => {
          const tokens = derived.totals[id];
          return (
            <box key={id} flexDirection="row" flexShrink={0}>
              {index > 0 ? <box width={CARD_GAP} flexShrink={0} /> : null}
              <box flexDirection="column" flexShrink={0} width={column}>
                <Line
                  segments={[
                    { text: `${Math.round((tokens / total) * 100)}%`, color: PROVIDER_COLORS[id], isBold: true },
                    { text: `  ${snapshot.providers[id].meta.name}`, color: COLORS.textFaint },
                  ]}
                />
                <Line segments={[{ text: sparkline(derived.series[id], column), color: PROVIDER_COLORS[id] }]} />
                <Line
                  segments={[
                    { text: `${formatTokens(tokens)} tokens`, color: COLORS.textGhost },
                    { text: " · ", color: COLORS.rule },
                    {
                      text: `${Math.max(1, Math.round(tokens / SESSION_TOKENS_PER_SESSION))} sessions`,
                      color: COLORS.textGhost,
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
  const barWidth = Math.max(10, width - DAY_LABEL_WIDTH - DAY_TOTAL_WIDTH);

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
      {snapshot.dayLabels.map((label, index) => {
        const dayIndex = snapshot.dayLabelOffset + index;
        const parts = derived.visibleIds.map((id) => ({
          value: snapshot.providers[id].series.daily[dayIndex] ?? 0,
          color: PROVIDER_COLORS[id],
        }));
        const dayTotal = sum(parts.map((part) => part.value));
        return (
          <text key={label}>
            <span fg={COLORS.textFaint}>{padEnd(label, DAY_LABEL_WIDTH)}</span>
            {stackedBar(parts, barWidth).map((segment, segmentIndex) => (
              <span key={`seg-${segmentIndex}`} fg={segment.color}>
                {segment.text}
              </span>
            ))}
            <span fg={COLORS.textGhost}>{padStart(formatTokens(dayTotal), DAY_TOTAL_WIDTH)}</span>
          </text>
        );
      })}
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

  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" flexShrink={0}>
        {derived.visibleIds.map((id, index) => (
          <box key={id} flexDirection="row" flexShrink={0}>
            {index > 0 ? <box width={CARD_GAP} flexShrink={0} /> : null}
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
