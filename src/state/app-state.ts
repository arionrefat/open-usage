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

export const VIEW_KEYS: readonly ViewKey[] = ["overview", "claude", "codex", "go", "settings"];

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
  inputError: string | null;
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
  refreshError: string | null;
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

function picksFromConnections(
  connections: Record<ProviderId, ProviderConnection>,
): Record<ProviderId, boolean> {
  return {
    cl: connections.cl.isEnabled,
    cx: connections.cx.isEnabled,
    go: connections.go.isEnabled,
  };
}

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
    refreshError: null,
    isHelpOpen: false,
    isFiltering: false,
    filterQuery: "",
    useSeverityColors: options.useSeverityColors ?? false,
    isDailySplitVisible: options.isDailySplitVisible ?? true,
    connections: options.connections,
    onboarding: {
      step: 0,
      cursor: 0,
      picks: picksFromConnections(options.connections),
      index: 0,
      typed: "",
      inputError: null,
    },
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
  | { type: "paste-input"; text: string }
  | { type: "refresh-start" }
  | { type: "refresh-success" }
  | { type: "refresh-failure"; message: string }
  | { type: "open-onboarding" }
  | { type: "onboarding-move"; delta: number }
  | { type: "onboarding-toggle" }
  | { type: "onboarding-pick"; index: number }
  | { type: "onboarding-select-all" }
  | { type: "onboarding-begin-auth" }
  | { type: "onboarding-append"; text: string }
  | { type: "onboarding-backspace" }
  | { type: "onboarding-input-error"; message: string }
  | { type: "onboarding-commit"; maskedCredential: string | null }
  | { type: "onboarding-finish" }
  | { type: "onboarding-cancel" }
  | { type: "settings-move"; delta: number }
  | { type: "settings-toggle-enabled"; id?: ProviderId }
  | { type: "settings-cycle-status"; id?: ProviderId }
  | { type: "settings-paste-key"; id?: ProviderId }
  | { type: "settings-disconnect"; id?: ProviderId };

export const MAX_CREDENTIAL_LENGTH = 16_384;

const NEXT_STATUS: Record<ConnectionStatus, ConnectionStatus> = {
  active: "expired",
  expired: "none",
  none: "active",
};

