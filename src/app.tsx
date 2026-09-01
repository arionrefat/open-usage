import type { KeyEvent } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { FilterBar, Header, StatusBar, Tabs } from "./components/chrome";
import { APP_NAME } from "./config";
import {
  PROVIDER_IDS,
  type ProviderId,
  type RefreshReason,
  type ScopeKey,
  type UsageProvider,
  type UsageSnapshot,
} from "./data/types";
import {
  VIEW_KEYS,
  PROVIDER_VIEWS,
  createAppReducer,
  createInitialState,
  nextPollIntervalMinutes,
  nextWarnThreshold,
  type AppStateOptions,
  type OverviewMode,
} from "./state/app-state";
import type { AppActions } from "./state/actions";
import { deriveState } from "./state/derive";
import { HelpOverlay } from "./screens/help-overlay";
import { Onboarding } from "./screens/onboarding";
import { Overview } from "./screens/overview";
import { ProviderDetail } from "./screens/provider-detail";
import { Settings } from "./screens/settings";
import { COLORS } from "./theme";
import type { AppPreferencePatch } from "./preferences";

const HORIZONTAL_PADDING = 2;
/** Reserved so the scrollbox's gutter never steals a column from the content. */
const SCROLLBAR_WIDTH = 1;
const SECOND_MS = 1000;
const IDLE_EXIT_MS = 24 * 60 * 60 * SECOND_MS;
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * SECOND_MS;
const DETAIL_CHART_MAX_HEIGHT = 8;
const DETAIL_CHART_MIN_HEIGHT = 4;
/** Rows consumed by chrome plus a provider screen's non-chart content and labels. */
const DETAIL_CHROME_ROWS = 25;

const TEXT_DECODER = new TextDecoder();

export function pollIntervalMilliseconds(minutes: number): number {
  return minutes * 60 * SECOND_MS;
}

function printableChar(key: KeyEvent): string | null {
  const sequence = key.sequence;
  if (!sequence || [...sequence].length !== 1) return null;
  if (sequence < " " || sequence === "\x7f") return null;
  return sequence;
}

export interface AppProps {
  provider: UsageProvider;
  startup: Omit<AppStateOptions, "connections">;
  /** false disables the startup refresh and poll timer (--no-poll); r still refreshes. */
  isPollingEnabled?: boolean;
  /**
   * Resolves to a newer published version, or null when there is nothing to say.
   * Supplied only by the real entry point, so tests, previews and screenshots
   * never reach the registry. Absent means the check does not run at all.
   */
  checkUpdate?: () => Promise<string | null>;
  onOnboardingFinish?: () => unknown;
  onPreferencesChange?: (patch: AppPreferencePatch) => unknown;
}

export function providerIdsForRefresh(
  connections: AppStateOptions["connections"],
  _reason: RefreshReason,
): ProviderId[] {
  return PROVIDER_IDS.filter((id) => connections[id].isEnabled);
}

