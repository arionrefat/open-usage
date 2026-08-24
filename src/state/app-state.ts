import {
  byProvider,
  PROVIDER_IDS,
  RANGE_KEYS,
  type ProviderConnection,
  type ProviderId,
  type ProviderMeta,
  type RangeKey,
  type ScopeKey,
} from "../data/types";
import {
  DEFAULT_POLL_INTERVAL_MINUTES,
  DEFAULT_WARN_THRESHOLD,
  POLL_INTERVAL_OPTIONS,
  WARN_THRESHOLD_OPTIONS,
} from "../config";

export type ViewKey = "overview" | "claude" | "codex" | "go" | "settings";

export const VIEW_KEYS: readonly ViewKey[] = ["overview", "claude", "codex", "go", "settings"];

export const PROVIDER_VIEWS: Record<ProviderId, ViewKey> = { cl: "claude", cx: "codex", go: "go" };

export type OverviewMode = "simple" | "detailed";

export type Screen = "app" | "onboarding";

export interface OnboardingState {
  /** 0 = pick providers, 1 = summary. */
  step: 0 | 1;
  cursor: number;
  picks: Record<ProviderId, boolean>;
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
  preferenceSaveFailed: boolean;
  isHelpOpen: boolean;
  isFiltering: boolean;
  filterQuery: string;
  useSeverityColors: boolean;
  isDailySplitVisible: boolean;
  pollIntervalMinutes: number;
  warnThreshold: number;
  connections: Record<ProviderId, ProviderConnection>;
  onboarding: OnboardingState;
}

