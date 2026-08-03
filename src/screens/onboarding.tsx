import { APP_NAME } from "../config";
import { padEnd } from "../lib/text";
import { COLORS, PROVIDER_COLORS } from "../theme";
import { PROVIDER_IDS, STATUS_PRESENTATION, type ProviderId, type UsageSnapshot } from "../data/types";
import { isProviderLive, type AppState } from "../state/app-state";
import type { AppActions } from "../state/actions";
import { KeyLegend } from "../components/chrome";
import { Line, Rule, SplitLine, Spacer } from "../components/primitives";

const NAME_COLUMN = 20;
const STATUS_COLUMN = 24;

interface OnboardingProps {
  state: AppState;
  snapshot: UsageSnapshot;
  width: number;
  actions: AppActions;
}

function pickedProviders(state: AppState): ProviderId[] {
  return PROVIDER_IDS.filter((id) => state.onboarding.picks[id]);
}

function PickStep({ state, snapshot, width, actions }: OnboardingProps) {
  const picked = pickedProviders(state);

  return (
    <box flexDirection="column" flexShrink={0}>
      <Line
        segments={[
          { text: "which providers do you want to track?", color: COLORS.textBright, isBold: true },
        ]}
      />
      <Line
        segments={[
          {
            text: "pick the ones you pay for - you can change this later in settings",
            color: COLORS.textFaint,
          },
        ]}
      />
      <Spacer />
      {PROVIDER_IDS.map((id, index) => {
        const isSelected = state.onboarding.cursor === index;
        const isPicked = state.onboarding.picks[id];
        const background = isSelected ? COLORS.bgRowActive : undefined;
        const pick = () => actions.onboardingPick(index);
        return (
          <SplitLine
            key={id}
            width={width}
            background={background}
            left={[
              { text: isSelected ? "▶ " : "  ", color: COLORS.textSoft, background, onClick: pick },
              {
                text: isPicked ? "[×]" : "[ ]",
                color: isPicked ? PROVIDER_COLORS[id] : COLORS.textDisabled,
                background,
                isBold: true,
                onClick: pick,
              },
              {
                text: `  ${padEnd(snapshot.providers[id].meta.name, NAME_COLUMN)}`,
                color: isSelected ? COLORS.textBright : isPicked ? COLORS.text : COLORS.textDim,
                background,
                isBold: true,
                onClick: pick,
              },
              {
                text: snapshot.providers[id].meta.requirement,
                color: COLORS.textFaint,
                background,
                onClick: pick,
              },
            ]}
          />
        );
      })}
      <Spacer />
      <Line segments={[{ text: `${picked.length} of 3 selected`, color: COLORS.textDim }]} />
      <Spacer />
      <Rule width={width} />
      <KeyLegend
        width={width}
        hints={[
          ["j/k", "move"],
          ["space", "toggle"],
          ["a", "select all"],
          ["esc", "cancel"],
        ]}
        right={[
          {
            text: " ↵ continue ",
            color: COLORS.bg,
            background: COLORS.accent,
            isBold: true,
            onClick: () => actions.onboardingContinue(),
          },
        ]}
      />
    </box>
  );
}

function SummaryStep({ state, snapshot, width, actions }: OnboardingProps) {
  const connectedCount = PROVIDER_IDS.filter((id) => isProviderLive(state.connections[id])).length;

  return (
    <box flexDirection="column" flexShrink={0}>
      <Line
        segments={[
          { text: "✓ ", color: COLORS.ok, isBold: true },
          {
            text: `${connectedCount} provider(s) connected`,
            color: COLORS.textBright,
            isBold: true,
          },
        ]}
      />
      <Line
        segments={[
          {
            text: "skipped or expired providers stay listed in settings - nothing is lost",
            color: COLORS.textFaint,
          },
        ]}
      />
      <Spacer />
      {PROVIDER_IDS.map((id) => {
        const connection = state.connections[id];
        const status = STATUS_PRESENTATION[connection.status];
        const statusLabel = connection.isEnabled ? status.label : "hidden";
        const statusColor = connection.isEnabled ? status.color : COLORS.textFaint;
        return (
          <Line
            key={id}
            width={width}
            segments={[
              { text: padEnd(connection.isEnabled ? status.dot : "○", 3), color: statusColor },
              { text: padEnd(snapshot.providers[id].meta.name, NAME_COLUMN), color: COLORS.text },
              { text: padEnd(statusLabel, STATUS_COLUMN), color: statusColor },
              { text: connection.credential || "-", color: COLORS.textFaint },
            ]}
          />
        );
      })}
      <Spacer />
      <Line
        segments={[
          {
            text: "provider logins stay in their own CLIs; Limitless never asks for tokens",
            color: COLORS.textGhost,
          },
        ]}
      />
      <Spacer />
      <Rule width={width} />
      <SplitLine
        width={width}
        left={[
          {
            text: "selected providers are detected automatically",
            color: COLORS.textGhost,
          },
        ]}
        right={[
          {
            text: " ↵ open limits ",
            color: COLORS.bg,
            background: COLORS.accent,
            isBold: true,
            onClick: () => actions.onboardingFinish(),
          },
        ]}
      />
    </box>
  );
}

const ONBOARDING_PADDING = 4;

export function Onboarding(props: OnboardingProps) {
  const { state } = props;
  const padding = props.width >= 32 ? ONBOARDING_PADDING : 1;
  const width = Math.max(1, props.width - padding * 2 - 1);

  return (
    <scrollbox
      flexGrow={1}
      scrollX={false}
      contentOptions={{ flexDirection: "column" }}
      paddingLeft={padding}
      paddingRight={padding}
      paddingTop={1}
    >
      <SplitLine
        width={width}
        left={[
          { text: APP_NAME, color: COLORS.textBright, isBold: true },
          { text: " ▏ ", color: COLORS.rule },
          { text: "first run", color: COLORS.textFaint },
        ]}
        right={[{ text: `step ${state.onboarding.step + 1} of 2`, color: COLORS.textGhost }]}
      />
      <Spacer />
      {state.onboarding.step === 0 ? <PickStep {...props} width={width} /> : null}
      {state.onboarding.step === 1 ? <SummaryStep {...props} width={width} /> : null}
    </scrollbox>
  );
}
