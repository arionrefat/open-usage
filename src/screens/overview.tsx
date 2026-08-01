import { COLORS } from "../theme";
import type { UsageSnapshot } from "../data/types";
import type { AppState, OverviewMode } from "../state/app-state";
import type { AppActions } from "../state/actions";
import type { DerivedState } from "../state/derive";
import { SplitLine, Spacer, type Segment } from "../components/primitives";
import { toggleChip, toggleSegments, type ToggleOption } from "../components/toggle";
import { OverviewDetailed } from "./overview-detailed";
import { OverviewSimple } from "./overview-simple";

interface OverviewProps {
  state: AppState;
  derived: DerivedState;
  snapshot: UsageSnapshot;
  width: number;
  scopeTitle: string;
  actions: AppActions;
}

export const MODE_OPTIONS: ToggleOption<OverviewMode>[] = [
  { label: "simplified", value: "simple" },
  { label: "detailed", value: "detailed" },
];

function modeToggleSegments(mode: OverviewMode, actions: AppActions): Segment[] {
  return [
    ...toggleSegments(MODE_OPTIONS, mode, COLORS.accent, (value) => actions.setMode(value)),
    ...toggleChip("m", () => actions.toggleMode()),
  ];
}

export function Overview(props: OverviewProps) {
  const { state, width, actions } = props;

  return (
    <box flexDirection="column" flexShrink={0}>
      <SplitLine
        width={width}
        left={[{ text: "mode ", color: COLORS.textDim }, ...modeToggleSegments(state.mode, actions)]}
      />
      <Spacer />
      {state.mode === "simple" ? <OverviewSimple {...props} /> : <OverviewDetailed {...props} />}
    </box>
  );
}
