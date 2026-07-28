import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { FilterBar, Header, StatusBar, Tabs } from "./components/chrome";
import { APP_NAME } from "./config";
import { PROVIDER_IDS, type ProviderId, type ScopeKey, type UsageProvider } from "./data/types";
import { useBlink } from "./hooks/use-blink";
import {
  VIEW_KEYS,
  createAppReducer,
  createInitialState,
  type AppStateOptions,
  type OverviewMode,
  type ViewKey,
} from "./state/app-state";
import type { AppActions } from "./state/actions";
import { deriveState } from "./state/derive";
import { HelpOverlay } from "./screens/help-overlay";
import { Onboarding } from "./screens/onboarding";
import { Overview } from "./screens/overview";
import { ProviderDetail } from "./screens/provider-detail";
import { Settings } from "./screens/settings";
import { COLORS, SPINNER_FRAMES } from "./theme";

const HORIZONTAL_PADDING = 2;
/** Reserved so the scrollbox's gutter never steals a column from the content. */
const SCROLLBAR_WIDTH = 1;
const SPINNER_INTERVAL_MS = 80;
const SECOND_MS = 1000;
const DETAIL_CHART_MAX_HEIGHT = 7;
const DETAIL_CHART_MIN_HEIGHT = 4;
/** Rows consumed by chrome plus a provider screen's non-chart content. */
const DETAIL_CHROME_ROWS = 24;

const DETAIL_VIEWS: Partial<Record<ViewKey, ProviderId>> = { claude: "cl", codex: "cx", go: "go" };

function printableChar(key: KeyEvent): string | null {
  const sequence = key.sequence;
  if (!sequence || [...sequence].length !== 1) return null;
  if (sequence < " " || sequence === "\x7f") return null;
  return sequence;
}

export interface AppProps {
  provider: UsageProvider;
  startup: Omit<AppStateOptions, "connections">;
}

export function App({ provider, startup }: AppProps) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const meta = useMemo(() => provider.listMeta(), [provider]);
  const reducer = useMemo(() => createAppReducer(meta), [meta]);
  const [state, dispatch] = useReducer(
    reducer,
    { ...startup, connections: provider.initialConnections() },
    createInitialState,
  );
  const snapshot = provider.readSnapshot();
  const derived = useMemo(() => deriveState(state, snapshot), [state, snapshot]);
  const isRefreshingRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => dispatch({ type: "tick-second" }), SECOND_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!state.isRefreshing) return;
    const timer = setInterval(() => dispatch({ type: "tick-spinner" }), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state.isRefreshing]);

  const refresh = useCallback(() => {
    if (isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    dispatch({ type: "refresh-start" });
    void provider.refresh().finally(() => {
      isRefreshingRef.current = false;
      dispatch({ type: "refresh-finish" });
    });
  }, [provider]);

  const quit = useCallback(() => {
    renderer.destroy();
    const polled = PROVIDER_IDS.filter((id) => state.connections[id].isEnabled).length;
    process.stdout.write(
      `$ ${APP_NAME}\n  session ended · ${polled} providers polled · cached ${state.secondsSinceUpdate}s ago\n`,
    );
    process.exit(0);
  }, [renderer, state.connections, state.secondsSinceUpdate]);

  const actions = useMemo<AppActions>(
    () => ({
      setView: (view) => dispatch({ type: "set-view", view }),
      cycleRange: () => dispatch({ type: "cycle-range" }),
      setMode: (mode: OverviewMode) => dispatch({ type: "set-mode", mode }),
      toggleMode: () => dispatch({ type: "toggle-mode" }),
      setScope: (scope: ScopeKey) => dispatch({ type: "set-scope", scope }),
      toggleScope: () => dispatch({ type: "toggle-scope" }),
      selectProvider: (id: ProviderId) => dispatch({ type: "select-provider", id }),
      refresh,
      startFilter: () => dispatch({ type: "start-filter" }),
      toggleHelp: () => dispatch({ type: "toggle-help" }),
      closeHelp: () => dispatch({ type: "close-help" }),
      openOnboarding: () => dispatch({ type: "open-onboarding" }),
      onboardingPick: (index: number) => dispatch({ type: "onboarding-pick", index }),
      onboardingContinue: () => dispatch({ type: "onboarding-begin-auth" }),
      onboardingFinish: () => dispatch({ type: "onboarding-finish" }),
      quit,
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
      dispatch({ type: "settings-paste" });
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
        if (key.ctrl && key.name === "c") {
          quit();
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

  const isCursorVisible = useBlink(state.screen === "onboarding" || state.isFiltering);
  const contentWidth = Math.max(20, width - HORIZONTAL_PADDING * 2 - SCROLLBAR_WIDTH);
  const detailChartHeight = Math.max(
    DETAIL_CHART_MIN_HEIGHT,
    Math.min(DETAIL_CHART_MAX_HEIGHT, height - DETAIL_CHROME_ROWS),
  );
  const detailProviderId = DETAIL_VIEWS[state.view];

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
          alertText={derived.alertText}
          alertColor={derived.alertColor}
          updatedLabel={state.isRefreshing ? "now" : `${state.secondsSinceUpdate}s ago`}
          spinner={
            state.isRefreshing
              ? (SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length] ?? "")
              : ""
          }
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

      <box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={HORIZONTAL_PADDING}
        paddingRight={HORIZONTAL_PADDING}
        backgroundColor={COLORS.bgChrome}
      >
        {state.isFiltering ? (
          <FilterBar
            width={contentWidth}
            query={state.filterQuery}
            matchCount={derived.visibleIds.length}
            isCursorVisible={isCursorVisible}
          />
        ) : null}
        <StatusBar width={contentWidth} actions={actions} />
      </box>

      {state.isHelpOpen ? (
        <HelpOverlay width={width} height={height} onClose={() => dispatch({ type: "close-help" })} />
      ) : null}
    </box>
  );
}
