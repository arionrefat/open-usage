import { formatDelta, formatTokens, stackedBar, sum, type TokenDelta } from "../lib/chart";
import { columnWidth, padEnd, padStart } from "../lib/text";
import { COLORS, PROVIDER_COLORS, THRESHOLDS } from "../theme";
import {
  PROVIDER_IDS,
  STATUS_PRESENTATION,
  type BurnRate,
  type ProviderId,
  type UsageSnapshot,
} from "../data/types";
import { isProviderLive, type AppState } from "../state/app-state";
import type { AppActions } from "../state/actions";
import type { DerivedState } from "../state/derive";
import { CardLimitMeter } from "../components/limit-meter";
import { Line, Rule, SplitLine, Spacer, leftClick, type Segment } from "../components/primitives";

const CARD_MAX_WIDTH = 44;
const CARD_GAP = 2;
const DAY_LABEL_WIDTH = 9;
const MIN_COLUMN_WIDTH = 20;
const SHARE_GAP = 2;
/** Fits "100%". */
const SHARE_PERCENT_WIDTH = 4;
/** Below this a share bar can no longer separate two similar shares. */
const MIN_SHARE_BAR = 12;
/**
 * A half-height block keeps consecutive bars as separate bands. Full blocks fuse
 * the rows into one filled wedge on terminals that add no line spacing.
 */
const SHARE_BAR_CHAR = "▀";
const NO_VALUE = "-";
const NO_HISTORY_NOTE = "no history";
const DELTA_ARROWS: Record<"up" | "down", string> = { up: "▲", down: "▼" };

export function dailySplitBarWidth(width: number, totalWidth: number): number {
  return Math.max(0, width - DAY_LABEL_WIDTH - 1 - totalWidth);
}

function shareFill(share: number, width: number): number {
  if (share <= 0) return 0;
  return Math.min(width, Math.max(1, Math.round((share / 100) * width)));
}

/**
 * Trailing cell for a row. A provider with no history says so; one with history
 * but no prior window to compare against leaves the column empty rather than
 * inventing a change.
 */
function deltaText(row: ShareRow): string {
  if (row.share === null) return NO_HISTORY_NOTE;
  if (!row.delta) return "";
  if (row.delta.direction === "flat") return row.delta.text;
  return `${DELTA_ARROWS[row.delta.direction]} ${row.delta.text}`;
}

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

/** Each outcome needs its own sentence; one template across all of them cannot stay grammatical. */
function burnSentence(burn: BurnRate): string {
  switch (burn.outcome.kind) {
    case "caps-out":
      return `at ${burn.rate} you cap out ${burn.outcome.at}`;
    case "clear":
      return `at ${burn.rate} you stay under the cap`;
    case "capped":
      return `at ${burn.rate}, already capped`;
    case "no-cap":
      return "no cap to project against";
  }
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
  const cardAlert = provider.limits.find((limit) => limit.alert?.isOnCard)?.alert;

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
        <box flexDirection="column" flexShrink={0}>
          {provider.limits.map((limit, index) => (
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
          ))}
          {/* Below every meter, so a card-side alert never offsets the rows beside it. */}
          {cardAlert ? (
            <Line segments={[{ text: cardAlert.text, color: cardAlert.color }]} />
          ) : null}
        </box>
      ) : (
        <DisconnectedNotice
          id={id}
          state={state}
          width={width}
          onOpenSettings={() => {
            // Land on the row the card is about, where enter now reconnects it.
            actions.selectProvider(id);
            actions.setView("settings");
          }}
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
  const worstPressure = worstId ? derived.pressure[worstId] : null;
  const bestPressure = bestId ? derived.pressure[bestId] : null;
  const worstPercent = worstPressure?.percent ?? 0;
  const bestPercent = bestPressure?.percent ?? 0;
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
              text: worstPressure
                ? `${worstPressure.label} · ${worstPressure.reset}`
                : "every provider is off or disconnected",
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
        {burn && burn.outcome.kind !== "no-cap" ? (
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
            <Line segments={[{ text: burnSentence(burn), color: COLORS.textFaint }]} />
          </>
        ) : burn ? (
          // Rate without a cap: the measurement is real, the projection is not.
          <>
            <Line segments={[{ text: burn.rate, color: COLORS.text }]} />
            <Line segments={[{ text: "no cap to project against", color: COLORS.textFaint }]} />
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
              // Names the limit that binds first, which is the one the headroom
              // is measured against. No reset here: the column cannot hold it.
              text: bestPressure
                ? `tightest: ${bestPressure.label}`
                : "to enable a provider or paste a key",
              color: COLORS.textFaint,
            },
          ]}
        />
      </box>
    </box>
  );
}

