import type { KeyEvent } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { FilterBar, Header, StatusBar, Tabs } from "./components/chrome";
import { APP_NAME, POLL_INTERVAL_SECONDS } from "./config";
import {
  PROVIDER_IDS,
  type ProviderId,
  type ScopeKey,
  type UsageProvider,
  type UsageSnapshot,
} from "./data/types";
import { useBlink } from "./hooks/use-blink";
import {
  VIEW_KEYS,
  PROVIDER_VIEWS,
  MAX_CREDENTIAL_LENGTH,
  createAppReducer,
  createInitialState,
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

const HORIZONTAL_PADDING = 2;
/** Reserved so the scrollbox's gutter never steals a column from the content. */
const SCROLLBAR_WIDTH = 1;
const SECOND_MS = 1000;
const IDLE_EXIT_MS = 24 * 60 * 60 * SECOND_MS;
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * SECOND_MS;
const POLL_INTERVAL_MS = POLL_INTERVAL_SECONDS * SECOND_MS;
const DETAIL_CHART_MAX_HEIGHT = 8;
const DETAIL_CHART_MIN_HEIGHT = 4;
/** Rows consumed by chrome plus a provider screen's non-chart content. */
const DETAIL_CHROME_ROWS = 24;

const TEXT_DECODER = new TextDecoder();

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
}

