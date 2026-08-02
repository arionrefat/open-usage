import { bars, formatTokens } from "../lib/chart";
import { COLORS, PROVIDER_COLORS } from "../theme";
import { STATUS_PRESENTATION, type ProviderId, type ProviderNotice, type UsageSnapshot } from "../data/types";
import { isProviderLive, type AppState } from "../state/app-state";
import type { DerivedState } from "../state/derive";
import { DetailLimitMeter } from "../components/limit-meter";
import { Chart, Line, Rule, SplitLine, Spacer, TripleLine, type Segment } from "../components/primitives";

/** The design plots 8 chart rows; shorter terminals fall back to the clamp. */

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
      <Line segments={[{ text: `tokens ${derived.rangeName}`, color: COLORS.textMuted, isBold: true }]} />
      <Spacer />
      <Chart rows={bars(series, width, chartHeight, PROVIDER_COLORS[id])} />
      <Rule width={width} />
      <TripleLine
        width={width}
        left={[{ text: derived.axis[0], color: COLORS.textGhost }]}
        center={[{ text: `peak ${formatTokens(Math.max(0, ...series))}`, color: COLORS.textGhost }]}
        right={[{ text: derived.axis[2], color: COLORS.textGhost }]}
      />

      {provider.detailFooter ? (
        <>
          <Spacer />
          <Line width={width} segments={footerSegments(provider.detailFooter)} />
        </>
      ) : null}
    </box>
  );
}
