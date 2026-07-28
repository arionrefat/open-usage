import {
  PROVIDER_IDS,
  RANGE_KEYS,
  type ConnectionStatus,
  type ProviderConnection,
  type ProviderId,
  type ProviderMeta,
  type RangeKey,
  type ScopeKey,
} from "../data/types";

export type ViewKey = "overview" | "claude" | "codex" | "go" | "settings";

export const VIEW_KEYS: readonly ViewKey[] = ["overview", "claude", "codex", "go", "settings"] as const;

export const PROVIDER_VIEWS: Record<ProviderId, ViewKey> = { cl: "claude", cx: "codex", go: "go" };

export type OverviewMode = "simple" | "detailed";

export type Screen = "app" | "onboarding";

export interface OnboardingState {
  /** 0 = pick providers, 1 = paste credentials, 2 = summary. */
  step: 0 | 1 | 2;
  cursor: number;
  picks: Record<ProviderId, boolean>;
  /** Index into the list of picked providers currently being connected. */
  index: number;
  typed: string;
}

export interface AppState {
  screen: Screen;
  view: ViewKey;
  mode: OverviewMode;
  scope: ScopeKey;
  range: RangeKey;
  /** Highlighted provider on the overview. */
  selection: number;
  /** Highlighted row on the settings screen. */
  settingsCursor: number;
  isRefreshing: boolean;
  spinnerFrame: number;
  secondsSinceUpdate: number;
  isHelpOpen: boolean;
  isFiltering: boolean;
  filterQuery: string;
  useSeverityColors: boolean;
  isDailySplitVisible: boolean;
  connections: Record<ProviderId, ProviderConnection>;
  onboarding: OnboardingState;
}

export interface AppStateOptions {
  screen?: Screen;
  view?: ViewKey;
  mode?: OverviewMode;
  useSeverityColors?: boolean;
  isDailySplitVisible?: boolean;
  connections: Record<ProviderId, ProviderConnection>;
}

const INITIAL_SECONDS_SINCE_UPDATE = 14;

export function createInitialState(options: AppStateOptions): AppState {
  return {
    screen: options.screen ?? "app",
    view: options.view ?? "overview",
    mode: options.mode ?? "detailed",
    scope: "weekly",
    range: "30d",
    selection: 0,
    settingsCursor: 0,
    isRefreshing: false,
    spinnerFrame: 0,
    secondsSinceUpdate: INITIAL_SECONDS_SINCE_UPDATE,
    isHelpOpen: false,
    isFiltering: false,
    filterQuery: "",
    useSeverityColors: options.useSeverityColors ?? false,
    isDailySplitVisible: options.isDailySplitVisible ?? true,
    connections: options.connections,
    onboarding: { step: 0, cursor: 0, picks: { cl: true, cx: true, go: true }, index: 0, typed: "" },
  };
}

export type AppAction =
  | { type: "set-view"; view: ViewKey }
  | { type: "cycle-view" }
  | { type: "set-mode"; mode: OverviewMode }
  | { type: "toggle-mode" }
  | { type: "set-scope"; scope: ScopeKey }
  | { type: "toggle-scope" }
  | { type: "cycle-range" }
  | { type: "move-selection"; delta: number }
  | { type: "select-provider"; id: ProviderId }
  | { type: "open-selected" }
  | { type: "toggle-help" }
  | { type: "close-help" }
  | { type: "start-filter" }
  | { type: "filter-append"; text: string }
  | { type: "filter-backspace" }
  | { type: "filter-commit" }
  | { type: "filter-cancel" }
  | { type: "refresh-start" }
  | { type: "refresh-finish" }
  | { type: "tick-second" }
  | { type: "tick-spinner" }
  | { type: "open-onboarding" }
  | { type: "onboarding-move"; delta: number }
  | { type: "onboarding-toggle" }
  | { type: "onboarding-pick"; index: number }
  | { type: "onboarding-select-all" }
  | { type: "onboarding-begin-auth" }
  | { type: "onboarding-append"; text: string }
  | { type: "onboarding-backspace" }
  | { type: "onboarding-commit"; maskedCredential: string | null }
  | { type: "onboarding-finish" }
  | { type: "settings-move"; delta: number }
  | { type: "settings-toggle-enabled" }
  | { type: "settings-cycle-status" }
  | { type: "settings-paste" }
  | { type: "settings-disconnect" };