interface ShareRow {
  id: ProviderId;
  name: string;
  /** Percent of the visible total, or null with no history source to measure. */
  share: number | null;
  tokens: string;
  /**
   * Cache reads, held apart from `tokens` rather than added to it. Sources that
   * report no cache breakdown read as NO_VALUE, which is not a measured zero.
   */
  cache: string;
  /** Activity scope or session count - whichever qualifies the token figure. */
  meta: string;
  delta: TokenDelta | null;
}

function shareRows(state: AppState, derived: DerivedState, snapshot: UsageSnapshot): ShareRow[] {
  const total = derived.visibleTotal;
  return derived.visibleIds
    .map((id): ShareRow => {
      const provider = snapshot.providers[id];
      const tokens = derived.totals[id];
      // Without a history source there is no share to state, and printing 0%
      // beside a card reading 59% used would read as a contradiction.
      const hasHistory = provider.hasHistory !== false;
      const sessions = state.range === "30d" ? provider.sessions30d : undefined;
      const week = derived.weekOverWeek[id];
      const cacheRead = provider.cacheRead30d;
      return {
        id,
        name: provider.meta.name,
        share: hasHistory && total > 0 ? (tokens / total) * 100 : hasHistory ? 0 : null,
        tokens: hasHistory ? formatTokens(tokens) : NO_VALUE,
        cache: cacheRead === undefined ? NO_VALUE : formatTokens(cacheRead),
        meta: !hasHistory
          ? ""
          : provider.activityScope === "account"
            ? "account"
            : sessions === undefined
              ? ""
              : `${sessions} ${sessions === 1 ? "session" : "sessions"}`,
        delta: hasHistory ? formatDelta(week?.recent ?? 0, week ? week.prior : null) : null,
      };
    })
    .sort((left, right) => (right.share ?? -1) - (left.share ?? -1));
}

/**
 * Widths for one aligned row. The bar keeps whatever the labelled columns do
 * not need, and the three qualifying columns drop out before the bar is squeezed
 * below the point where two shares can still be told apart.
 *
 * They give way in the order meta, cache, delta. Delta goes last because it
 * carries the "no history" note that explains an unmeasured row; cache outranks
 * the session count because a provider's cache volume can dwarf everything else
 * on the row and is the only place that number is stated.
 */
function shareLayout(rows: ShareRow[], width: number) {
  const nameWidth = Math.max(0, ...rows.map((row) => columnWidth(row.name)));
  const tokensWidth = Math.max(0, ...rows.map((row) => columnWidth(row.tokens)));
  const metaWidth = Math.max(0, ...rows.map((row) => columnWidth(row.meta)));
  const deltaWidth = Math.max(0, ...rows.map((row) => columnWidth(deltaText(row))));
  // A column of nothing but dashes states nothing, so it has to earn its place
  // on at least one provider actually reporting cache reads.
  const cacheWidth = rows.some((row) => row.cache !== NO_VALUE)
    ? Math.max(0, ...rows.map((row) => columnWidth(row.cache)))
    : 0;

  // Three gaps sit in the always-present run: after the name, the bar, and the percent.
  const fixed = nameWidth + tokensWidth + SHARE_PERCENT_WIDTH + SHARE_GAP * 3;
  let barWidth = width - fixed;
  const hasDelta = deltaWidth > 0 && barWidth - deltaWidth - SHARE_GAP >= MIN_SHARE_BAR;
  if (hasDelta) barWidth -= deltaWidth + SHARE_GAP;
  const hasCache = cacheWidth > 0 && barWidth - cacheWidth - SHARE_GAP >= MIN_SHARE_BAR;
  if (hasCache) barWidth -= cacheWidth + SHARE_GAP;
  const hasMeta = metaWidth > 0 && barWidth - metaWidth - SHARE_GAP >= MIN_SHARE_BAR;
  if (hasMeta) barWidth -= metaWidth + SHARE_GAP;

  return {
    nameWidth,
    tokensWidth,
    cacheWidth: hasCache ? cacheWidth : 0,
    metaWidth: hasMeta ? metaWidth : 0,
    deltaWidth: hasDelta ? deltaWidth : 0,
    barWidth: Math.max(1, barWidth),
  };
}