export interface AppStateOptions {
  screen?: Screen;
  view?: ViewKey;
  mode?: OverviewMode;
  useSeverityColors?: boolean;
  isDailySplitVisible?: boolean;
  pollIntervalMinutes?: number;
  warnThreshold?: number;
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
  const selection = PROVIDER_IDS.findIndex((id) => options.connections[id].isEnabled);
  return {
    screen: options.screen ?? "app",
    view: options.view ?? "overview",
    mode: options.mode ?? "detailed",
    scope: "weekly",
    range: "30d",
    selection: selection < 0 ? 0 : selection,
    settingsCursor: 0,
    isRefreshing: false,
    refreshError: null,
    preferenceSaveFailed: false,
    isHelpOpen: false,
    isFiltering: false,
    filterQuery: "",
    useSeverityColors: options.useSeverityColors ?? false,
    isDailySplitVisible: options.isDailySplitVisible ?? true,
    pollIntervalMinutes: options.pollIntervalMinutes ?? DEFAULT_POLL_INTERVAL_MINUTES,
    warnThreshold: options.warnThreshold ?? DEFAULT_WARN_THRESHOLD,
    connections: options.connections,
    onboarding: {
      step: 0,
      cursor: 0,
      picks: picksFromConnections(options.connections),
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
  | { type: "refresh-success"; connections: Record<ProviderId, ProviderConnection> }
  | { type: "refresh-failure"; message: string }
  | { type: "preference-save-failure" }
  | { type: "preference-save-success" }
  | { type: "open-onboarding" }
  | { type: "onboarding-move"; delta: number }
  | { type: "onboarding-toggle" }
  | { type: "onboarding-pick"; index: number }
  | { type: "onboarding-select-all" }
  | { type: "onboarding-begin-auth" }
  | { type: "onboarding-finish" }
  | { type: "onboarding-cancel" }
  | { type: "settings-move"; delta: number }
  | { type: "settings-toggle-enabled"; id?: ProviderId }
  | { type: "set-poll-interval"; minutes: number }
  | { type: "cycle-poll-interval" }
  | { type: "set-warn-threshold"; percent: number }
  | { type: "cycle-warn-threshold" };

function wrapIndex(index: number, delta: number, length: number): number {
  return (index + (delta % length) + length) % length;
}

function nextOption<T>(options: readonly T[], current: T): T {
  const index = options.indexOf(current);
  return options[(index + 1 + options.length) % options.length]!;
}

export function nextPollIntervalMinutes(current: number): number {
  return nextOption(POLL_INTERVAL_OPTIONS, current);
}

export function nextWarnThreshold(current: number): number {
  return nextOption(WARN_THRESHOLD_OPTIONS, current);
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
  meta: Record<ProviderId, ProviderMeta>,
): AppState {
  return normalizeSelection(
    {
      ...state,
      connections: { ...state.connections, [id]: { ...state.connections[id], ...patch } },
    },
    meta,
  );
}

function normalizeSelection(
  state: AppState,
  meta: Record<ProviderId, ProviderMeta>,
): AppState {
  const ids = selectableProviders(state, meta);
  const currentId = PROVIDER_IDS[state.selection];
  if (!ids[0] || (currentId && ids.includes(currentId))) return state;
  return { ...state, selection: PROVIDER_IDS.indexOf(ids[0]) };
}

function reconcileConnections(
  state: AppState,
  refreshed: Record<ProviderId, ProviderConnection>,
  meta: Record<ProviderId, ProviderMeta>,
): AppState {
  const connections = byProvider((id) => ({
    ...refreshed[id],
    isEnabled: state.connections[id].isEnabled,
  }));
  return normalizeSelection(
    { ...state, isRefreshing: false, refreshError: null, connections },
    meta,
  );
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

function pasteInput(state: AppState, text: string): AppState {
  if (state.isFiltering) {
    return { ...state, filterQuery: state.filterQuery + text.replace(/[\r\n]+/g, " ") };
  }
  return state;
}

function beginOnboardingAuth(
  state: AppState,
  meta: Record<ProviderId, ProviderMeta>,
): AppState {
  const queue = pickedProviders(state.onboarding.picks);
  if (queue.length === 0) return state;

  const connections: Record<ProviderId, ProviderConnection> = {
    cl: { ...state.connections.cl, isEnabled: state.onboarding.picks.cl },
    cx: { ...state.connections.cx, isEnabled: state.onboarding.picks.cx },
    go: { ...state.connections.go, isEnabled: state.onboarding.picks.go },
  };
  return normalizeSelection(
    {
      ...state,
      connections,
      onboarding: {
        ...state.onboarding,
        step: 1,
      },
    },
    meta,
  );
}

export function createAppReducer(meta: Record<ProviderId, ProviderMeta>) {
  return function appReducer(state: AppState, action: AppAction): AppState {
    switch (action.type) {
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
        const normalized = normalizeSelection(state, meta);
        const id = PROVIDER_IDS[normalized.selection];
        if (!id || !selectableProviders(normalized, meta).includes(id)) return normalized;
        return { ...normalized, view: PROVIDER_VIEWS[id] };
      }
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
      case "refresh-start":
        return { ...state, isRefreshing: true, refreshError: null };
      case "refresh-success":
        return reconcileConnections(state, action.connections, meta);
      case "refresh-failure":
        return { ...state, isRefreshing: false, refreshError: action.message };
      case "preference-save-failure":
        return { ...state, preferenceSaveFailed: true };
      case "preference-save-success":
        return state.preferenceSaveFailed ? { ...state, preferenceSaveFailed: false } : state;
      case "open-onboarding":
        return {
          ...state,
          screen: "onboarding",
          onboarding: {
            step: 0,
            cursor: 0,
            picks: picksFromConnections(state.connections),
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
        return beginOnboardingAuth(state, meta);
      }
      case "onboarding-finish":
        return { ...state, screen: "app", view: "overview" };
      case "onboarding-cancel":
        return { ...state, screen: "app" };
      case "settings-move":
        return {
          ...state,
          settingsCursor: wrapIndex(state.settingsCursor, action.delta, PROVIDER_IDS.length),
        };
      case "settings-toggle-enabled": {
        const id = action.id ?? PROVIDER_IDS[state.settingsCursor]!;
        return withConnection(
          state,
          id,
          { isEnabled: !state.connections[id].isEnabled },
          meta,
        );
      }
      case "cycle-poll-interval":
        return {
          ...state,
          pollIntervalMinutes: nextPollIntervalMinutes(state.pollIntervalMinutes),
        };
      case "set-poll-interval":
        return { ...state, pollIntervalMinutes: action.minutes };
      case "cycle-warn-threshold":
        return {
          ...state,
          warnThreshold: nextWarnThreshold(state.warnThreshold),
        };
      case "set-warn-threshold":
        return { ...state, warnThreshold: action.percent };
      default:
        return state;
    }
  };
}

/** True when limits can be shown from a live read, startup cache, or local estimate. */
export function isProviderLive(connection: ProviderConnection): boolean {
  return connection.isEnabled && (
    connection.status === "active" ||
    connection.status === "cached" ||
    connection.status === "local"
  );
}