const MAX_CREDENTIAL_LENGTH = 44;

const NEXT_STATUS: Record<ConnectionStatus, ConnectionStatus> = {
  active: "expired",
  expired: "none",
  none: "active",
};

const STATUS_NOTES: Record<ConnectionStatus, string> = {
  active: "reconnected just now",
  expired: "renewal needed",
  none: "credential removed",
};

function wrapIndex(index: number, delta: number, length: number): number {
  return (index + (delta % length) + length) % length;
}

function pickedProviders(picks: Record<ProviderId, boolean>): ProviderId[] {
  return PROVIDER_IDS.filter((id) => picks[id]);
}

function withConnection(
  state: AppState,
  id: ProviderId,
  patch: Partial<ProviderConnection>,
): AppState {
  return {
    ...state,
    connections: { ...state.connections, [id]: { ...state.connections[id], ...patch } },
  };
}

/**
 * The meta table is needed so the reducer can restore a provider's placeholder
 * credential when its status cycles back to connected.
 */
export function createAppReducer(meta: Record<ProviderId, ProviderMeta>) {
  return function appReducer(state: AppState, action: AppAction): AppState {
    switch (action.type) {
      case "set-view":
        return { ...state, view: action.view };
      case "cycle-view":
        return { ...state, view: VIEW_KEYS[wrapIndex(VIEW_KEYS.indexOf(state.view), 1, VIEW_KEYS.length)]! };
      case "set-mode":
        return { ...state, view: "overview", mode: action.mode };
      case "toggle-mode":
        return { ...state, view: "overview", mode: state.mode === "simple" ? "detailed" : "simple" };
      case "set-scope":
        return { ...state, view: "overview", mode: "simple", scope: action.scope };
      case "toggle-scope":
        return {
          ...state,
          view: "overview",
          mode: "simple",
          scope: state.scope === "weekly" ? "session" : "weekly",
        };
      case "cycle-range":
        return { ...state, range: RANGE_KEYS[wrapIndex(RANGE_KEYS.indexOf(state.range), 1, RANGE_KEYS.length)]! };
      case "move-selection": {
        const selection = wrapIndex(state.selection, action.delta, PROVIDER_IDS.length);
        return { ...state, view: "overview", selection };
      }
      case "select-provider": {
        const index = PROVIDER_IDS.indexOf(action.id);
        return { ...state, selection: index, settingsCursor: index };
      }
      case "open-selected":
        return { ...state, view: PROVIDER_VIEWS[PROVIDER_IDS[state.selection]!] };
      case "toggle-help":
        return { ...state, isHelpOpen: !state.isHelpOpen };
      case "close-help":
        return { ...state, isHelpOpen: false };
      case "start-filter":
        return { ...state, isFiltering: true, filterQuery: "", view: "overview" };
      case "filter-append":
        return { ...state, filterQuery: state.filterQuery + action.text };
      case "filter-backspace":
        return { ...state, filterQuery: state.filterQuery.slice(0, -1) };
      case "filter-commit":
        return { ...state, isFiltering: false };
      case "filter-cancel":
        return { ...state, isFiltering: false, filterQuery: "" };
      case "refresh-start":
        return { ...state, isRefreshing: true, secondsSinceUpdate: 0 };
      case "refresh-finish":
        return { ...state, isRefreshing: false, secondsSinceUpdate: 0 };
      case "tick-second":
        return { ...state, secondsSinceUpdate: state.secondsSinceUpdate + 1 };
      case "tick-spinner":
        return { ...state, spinnerFrame: state.spinnerFrame + 1 };
      case "open-onboarding":
        return {
          ...state,
          screen: "onboarding",
          onboarding: { ...state.onboarding, step: 0, cursor: 0, index: 0, typed: "" },
        };
      case "onboarding-move":
        return {
          ...state,
          onboarding: {
            ...state.onboarding,
            cursor: wrapIndex(state.onboarding.cursor, action.delta, PROVIDER_IDS.length),
          },
        };
      case "onboarding-toggle": {
        const id = PROVIDER_IDS[state.onboarding.cursor]!;
        return {
          ...state,
          onboarding: {
            ...state.onboarding,
            picks: { ...state.onboarding.picks, [id]: !state.onboarding.picks[id] },
          },
        };
      }
      case "onboarding-pick": {
        const id = PROVIDER_IDS[action.index];
        if (!id) return state;
        return {
          ...state,
          onboarding: {
            ...state.onboarding,
            cursor: action.index,
            picks: { ...state.onboarding.picks, [id]: !state.onboarding.picks[id] },
          },
        };
      }
      case "onboarding-select-all":
        return { ...state, onboarding: { ...state.onboarding, picks: { cl: true, cx: true, go: true } } };
      case "onboarding-begin-auth": {
        if (pickedProviders(state.onboarding.picks).length === 0) return state;
        return { ...state, onboarding: { ...state.onboarding, step: 1, index: 0, typed: "" } };
      }
      case "onboarding-append":
        return {
          ...state,
          onboarding: {
            ...state.onboarding,
            typed: (state.onboarding.typed + action.text).slice(0, MAX_CREDENTIAL_LENGTH),
          },
        };
      case "onboarding-backspace":
        return { ...state, onboarding: { ...state.onboarding, typed: state.onboarding.typed.slice(0, -1) } };
      case "onboarding-commit": {
        const queue = pickedProviders(state.onboarding.picks);
        const current = queue[Math.min(state.onboarding.index, queue.length - 1)];
        if (!current) return state;
        const connection: ProviderConnection = action.maskedCredential
          ? {
              isEnabled: true,
              status: "active",
              credential: action.maskedCredential,
              note: "added just now",
            }
          : { isEnabled: false, status: "none", credential: "", note: "skipped during setup" };
        const isLast = state.onboarding.index >= queue.length - 1;
        return {
          ...withConnection(state, current, connection),
          onboarding: {
            ...state.onboarding,
            typed: "",
            index: isLast ? state.onboarding.index : state.onboarding.index + 1,
            step: isLast ? 2 : 1,
          },
        };
      }
      case "onboarding-finish":
        return { ...state, screen: "app", view: "overview" };
      case "settings-move":
        return {
          ...state,
          settingsCursor: wrapIndex(state.settingsCursor, action.delta, PROVIDER_IDS.length),
        };
      case "settings-toggle-enabled": {
        const id = PROVIDER_IDS[state.settingsCursor]!;
        return withConnection(state, id, { isEnabled: !state.connections[id].isEnabled });
      }
      case "settings-cycle-status": {
        const id = PROVIDER_IDS[state.settingsCursor]!;
        const current = state.connections[id];
        const status = NEXT_STATUS[current.status];
        return withConnection(state, id, {
          status,
          credential: status === "none" ? "" : current.credential || meta[id].sampleCredential,
          note: STATUS_NOTES[status],
        });
      }
      case "settings-paste": {
        const id = PROVIDER_IDS[state.settingsCursor]!;
        return withConnection(state, id, {
          isEnabled: true,
          status: "active",
          credential: meta[id].sampleCredential,
          note: "pasted just now",
        });
      }
      case "settings-disconnect": {
        const id = PROVIDER_IDS[state.settingsCursor]!;
        return withConnection(state, id, {
          isEnabled: false,
          status: "none",
          credential: "",
          note: "disconnected",
        });
      }
      default:
        return state;
    }
  };
}

/** True when the provider is both shown and has a usable credential. */
export function isProviderLive(connection: ProviderConnection): boolean {
  return connection.isEnabled && connection.status === "active";
}
