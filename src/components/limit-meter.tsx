import type { UsageLimit } from "../data/types";
import { buildMeter, emptyMeter } from "../lib/meter";
import { padStart } from "../lib/text";
import { COLORS } from "../theme";
import { Line, SplitLine, type Segment } from "./primitives";

interface LimitMeterProps {
  limit: UsageLimit;
  width: number;
  accentColor: string;
  useSeverityColors: boolean;
}

function meterFor(limit: UsageLimit, width: number, accentColor: string, useSeverityColors: boolean) {
  return limit.percent === null
    ? emptyMeter(width)
    : buildMeter(limit.percent, width, accentColor, useSeverityColors);
}

function barSegments(meter: ReturnType<typeof buildMeter>): Segment[] {
  return [
    { text: meter.fill, color: meter.color },
    { text: meter.track, color: COLORS.track },
  ];
}

/** Compact meter used on the overview cards: label, bar, reset caption. */
export function CardLimitMeter({ limit, width, accentColor, useSeverityColors }: LimitMeterProps) {
  const meter = meterFor(limit, width, accentColor, useSeverityColors);
  const value = limit.valueLabel ?? meter.percentLabel;
  const valueColor = limit.valueColor ?? meter.percentColor;

  return (
    <box flexDirection="column" flexShrink={0}>
      <SplitLine
        width={width}
        left={[{ text: limit.label, color: COLORS.textMuted }]}
        right={[{ text: value, color: valueColor }]}
      />
      <Line segments={barSegments(meter)} />
      <Line
        segments={[
          { text: limit.footnote ?? limit.resetLong ?? limit.reset, color: COLORS.textGhost },
        ]}
      />
    </box>
  );
}

/** Design widths: 12ch fits "NN% used", custom readouts get 14ch. */
const DETAIL_PERCENT_COLUMN = 12;
const DETAIL_CUSTOM_COLUMN = 14;

/** Full-width meter used on a provider's own screen. */
export function DetailLimitMeter({ limit, width, accentColor, useSeverityColors }: LimitMeterProps) {
  const meter = meterFor(limit, width, accentColor, useSeverityColors);
  const hasCustomValue = limit.detailValueLabel !== undefined || limit.percent === null;
  const valueColumn = hasCustomValue ? DETAIL_CUSTOM_COLUMN : DETAIL_PERCENT_COLUMN;
  const value =
    limit.detailValueLabel ??
    (limit.percent === null ? (limit.valueLabel ?? "—") : `${meter.percentLabel} used`);
  const valueColor = limit.valueColor ?? meter.percentColor;

  return (
    <box flexDirection="column" flexShrink={0}>
      <SplitLine
        width={width}
        left={[{ text: limit.detailLabel ?? limit.label, color: COLORS.text }]}
        right={[
          { text: limit.reset, color: COLORS.textFaint },
          { text: padStart(value, valueColumn), color: valueColor },
        ]}
      />
      <Line segments={barSegments(meter)} />
      {limit.alert ? <Line segments={[{ text: limit.alert.text, color: limit.alert.color }]} /> : null}
    </box>
  );
}