const CYCLE_NOTES: Record<ConnectionStatus, string> = {
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

function selectableProviders(
  state: AppState,
  meta: Record<ProviderId, ProviderMeta>,
): ProviderId[] {
  const query = state.filterQuery.trim().toLowerCase();
  return PROVIDER_IDS.filter(
    (id) => state.connections[id].isEnabled && (!query || meta[id].name.includes(query)),
  );
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

function moveSelection(
  state: AppState,
  delta: number,
  meta: Record<ProviderId, ProviderMeta>,
): AppState {
  const ids = selectableProviders(state, meta);
  if (ids.length === 0) return { ...state, view: "overview" };

  const currentId = PROVIDER_IDS[state.selection];
  const currentIndex = currentId ? ids.indexOf(currentId) : -1;
  const startingIndex = currentIndex >= 0 ? currentIndex : delta > 0 ? -1 : 0;
  const nextId = ids[wrapIndex(startingIndex, delta, ids.length)]!;
  return { ...state, view: "overview", selection: PROVIDER_IDS.indexOf(nextId) };
}

function commitFilter(state: AppState, meta: Record<ProviderId, ProviderMeta>): AppState {
  const ids = selectableProviders(state, meta);
  const currentId = PROVIDER_IDS[state.selection];
  const nextId = currentId && ids.includes(currentId) ? currentId : ids[0];
  return {
    ...state,
    isFiltering: false,
    selection: nextId ? PROVIDER_IDS.indexOf(nextId) : state.selection,
  };
}

function appendCredential(state: AppState, text: string): AppState {
  if (state.onboarding.typed.length + text.length > MAX_CREDENTIAL_LENGTH) {
    return {
      ...state,
      onboarding: {
        ...state.onboarding,
        inputError: "credential exceeds the 16,384 character limit",
      },
    };
  }
  return {
    ...state,
    onboarding: {
      ...state.onboarding,
      typed: state.onboarding.typed + text,
      inputError: null,
    },
  };
}

function pasteInput(state: AppState, text: string): AppState {
  if (state.screen === "onboarding" && state.onboarding.step === 1) {
    return appendCredential(state, text.replace(/[\r\n]+/g, ""));
  }
  if (state.isFiltering) {
    return { ...state, filterQuery: state.filterQuery + text.replace(/[\r\n]+/g, " ") };
  }
  return state;
}

function beginOnboardingAuth(state: AppState): AppState {
  const queue = pickedProviders(state.onboarding.picks);
  if (queue.length === 0) return state;

  const connections: Record<ProviderId, ProviderConnection> = {
    cl: { ...state.connections.cl, isEnabled: state.onboarding.picks.cl },
    cx: { ...state.connections.cx, isEnabled: state.onboarding.picks.cx },
    go: { ...state.connections.go, isEnabled: state.onboarding.picks.go },
  };
  return {
    ...state,
    connections,
    onboarding: {
      ...state.onboarding,
      step: 1,
      index: 0,
      typed: "",
      inputError: null,
    },
  };
}

function commitOnboardingCredential(
  state: AppState,
  maskedCredential: string | null,
): AppState {
  const queue = pickedProviders(state.onboarding.picks);
  const currentId = queue[Math.min(state.onboarding.index, queue.length - 1)];
  if (!currentId) return state;

  const connection: ProviderConnection = maskedCredential
    ? {
        isEnabled: true,
        status: "active",
        credential: maskedCredential,
        note: "added just now",
      }
    : state.connections[currentId];
  const isLastProvider = state.onboarding.index >= queue.length - 1;
  return {
    ...withConnection(state, currentId, connection),
    onboarding: {
      ...state.onboarding,
      typed: "",
      inputError: null,
      index: isLastProvider ? state.onboarding.index : state.onboarding.index + 1,
      step: isLastProvider ? 2 : 1,
    },
  };
}

export function createAppReducer(meta: Record<ProviderId, ProviderMeta>) {
  return function appReducer(state: AppState, action: AppAction): AppState {
    switch (action.type) {
      // View, mode, and selection.
      case "set-view":
        return { ...state, view: action.view };
      case "cycle-view":
        return { ...state, view: VIEW_KEYS[wrapIndex(VIEW_KEYS.indexOf(state.view), 1, VIEW_KEYS.length)]! };
      case "set-mode":
        return { ...state, mode: action.mode };
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
        return moveSelection(state, action.delta, meta);
      }
      case "select-provider": {
        const index = PROVIDER_IDS.indexOf(action.id);
        return { ...state, selection: index, settingsCursor: index };
      }
      case "open-selected": {
        const id = PROVIDER_IDS[state.selection];
        if (!id || !selectableProviders(state, meta).includes(id)) return state;
        return { ...state, view: PROVIDER_VIEWS[id] };
      }
      // Help and provider filtering.
      case "toggle-help":
        return { ...state, isHelpOpen: !state.isHelpOpen, isFiltering: false };
      case "close-help":
        return { ...state, isHelpOpen: false };
      case "start-filter":
        return { ...state, isFiltering: true, isHelpOpen: false, filterQuery: "", view: "overview" };
      case "filter-append":
        return { ...state, filterQuery: state.filterQuery + action.text };
      case "filter-backspace":
        return { ...state, filterQuery: state.filterQuery.slice(0, -1) };
      case "filter-commit": {
        return commitFilter(state, meta);
      }
      case "filter-cancel":
        return { ...state, isFiltering: false, filterQuery: "" };
      case "paste-input":
        return pasteInput(state, action.text);
      // Refresh lifecycle.
      case "refresh-start":
        return { ...state, isRefreshing: true, refreshError: null };
      case "refresh-success":
        return { ...state, isRefreshing: false, refreshError: null };
      case "refresh-failure":
        return { ...state, isRefreshing: false, refreshError: action.message };
      // Onboarding wizard.
      case "open-onboarding":
        return {
          ...state,
          screen: "onboarding",
          onboarding: {
            step: 0,
            cursor: 0,
            picks: picksFromConnections(state.connections),
            index: 0,
            typed: "",
            inputError: null,
          },
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
        return beginOnboardingAuth(state);
      }
      case "onboarding-append":
        return appendCredential(state, action.text);
      case "onboarding-backspace":
        return {
          ...state,
          onboarding: {
            ...state.onboarding,
            typed: state.onboarding.typed.slice(0, -1),
            inputError: null,
          },
        };
      case "onboarding-input-error":
        return {
          ...state,
          onboarding: { ...state.onboarding, inputError: action.message },
        };
      case "onboarding-commit": {
        return commitOnboardingCredential(state, action.maskedCredential);
      }
      case "onboarding-finish":
        return { ...state, screen: "app", view: "overview" };
      case "onboarding-cancel":
        return { ...state, screen: "app" };
      // Settings cursor and connections.
      case "settings-move":
        return {
          ...state,
          settingsCursor: wrapIndex(state.settingsCursor, action.delta, PROVIDER_IDS.length),
        };
      case "settings-toggle-enabled": {
        const id = action.id ?? PROVIDER_IDS[state.settingsCursor]!;
        return withConnection(state, id, { isEnabled: !state.connections[id].isEnabled });
      }
      case "settings-cycle-status": {
        const id = action.id ?? PROVIDER_IDS[state.settingsCursor]!;
        const connection = state.connections[id];
        const next = NEXT_STATUS[connection.status];
        return withConnection(state, id, {
          status: next,
          credential: next === "none" ? "" : connection.credential || meta[id].fake,
          note: CYCLE_NOTES[next],
        });
      }
      case "settings-paste-key": {
        const id = action.id ?? PROVIDER_IDS[state.settingsCursor]!;
        return withConnection(state, id, {
          isEnabled: true,
          status: "active",
          credential: meta[id].fake,
          note: "pasted just now",
        });
      }
      case "settings-disconnect": {
        const id = action.id ?? PROVIDER_IDS[state.settingsCursor]!;
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