export function App({
  provider,
  startup,
  isPollingEnabled = true,
  checkUpdate,
  onOnboardingFinish,
  onPreferencesChange,
}: AppProps) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const meta = useMemo(() => provider.listMeta(), [provider]);
  const reducer = useMemo(() => createAppReducer(meta), [meta]);
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(() => provider.readSnapshot());
  const [state, dispatch] = useReducer(
    reducer,
    { provider, startup },
    ({ provider: initialProvider, startup: initialStartup }) =>
      createInitialState({
        ...initialStartup,
        connections: initialProvider.initialConnections(),
      }),
  );
  const derived = useMemo(() => deriveState(state, snapshot), [state, snapshot]);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const pendingManualRefreshRef = useRef(false);
  const refreshContextRef = useRef({
    connections: state.connections,
    screen: state.screen,
    settingsCursor: state.settingsCursor,
  });
  refreshContextRef.current = {
    connections: state.connections,
    screen: state.screen,
    settingsCursor: state.settingsCursor,
  };
  // Read by quit() so its identity stays stable; unstable deps here would
  // re-render the whole tree via `actions` and feed Bun's per-commit leak.
  const sessionRef = useRef({ connections: state.connections, fetchedAt: snapshot.fetchedAt });
  sessionRef.current = { connections: state.connections, fetchedAt: snapshot.fetchedAt };

  const refresh = useCallback((reason: RefreshReason = "manual", only?: ProviderId) => {
    if (refreshAbortRef.current) {
      if (reason === "manual") pendingManualRefreshRef.current = true;
      return;
    }
    const context = refreshContextRef.current;
    const providerIds = only
      ? [only]
      : providerIdsForRefresh(context.connections, reason);
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    dispatch({ type: "refresh-start" });
    void Promise.resolve()
      .then(() =>
        provider.refresh({
          reason,
          providerIds,
          signal: controller.signal,
          onSnapshot: (partial) => {
            if (!controller.signal.aborted) setSnapshot(partial);
          },
        }),
      )
      .then((nextSnapshot) => {
        if (controller.signal.aborted) return;
        setSnapshot(nextSnapshot);
        dispatch({ type: "refresh-success", connections: provider.initialConnections() });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "unknown provider error";
        dispatch({ type: "refresh-failure", message });
      })
      .finally(() => {
        if (refreshAbortRef.current !== controller) return;
        refreshAbortRef.current = null;
        if (pendingManualRefreshRef.current) {
          pendingManualRefreshRef.current = false;
          refresh("manual");
        }
      });
  }, [provider]);

  const pollIntervalMs = pollIntervalMilliseconds(state.pollIntervalMinutes);

  useEffect(() => {
    if (!isPollingEnabled) return;
    if (startup.screen !== "onboarding") refresh("startup");
  }, [isPollingEnabled, refresh, startup.screen]);

  useEffect(() => {
    if (!isPollingEnabled) return;
    const timer = setInterval(() => {
      if (refreshContextRef.current.screen === "app") refresh("interval");
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [isPollingEnabled, pollIntervalMs, refresh]);

  useEffect(
    () => () => {
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
    },
    [],
  );

  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!checkUpdate) return;
    let isActive = true;
    // Never awaited by render, and a rejection is swallowed: a courtesy notice
    // must not be able to delay or break the dashboard behind it.
    void checkUpdate()
      .then((version) => {
        if (isActive) setUpdateVersion(version);
      })
      .catch(() => {});
    return () => {
      isActive = false;
    };
  }, [checkUpdate]);

  const persistedPreferencesRef = useRef({
    defaultOverviewMode: state.mode,
    pollIntervalMinutes: state.pollIntervalMinutes,
    warnThreshold: state.warnThreshold,
  });
  const modeRef = useRef(state.mode);
  const preferenceSaveFailedRef = useRef(false);
  const reportPreferenceSave = useCallback((result: unknown) => {
    if (result === false) {
      if (preferenceSaveFailedRef.current) return;
      preferenceSaveFailedRef.current = true;
      dispatch({ type: "preference-save-failure" });
    } else if (preferenceSaveFailedRef.current) {
      preferenceSaveFailedRef.current = false;
      dispatch({ type: "preference-save-success" });
    }
  }, []);
  const persistPreferences = useCallback((patch: AppPreferencePatch) => {
    persistedPreferencesRef.current = { ...persistedPreferencesRef.current, ...patch };
    try {
      reportPreferenceSave(onPreferencesChange?.(patch));
    } catch {
      reportPreferenceSave(false);
    }
  }, [onPreferencesChange, reportPreferenceSave]);

  const quit = useCallback(
    (exitCode = 0) => {
      renderer.destroy();
      const { connections, fetchedAt } = sessionRef.current;
      const polled = PROVIDER_IDS.filter(
        (id) => connections[id].isEnabled && connections[id].status === "active",
      ).length;
      const cachedSeconds = Math.max(0, Math.floor((Date.now() - fetchedAt) / SECOND_MS));
      process.stdout.write(
        `$ ${APP_NAME}\n  session ended · ${polled} providers polled · cached ${cachedSeconds}s ago\n`,
      );
      process.exit(exitCode);
    },
    [renderer],
  );

  // A forgotten session must not poll and leak forever (see memory report).
  const lastInputRef = useRef(Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() - lastInputRef.current > IDLE_EXIT_MS) quit();
    }, IDLE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [quit]);

  const actions = useMemo<AppActions>(
    () => ({
      setView: (view) => dispatch({ type: "set-view", view }),
      cycleRange: () => dispatch({ type: "cycle-range" }),
      setMode: (mode: OverviewMode) => {
        modeRef.current = mode;
        dispatch({ type: "set-mode", mode });
        persistPreferences({ defaultOverviewMode: mode });
      },
      toggleMode: () => {
        const mode = modeRef.current === "simple" ? "detailed" : "simple";
        modeRef.current = mode;
        dispatch({ type: "toggle-mode" });
        persistPreferences({ defaultOverviewMode: mode });
      },
      setScope: (scope: ScopeKey) => {
        modeRef.current = "simple";
        dispatch({ type: "set-scope", scope });
      },
      toggleScope: () => {
        modeRef.current = "simple";
        dispatch({ type: "toggle-scope" });
      },
      selectProvider: (id: ProviderId) => dispatch({ type: "select-provider", id }),
      openProvider: (id: ProviderId) => dispatch({ type: "set-view", view: PROVIDER_VIEWS[id] }),
      moveSelection: (delta: number) => dispatch({ type: "move-selection", delta }),
      openSelected: () => dispatch({ type: "open-selected" }),
      cycleView: () => dispatch({ type: "cycle-view" }),
      refresh: () => refresh("manual"),
      reconnect: (id: ProviderId) => {
        dispatch({ type: "select-provider", id });
        refresh("manual", id);
      },
      startFilter: () => dispatch({ type: "start-filter" }),
      toggleHelp: () => dispatch({ type: "toggle-help" }),
      closeHelp: () => dispatch({ type: "close-help" }),
      openOnboarding: () => dispatch({ type: "open-onboarding" }),
      onboardingPick: (index: number) => dispatch({ type: "onboarding-pick", index }),
      onboardingContinue: () => dispatch({ type: "onboarding-begin-auth" }),
      onboardingFinish: () => {
        dispatch({ type: "onboarding-finish" });
        try {
          reportPreferenceSave(onOnboardingFinish?.());
        } catch {
          reportPreferenceSave(false);
        }
        if (isPollingEnabled) refresh("startup");
      },
      settingsToggle: (id?: ProviderId) => dispatch({ type: "settings-toggle-enabled", id }),
      setPollInterval: (pollIntervalMinutes: number) => {
        if (pollIntervalMinutes === persistedPreferencesRef.current.pollIntervalMinutes) return;
        dispatch({ type: "set-poll-interval", minutes: pollIntervalMinutes });
        persistPreferences({ pollIntervalMinutes });
      },
      cyclePollInterval: () => {
        const pollIntervalMinutes = nextPollIntervalMinutes(
          persistedPreferencesRef.current.pollIntervalMinutes,
        );
        dispatch({ type: "cycle-poll-interval" });
        persistPreferences({ pollIntervalMinutes });
      },
      setWarnThreshold: (warnThreshold: number) => {
        if (warnThreshold === persistedPreferencesRef.current.warnThreshold) return;
        dispatch({ type: "set-warn-threshold", percent: warnThreshold });
        persistPreferences({ warnThreshold });
      },
      cycleWarnThreshold: () => {
        const warnThreshold = nextWarnThreshold(persistedPreferencesRef.current.warnThreshold);
        dispatch({ type: "cycle-warn-threshold" });
        persistPreferences({ warnThreshold });
      },
      quit: () => quit(),
    }),
    [isPollingEnabled, onOnboardingFinish, persistPreferences, quit, refresh, reportPreferenceSave],
  );

  const handleOnboardingKey = useCallback(
    (key: KeyEvent) => {
      const { step } = state.onboarding;
      const char = printableChar(key);

      if (step === 0) {
        if (key.name === "j" || key.name === "down") dispatch({ type: "onboarding-move", delta: 1 });
        else if (key.name === "k" || key.name === "up") dispatch({ type: "onboarding-move", delta: -1 });
        else if (key.name === "space" || char === " " || char === "x") dispatch({ type: "onboarding-toggle" });
        else if (char === "a") dispatch({ type: "onboarding-select-all" });
        else if (key.name === "return") dispatch({ type: "onboarding-begin-auth" });
        else if (key.name === "escape") dispatch({ type: "onboarding-cancel" });
        return;
      }

      if (key.name === "return" || key.name === "space" || char === " ") {
        actions.onboardingFinish();
      }
    },
    [actions, state.onboarding],
  );

  const handleSettingsKey = useCallback((key: KeyEvent): boolean => {
    const char = printableChar(key);
    if (char === "p") {
      actions.cyclePollInterval();
      return true;
    }
    if (char === "w") {
      actions.cycleWarnThreshold();
      return true;
    }
    if (key.name === "j" || key.name === "down") {
      dispatch({ type: "settings-move", delta: 1 });
      return true;
    }
    if (key.name === "k" || key.name === "up") {
      dispatch({ type: "settings-move", delta: -1 });
      return true;
    }
    if (key.name === "space" || char === " " || char === "x") {
      dispatch({ type: "settings-toggle-enabled" });
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      actions.reconnect(PROVIDER_IDS[refreshContextRef.current.settingsCursor]!);
      return true;
    }
    return false;
  }, [actions]);

  const handleFilterKey = useCallback((key: KeyEvent) => {
    const char = printableChar(key);
    if (key.name === "escape") dispatch({ type: "filter-cancel" });
    else if (key.name === "return") dispatch({ type: "filter-commit" });
    else if (key.name === "backspace") dispatch({ type: "filter-backspace" });
    else if (char) dispatch({ type: "filter-append", text: char });
  }, []);

  const handleViewKey = useCallback(
    (key: KeyEvent, char: string | null): boolean => {
      if (char === "o") {
        dispatch({ type: "open-onboarding" });
        return true;
      }
      if (char === ",") {
        dispatch({ type: "set-view", view: "settings" });
        return true;
      }
      return state.view === "settings" && handleSettingsKey(key);
    },
    [handleSettingsKey, state.view],
  );

  const handleAppShortcut = useCallback(
    (key: KeyEvent, char: string | null): boolean => {
      if (char === "?") dispatch({ type: "toggle-help" });
      else if (char === "/") dispatch({ type: "start-filter" });
      else if (char === "q") quit();
      else if (char === "r") refresh("manual");
      else if (char === "t") dispatch({ type: "cycle-range" });
      else if (char === "m") actions.toggleMode();
      else if (char === "w") actions.toggleScope();
      else if (key.name === "tab") dispatch({ type: "cycle-view" });
      else return false;
      return true;
    },
    [actions, quit, refresh],
  );

  const handleSelectionKey = useCallback((key: KeyEvent, char: string | null) => {
    if (char && char >= "1" && char <= "5") {
      dispatch({ type: "set-view", view: VIEW_KEYS[Number(char) - 1]! });
    } else if (key.name === "j" || key.name === "down" || key.name === "right") {
      dispatch({ type: "move-selection", delta: 1 });
    } else if (key.name === "k" || key.name === "up" || key.name === "left") {
      dispatch({ type: "move-selection", delta: -1 });
    } else if (key.name === "return") {
      dispatch({ type: "open-selected" });
    }
  }, []);

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        lastInputRef.current = Date.now();
        if (key.ctrl && key.name === "c") {
          quit(130);
          return;
        }

        if (state.screen === "onboarding") {
          handleOnboardingKey(key);
          return;
        }

        if (state.isFiltering) {
          handleFilterKey(key);
          return;
        }

        if (state.isHelpOpen) {
          dispatch({ type: "close-help" });
          return;
        }

        const char = printableChar(key);
        if (handleViewKey(key, char)) return;
        if (handleAppShortcut(key, char)) return;
        handleSelectionKey(key, char);
      },
      [handleAppShortcut, handleFilterKey, handleOnboardingKey, handleSelectionKey, handleViewKey, quit, state.isFiltering, state.isHelpOpen, state.screen],
    ),
  );

  usePaste(
    useCallback(
      (event) => {
        lastInputRef.current = Date.now();
        dispatch({ type: "paste-input", text: TEXT_DECODER.decode(event.bytes) });
        event.preventDefault();
      },
      [],
    ),
  );

  const contentWidth = Math.max(1, width - HORIZONTAL_PADDING * 2 - SCROLLBAR_WIDTH);
  const detailChartHeight = Math.max(
    DETAIL_CHART_MIN_HEIGHT,
    Math.min(DETAIL_CHART_MAX_HEIGHT, height - DETAIL_CHROME_ROWS),
  );
  const detailProviderId = PROVIDER_IDS.find((id) => PROVIDER_VIEWS[id] === state.view);

  if (state.screen === "onboarding") {
    return (
      <box flexDirection="column" width={width} height={height} backgroundColor={COLORS.bg}>
        <Onboarding
          state={state}
          snapshot={snapshot}
          width={width}
          actions={actions}
        />
      </box>
    );
  }

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={COLORS.bg}>
      <box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={HORIZONTAL_PADDING}
        paddingRight={HORIZONTAL_PADDING}
        paddingTop={1}
      >
        <Header
          width={contentWidth}
          providerCount={`${derived.enabledCount} providers`}
          alertText={state.refreshError ? "▲ refresh failed" : derived.alertText}
          alertColor={state.refreshError ? COLORS.danger : derived.alertColor}
          fetchedAt={snapshot.fetchedAt}
          isRefreshing={state.isRefreshing}
          updateVersion={updateVersion}
        />
        <box height={1} flexShrink={0} />
        <Tabs
          width={contentWidth}
          activeView={state.view}
          rangeLabel={derived.rangeLabel}
          actions={actions}
        />
      </box>

      <scrollbox
        flexGrow={1}
        paddingLeft={HORIZONTAL_PADDING}
        paddingRight={HORIZONTAL_PADDING}
        paddingTop={1}
        scrollX={false}
        contentOptions={{ flexDirection: "column" }}
      >
        {state.view === "overview" ? (
          <Overview
            state={state}
            derived={derived}
            snapshot={snapshot}
            width={contentWidth}
            scopeTitle={provider.scopeTitles[state.scope]}
            actions={actions}
          />
        ) : null}
        {detailProviderId ? (
          <ProviderDetail
            id={detailProviderId}
            state={state}
            derived={derived}
            snapshot={snapshot}
            width={contentWidth}
            chartHeight={detailChartHeight}
          />
        ) : null}
        {state.view === "settings" ? (
          <Settings state={state} snapshot={snapshot} width={contentWidth} actions={actions} />
        ) : null}
      </scrollbox>

      {state.isFiltering ? (
        <box
          flexDirection="column"
          flexShrink={0}
          paddingLeft={HORIZONTAL_PADDING}
          paddingRight={HORIZONTAL_PADDING}
          backgroundColor={COLORS.bgFilter}
        >
          <FilterBar
            width={contentWidth}
            query={state.filterQuery}
            matchCount={derived.visibleIds.length}
          />
        </box>
      ) : null}
      <box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={HORIZONTAL_PADDING}
        paddingRight={HORIZONTAL_PADDING}
        backgroundColor={COLORS.bgChrome}
      >
        <StatusBar
          width={contentWidth}
          view={state.view}
          actions={actions}
          message={state.preferenceSaveFailed ? "▲ save failed" : undefined}
        />
      </box>

      {state.isHelpOpen ? (
        <HelpOverlay
          width={width}
          height={height}
          isSettings={state.view === "settings"}
          onClose={actions.closeHelp}
        />
      ) : null}
    </box>
  );
}