export function App({ provider, startup, isPollingEnabled = true }: AppProps) {
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
  // Read by quit() so its identity stays stable; unstable deps here would
  // re-render the whole tree via `actions` and feed Bun's per-commit leak.
  const sessionRef = useRef({ connections: state.connections, fetchedAt: snapshot.fetchedAt });
  sessionRef.current = { connections: state.connections, fetchedAt: snapshot.fetchedAt };

  const refresh = useCallback(() => {
    if (refreshAbortRef.current) return;
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    dispatch({ type: "refresh-start" });
    void Promise.resolve()
      .then(() => provider.refresh(controller.signal))
      .then((nextSnapshot) => {
        if (controller.signal.aborted) return;
        setSnapshot(nextSnapshot);
        dispatch({ type: "refresh-success" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "unknown provider error";
        dispatch({ type: "refresh-failure", message });
      })
      .finally(() => {
        if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
      });
  }, [provider]);

  useEffect(() => {
    if (!isPollingEnabled) return;
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
    };
  }, [isPollingEnabled, refresh]);

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
      setMode: (mode: OverviewMode) => dispatch({ type: "set-mode", mode }),
      toggleMode: () => dispatch({ type: "toggle-mode" }),
      setScope: (scope: ScopeKey) => dispatch({ type: "set-scope", scope }),
      toggleScope: () => dispatch({ type: "toggle-scope" }),
      selectProvider: (id: ProviderId) => dispatch({ type: "select-provider", id }),
      openProvider: (id: ProviderId) => dispatch({ type: "set-view", view: PROVIDER_VIEWS[id] }),
      moveSelection: (delta: number) => dispatch({ type: "move-selection", delta }),
      openSelected: () => dispatch({ type: "open-selected" }),
      cycleView: () => dispatch({ type: "cycle-view" }),
      refresh,
      startFilter: () => dispatch({ type: "start-filter" }),
      toggleHelp: () => dispatch({ type: "toggle-help" }),
      closeHelp: () => dispatch({ type: "close-help" }),
      openOnboarding: () => dispatch({ type: "open-onboarding" }),
      onboardingPick: (index: number) => dispatch({ type: "onboarding-pick", index }),
      onboardingContinue: () => dispatch({ type: "onboarding-begin-auth" }),
      onboardingFinish: () => dispatch({ type: "onboarding-finish" }),
      settingsToggle: (id: ProviderId) => dispatch({ type: "settings-toggle-enabled", id }),
      settingsCycleStatus: (id: ProviderId) => dispatch({ type: "settings-cycle-status", id }),
      settingsPasteKey: (id: ProviderId) => dispatch({ type: "settings-paste-key", id }),
      settingsDisconnect: (id: ProviderId) => dispatch({ type: "settings-disconnect", id }),
      quit: () => quit(),
    }),
    [quit, refresh],
  );

  const handleOnboardingKey = useCallback(
    (key: KeyEvent) => {
      const { step, typed } = state.onboarding;
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

      if (step === 1) {
        if (key.name === "backspace") dispatch({ type: "onboarding-backspace" });
        else if (key.name === "escape" || key.name === "return") {
          const isSkipped = key.name === "escape" || typed.trim().length === 0;
          dispatch({
            type: "onboarding-commit",
            maskedCredential: isSkipped ? null : provider.maskCredential(typed.trim()),
          });
        } else if (char) dispatch({ type: "onboarding-append", text: char });
        return;
      }

      if (key.name === "return" || key.name === "space" || char === " ") {
        dispatch({ type: "onboarding-finish" });
      }
    },
    [provider, state.onboarding],
  );

  const handleSettingsKey = useCallback((key: KeyEvent): boolean => {
    const char = printableChar(key);
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
    if (key.name === "return") {
      dispatch({ type: "settings-cycle-status" });
      return true;
    }
    if (char === "p") {
      dispatch({ type: "settings-paste-key" });
      return true;
    }
    if (char === "d") {
      dispatch({ type: "settings-disconnect" });
      return true;
    }
    return false;
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
          const char = printableChar(key);
          if (key.name === "escape") dispatch({ type: "filter-cancel" });
          else if (key.name === "return") dispatch({ type: "filter-commit" });
          else if (key.name === "backspace") dispatch({ type: "filter-backspace" });
          else if (char) dispatch({ type: "filter-append", text: char });
          return;
        }

        if (state.isHelpOpen) {
          dispatch({ type: "close-help" });
          return;
        }

        const char = printableChar(key);
        if (char === "o") {
          dispatch({ type: "open-onboarding" });
          return;
        }
        if (char === ",") {
          dispatch({ type: "set-view", view: "settings" });
          return;
        }
        if (state.view === "settings" && handleSettingsKey(key)) return;

        if (char === "?") dispatch({ type: "toggle-help" });
        else if (char === "/") dispatch({ type: "start-filter" });
        else if (char === "q") quit();
        else if (char === "r") refresh();
        else if (char === "t") dispatch({ type: "cycle-range" });
        else if (char === "m") dispatch({ type: "toggle-mode" });
        else if (char === "w") dispatch({ type: "toggle-scope" });
        else if (key.name === "tab") dispatch({ type: "cycle-view" });
        else if (char && char >= "1" && char <= "5") {
          dispatch({ type: "set-view", view: VIEW_KEYS[Number(char) - 1]! });
        } else if (key.name === "j" || key.name === "down" || key.name === "right") {
          dispatch({ type: "move-selection", delta: 1 });
        } else if (key.name === "k" || key.name === "up" || key.name === "left") {
          dispatch({ type: "move-selection", delta: -1 });
        } else if (key.name === "return") {
          dispatch({ type: "open-selected" });
        }
      },
      [handleOnboardingKey, handleSettingsKey, quit, refresh, state.isFiltering, state.isHelpOpen, state.screen, state.view],
    ),
  );

  usePaste(
    useCallback(
      (event) => {
        lastInputRef.current = Date.now();
        if (event.bytes.length > MAX_CREDENTIAL_LENGTH) {
          dispatch({
            type: "onboarding-input-error",
            message: "credential exceeds the 16,384 byte paste limit",
          });
          event.preventDefault();
          return;
        }
        dispatch({ type: "paste-input", text: TEXT_DECODER.decode(event.bytes) });
        event.preventDefault();
      },
      [],
    ),
  );

  const isCursorVisible = useBlink(
    (state.screen === "onboarding" && state.onboarding.step === 1) || state.isFiltering,
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
          isCursorVisible={isCursorVisible}
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
          providerCount={`${derived.enabledCount} of ${PROVIDER_IDS.length} providers`}
          alertText={state.refreshError ? "▲ refresh failed" : derived.alertText}
          alertColor={state.refreshError ? COLORS.danger : derived.alertColor}
          fetchedAt={snapshot.fetchedAt}
          isRefreshing={state.isRefreshing}
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
            isCursorVisible={isCursorVisible}
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
        <StatusBar width={contentWidth} actions={actions} />
      </box>

      {state.isHelpOpen ? (
        <HelpOverlay width={width} height={height} onClose={actions.closeHelp} />
      ) : null}
    </box>
  );
}
