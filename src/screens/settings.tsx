import { COLOR_MODE_LABEL, POLL_INTERVAL_SECONDS } from "../config";
import { padEnd } from "../lib/text";
import { COLORS, PROVIDER_COLORS, THRESHOLDS } from "../theme";
import { PROVIDER_IDS, STATUS_PRESENTATION, type ProviderId, type UsageSnapshot } from "../data/types";
import type { AppState, OverviewMode } from "../state/app-state";
import type { AppActions } from "../state/actions";
import { Line, Rule, SplitLine, Spacer, keyHint, leftClick, type Segment } from "../components/primitives";
import { toggleSegments } from "../components/toggle";
import { MODE_OPTIONS } from "./overview";

const LABEL_COLUMN = 14;
const SETTING_LABEL_COLUMN = 22;
const STATUS_COLUMN = 24;

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
            onClick: () => actions.settingsCycleStatus(id),
          },
        ]}
      />
      <SplitLine
        width={width}
        background={background}
        left={[
          { text: "   " },
          { text: padEnd("credential", LABEL_COLUMN), color: COLORS.textFaint },
          {
            text: connection.credential || "- none stored -",
            color: connection.credential ? COLORS.textMuted : COLORS.textFaint,
            onClick: () => actions.settingsPasteKey(id),
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
    <Line
      segments={[
        { text: padEnd(label, SETTING_LABEL_COLUMN), color: COLORS.textFaint },
        { text: value, color: COLORS.text },
        ...(hint ? [{ text: `  ${hint}`, color: COLORS.textGhost }] : []),
      ]}
    />
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
          { text: "providers, credentials, subscriptions", color: COLORS.textFaint },
        ]}
        right={[{ text: "~/.config/limitless/config.json", color: COLORS.textGhost }]}
      />
      <Spacer />
      <SplitLine
        width={width}
        left={[{ text: "providers", color: COLORS.textDim }]}
        right={[
          ...keyHint("space", "show / hide", () => actions.settingsToggle(selectedId)),
          { text: "  " },
          ...keyHint("↵", "cycle status", () => actions.settingsCycleStatus(selectedId)),
          { text: "  " },
          ...keyHint("p", "paste key", () => actions.settingsPasteKey(selectedId)),
          { text: "  " },
          ...keyHint("d", "disconnect", () => actions.settingsDisconnect(selectedId)),
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
      <SettingLine label="poll interval" value={`${POLL_INTERVAL_SECONDS}s`} hint="r forces a refresh" />
      <SettingLine
        label="warn threshold"
        value={`${THRESHOLDS.danger}%`}
        hint="bars turn red past this"
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
