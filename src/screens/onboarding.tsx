import { POLL_INTERVAL_SECONDS } from "../config";
import { padEnd } from "../lib/text";
import { COLORS, PROVIDER_COLORS } from "../theme";
import { PROVIDER_IDS, STATUS_PRESENTATION, type ProviderId, type UsageSnapshot } from "../data/types";
import type { AppState } from "../state/app-state";
import type { AppActions } from "../state/actions";
import { KeyLegend } from "../components/chrome";
import { Line, Rule, SplitLine, Spacer } from "../components/primitives";

const NAME_COLUMN = 20;
const STATUS_COLUMN = 24;
const CREDENTIAL_FIELD_WIDTH = 70;

interface OnboardingProps {
  state: AppState;
  snapshot: UsageSnapshot;
  width: number;
  isCursorVisible: boolean;
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
            text: "pick the ones you pay for — you can change this later in settings",
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

function AuthStep({ state, snapshot, width, isCursorVisible }: OnboardingProps) {
  const picked = pickedProviders(state);
  const currentId = picked[Math.min(state.onboarding.index, Math.max(0, picked.length - 1))] ?? "cl";
  const meta = snapshot.providers[currentId].meta;
  const fieldWidth = Math.min(CREDENTIAL_FIELD_WIDTH, width);

  return (
    <box flexDirection="column" flexShrink={0}>
      <SplitLine
        width={width}
        left={[
          { text: "▎", color: PROVIDER_COLORS[currentId] },
          { text: `connect ${meta.name}`, color: COLORS.textBright, isBold: true },
        ]}
        right={[
          { text: `${state.onboarding.index + 1} / ${picked.length}`, color: COLORS.textGhost },
        ]}
      />
      <Line segments={[{ text: `needs ${meta.requirement}`, color: COLORS.textFaint }]} />
      <Spacer />
      <Line segments={[{ text: "paste credential", color: COLORS.textDim }]} />
      <box
        flexShrink={0}
        width={fieldWidth}
        border
        borderColor={COLORS.borderChip}
        backgroundColor={COLORS.bgInput}
        paddingLeft={1}
        paddingRight={1}
      >
        <Line
          background={COLORS.bgInput}
          segments={[
            { text: "▸ ", color: PROVIDER_COLORS[currentId], background: COLORS.bgInput },
            { text: state.onboarding.typed, color: COLORS.text, background: COLORS.bgInput },
            { text: isCursorVisible ? "█" : " ", color: COLORS.text, background: COLORS.bgInput },
          ]}
        />
      </box>
      <Line
        segments={[
          {
            text: "stored in your OS keychain — never written to the config file",
            color: COLORS.textGhost,
          },
        ]}
      />
      <Line segments={[{ text: `will read from ${meta.source}`, color: COLORS.textGhost }]} />
      <Spacer />
      <Rule width={width} />
      <KeyLegend
        width={width}
        hints={[
          ["↵", "save and continue"],
          ["esc", "skip this provider"],
        ]}
      />
    </box>
  );
}

function SummaryStep({ state, snapshot, width, actions }: OnboardingProps) {
  const connectedCount = PROVIDER_IDS.filter((id) => state.connections[id].status === "active").length;

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
            text: "skipped or expired providers stay listed in settings — nothing is lost",
            color: COLORS.textFaint,
          },
        ]}
      />
      <Spacer />
      {PROVIDER_IDS.map((id) => {
        const status = STATUS_PRESENTATION[state.connections[id].status];
        return (
          <Line
            key={id}
            segments={[
              { text: padEnd(status.dot, 3), color: status.color },
              { text: padEnd(snapshot.providers[id].meta.name, NAME_COLUMN), color: COLORS.text },
              { text: padEnd(status.label, STATUS_COLUMN), color: status.color },
              { text: state.connections[id].credential || "—", color: COLORS.textFaint },
            ]}
          />
        );
      })}
      <Spacer />
      <Rule width={width} />
      <SplitLine
        width={width}
        left={[
          {
            text: `polling starts immediately · ${POLL_INTERVAL_SECONDS}s interval`,
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
  const width = Math.max(20, props.width - ONBOARDING_PADDING * 2);

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={ONBOARDING_PADDING}
      paddingRight={ONBOARDING_PADDING}
      paddingTop={1}
    >
      <SplitLine
        width={width}
        left={[
          { text: "limits", color: COLORS.textBright, isBold: true },
          { text: " ▏ ", color: COLORS.rule },
          { text: "first run", color: COLORS.textFaint },
        ]}
        right={[{ text: `step ${state.onboarding.step + 1} of 3`, color: COLORS.textGhost }]}
      />
      <Spacer />
      {state.onboarding.step === 0 ? <PickStep {...props} width={width} /> : null}
      {state.onboarding.step === 1 ? <AuthStep {...props} width={width} /> : null}
      {state.onboarding.step === 2 ? <SummaryStep {...props} width={width} /> : null}
    </box>
  );
}
