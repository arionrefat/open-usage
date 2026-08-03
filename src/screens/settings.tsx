import { COLOR_MODE_LABEL, POLL_INTERVAL_OPTIONS, WARN_THRESHOLD_OPTIONS } from "../config";
import { padEnd } from "../lib/text";
import { COLORS, PROVIDER_COLORS } from "../theme";
import { PROVIDER_IDS, STATUS_PRESENTATION, type ProviderId, type UsageSnapshot } from "../data/types";
import type { AppState, OverviewMode } from "../state/app-state";
import type { AppActions } from "../state/actions";
import { Line, Rule, SplitLine, Spacer, keyHint, leftClick, type Segment } from "../components/primitives";
import { toggleSegments, type ToggleOption } from "../components/toggle";
import { MODE_OPTIONS } from "./overview";

const LABEL_COLUMN = 14;
const SETTING_LABEL_COLUMN = 22;
const STATUS_COLUMN = 24;
const POLL_OPTIONS: ToggleOption<number>[] = POLL_INTERVAL_OPTIONS.map((value) => ({
  label: `${value}m`,
  value,
}));
const WARN_OPTIONS: ToggleOption<number>[] = WARN_THRESHOLD_OPTIONS.map((value) => ({
  label: `${value}%`,
  value,
}));

interface SettingsProps {
  state: AppState;
  snapshot: UsageSnapshot;
  width: number;
  actions: AppActions;
}

function ProviderRow({
  id,
  state,
  snapshot,
  width,
  actions,
}: SettingsProps & { id: ProviderId }) {
  const connection = state.connections[id];
  const meta = snapshot.providers[id].meta;
  const status = STATUS_PRESENTATION[connection.status];
  const isSelected = PROVIDER_IDS[state.settingsCursor] === id;
  const background = isSelected ? COLORS.bgRowActive : undefined;

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={background}
      onMouseDown={leftClick(() => actions.selectProvider(id))}
    >
      <SplitLine
        width={width}
        background={background}
        left={[
          { text: isSelected ? "▶ " : "  ", color: COLORS.textGhost },
          { text: "▎", color: PROVIDER_COLORS[id] },
          {
            text: meta.name,
            color: connection.isEnabled ? COLORS.textBright : COLORS.textDim,
            isBold: true,
          },
          { text: " ▏ ", color: COLORS.rule },
          { text: meta.plan, color: COLORS.textFaint },
        ]}
        right={[
          {
            text: connection.isEnabled ? "[×] enabled" : "[ ] hidden",
            color: connection.isEnabled ? COLORS.text : COLORS.textFaint,
            onClick: () => actions.settingsToggle(id),
          },
          { text: "   " },
          {
            text: padEnd(`${status.dot} ${status.label}`, STATUS_COLUMN),
            color: connection.isEnabled ? status.color : COLORS.textFaint,
          },
        ]}
      />
      <SplitLine
        width={width}
        background={background}
        left={[
          { text: "   " },
          { text: padEnd("connection", LABEL_COLUMN), color: COLORS.textFaint },
          {
            text: connection.credential || "- none stored -",
            color: connection.credential ? COLORS.textMuted : COLORS.textFaint,
          },
        ]}
        right={[{ text: connection.note, color: COLORS.textGhost }]}
      />
      <Line
        background={background}
        segments={[
          { text: "   " },
          { text: padEnd("reads from", LABEL_COLUMN), color: COLORS.textFaint },
          { text: meta.source, color: COLORS.textDim },
        ]}
      />
      <Rule width={width} color={COLORS.borderSoft} />
    </box>
  );
}

function modeToggleSegments(mode: OverviewMode, actions: AppActions): Segment[] {
  return toggleSegments(MODE_OPTIONS, mode, (value) => actions.setMode(value));
}

function SettingLine({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <Line
        segments={[
          { text: padEnd(label, SETTING_LABEL_COLUMN), color: COLORS.textFaint },
          { text: value, color: COLORS.text },
        ]}
      />
      {hint ? (
        <Line segments={[
          { text: " ".repeat(SETTING_LABEL_COLUMN), color: COLORS.textGhost },
          { text: hint, color: COLORS.textMuted },
        ]} />
      ) : null}
    </box>
  );
}

function SettingOptions<T>({
  label,
  options,
  current,
  onSelect,
  hint,
}: {
  label: string;
  options: ToggleOption<T>[];
  current: T;
  onSelect: (value: T) => void;
  hint: Segment[];
}) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <Line segments={[
        { text: padEnd(label, SETTING_LABEL_COLUMN), color: COLORS.textFaint },
        ...toggleSegments(options, current, onSelect),
      ]} />
      <Line segments={[
        { text: " ".repeat(SETTING_LABEL_COLUMN), color: COLORS.textGhost },
        ...hint,
      ]} />
    </box>
  );
}

export function Settings(props: SettingsProps) {
  const { state, width, actions } = props;
  const selectedId = PROVIDER_IDS[state.settingsCursor]!;

  return (
    <box flexDirection="column" flexShrink={0}>
      <SplitLine
        width={width}
        left={[
          { text: "settings", color: COLORS.textBright, isBold: true },
          { text: " ▏ ", color: COLORS.rule },
          { text: "providers, connections, refresh", color: COLORS.textFaint },
        ]}
        right={[{ text: "~/.config/limitless/preferences.json", color: COLORS.textGhost }]}
      />
      <Spacer />
      <SplitLine
        width={width}
        left={[{ text: "providers", color: COLORS.textDim }]}
        right={[
          ...keyHint("space", "show / hide", () => actions.settingsToggle(selectedId)),
        ]}
      />
      <Rule width={width} />

      {PROVIDER_IDS.map((id) => (
        <ProviderRow key={id} id={id} {...props} />
      ))}

      <Spacer />
      <Line segments={[{ text: "display", color: COLORS.textDim }]} />
      <Rule width={width} />
      <Line
        segments={[
          { text: padEnd("default overview mode", SETTING_LABEL_COLUMN), color: COLORS.textFaint },
          ...modeToggleSegments(state.mode, actions),
        ]}
      />
      <SettingOptions
        label="poll interval"
        options={POLL_OPTIONS}
        current={state.pollIntervalMinutes}
        onSelect={actions.setPollInterval}
        hint={[
          { text: "[p]", color: COLORS.info, isBold: true },
          { text: " cycle options  ·  ", color: COLORS.textMuted },
          { text: "[r]", color: COLORS.info, isBold: true },
          { text: " force a refresh", color: COLORS.textMuted },
        ]}
      />
      <SettingOptions
        label="alert threshold"
        options={WARN_OPTIONS}
        current={state.warnThreshold}
        onSelect={actions.setWarnThreshold}
        hint={[
          { text: "[w]", color: COLORS.info, isBold: true },
          { text: " cycle options  ·  red at this level", color: COLORS.textMuted },
        ]}
      />
      <SettingLine
        label="colors"
        value={state.useSeverityColors ? "severity only" : COLOR_MODE_LABEL}
        hint={state.useSeverityColors ? "per-provider brand available" : "severity-only available"}
      />

      <Spacer />
      <Rule width={width} />
      <Line segments={keyHint("o", "re-run the setup wizard", () => actions.openOnboarding())} />
    </box>
  );
}