interface ShareRowLineProps {
  row: ShareRow;
  layout: ReturnType<typeof shareLayout>;
  width: number;
}

function ShareRowLine({ row, layout, width }: ShareRowLineProps) {
  const color = PROVIDER_COLORS[row.id];
  const gap = { text: " ".repeat(SHARE_GAP) };
  // A dotted lane says the provider is tracked but unmeasured. Real bars get no
  // track behind them, so a share never reads as progress toward a cap - that is
  // what the limit meters above mean, and these are slices of a total.
  const bar: Segment[] = row.share === null
    ? [{ text: "·".repeat(layout.barWidth), color: COLORS.textInert }]
    : [{ text: SHARE_BAR_CHAR.repeat(shareFill(row.share, layout.barWidth)), color }];

  return (
    <Line
      width={width}
      segments={[
        { text: padEnd(row.name, layout.nameWidth), color: COLORS.textFaint, isBold: true },
        gap,
        {
          text: padStart(row.share === null ? NO_VALUE : `${Math.round(row.share)}%`, SHARE_PERCENT_WIDTH),
          color: row.share === null ? COLORS.textDisabled : color,
          isBold: row.share !== null,
        },
        gap,
        { text: padStart(row.tokens, layout.tokensWidth), color: COLORS.textGhost },
        ...(layout.cacheWidth > 0
          ? [gap, { text: padStart(row.cache, layout.cacheWidth), color: COLORS.textDisabled }]
          : []),
        ...(layout.metaWidth > 0
          ? [gap, { text: padEnd(row.meta, layout.metaWidth), color: COLORS.textGhost }]
          : []),
        ...(layout.deltaWidth > 0
          ? [gap, { text: padStart(deltaText(row), layout.deltaWidth), color: COLORS.textGhost }]
          : []),
        gap,
        // The bar trails the figures so it can run ragged into open space rather
        // than stranding the numbers at the far edge, away from the bar they label.
        ...bar,
      ]}
    />
  );
}

function UsageShare({ state, derived, snapshot, width }: OverviewDetailedProps) {
  const rows = shareRows(state, derived, snapshot);
  const layout = shareLayout(rows, width);

  return (
    <box flexDirection="column" flexShrink={0}>
      <SplitLine
        width={width}
        left={[
          { text: "usage share", color: COLORS.textMuted, isBold: true },
          { text: " ▏ ", color: COLORS.rule },
          { text: derived.rangeName, color: COLORS.textGhost },
          // The arrows read a fixed window, so they need saying once here.
          ...(layout.deltaWidth > 0
            ? ([
                { text: " ▏ ", color: COLORS.rule },
                { text: "▲▼ 7d change", color: COLORS.textDisabled },
              ] satisfies Segment[])
            : []),
          // The leading + says the column adds to the token figure beside it
          // rather than being a slice of it, which is what the share means. The
          // period is named because the sources only carry a 30-day cache total,
          // so the column holds still while the range beside it cycles.
          ...(layout.cacheWidth > 0
            ? ([
                { text: " ▏ ", color: COLORS.rule },
                { text: "+ 30d cache read", color: COLORS.textDisabled },
              ] satisfies Segment[])
            : []),
        ]}
        right={[{ text: `${formatTokens(derived.visibleTotal)} total`, color: COLORS.textGhost }]}
      />
      <Spacer />
      {rows.map((row) => (
        <ShareRowLine key={row.id} row={row} layout={layout} width={width} />
      ))}
    </box>
  );
}

function DailySplit({ derived, snapshot, width }: OverviewDetailedProps) {
  const dates = snapshot.dailyDates.slice(-7);
  const dateOffset = snapshot.dailyDates.length - dates.length;
  // Newest day first: today is the row you read without scanning down.
  const days = dates
    .map((date, index) => {
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
    })
    .reverse();
  // The design left-aligns totals one column after the bar.
  const totalWidth = Math.max(0, ...days.map((day) => columnWidth(day.total)));
  const barWidth = dailySplitBarWidth(width, totalWidth);

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
