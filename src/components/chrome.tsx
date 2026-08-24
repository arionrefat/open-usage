import { useEffect, useState } from "react";
import { useBlink } from "../hooks/use-blink";
import { useSecondsSince } from "../hooks/use-seconds-since";
import { columnWidth } from "../lib/text";
import { COLORS, SPINNER_FRAMES } from "../theme";
import { VIEW_KEYS, type ViewKey } from "../state/app-state";
import type { AppActions } from "../state/actions";
import { Line, Rule, SplitLine, keyHint, segmentsWidth, type Segment } from "./primitives";

interface HeaderProps {
  width: number;
  providerCount: string;
  alertText: string;
  alertColor: string;
  fetchedAt: number;
  isRefreshing: boolean;
  /** Newer published version, or null when the app is current or did not ask. */
  updateVersion?: string | null;
}

const SPINNER_INTERVAL_MS = 80;

export function Header({
  width,
  providerCount,
  alertText,
  alertColor,
  fetchedAt,
  isRefreshing,
  updateVersion = null,
}: HeaderProps) {
  const secondsSinceUpdate = useSecondsSince(fetchedAt);
  const updatedLabel = isRefreshing ? "now" : `${secondsSinceUpdate}s ago`;
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  useEffect(() => {
    if (!isRefreshing) return;
    setSpinnerFrame(0);
    const timer = setInterval(() => setSpinnerFrame((frame) => frame + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isRefreshing]);
  const spinner = isRefreshing
    ? (SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] ?? "")
    : "";
  return (
    <SplitLine
      width={width}
      left={[
        { text: "OPEN", color: COLORS.accent, isBold: true },
        { text: " USAGE", color: COLORS.info, isBold: true },
      ]}
      right={[
        // Leads the cluster so it is not the first thing dropped when the header
        // is tight, but stays dim: it is news, not a problem to act on now.
        ...(updateVersion
          ? ([
              { text: `v${updateVersion} available`, color: COLORS.textDisabled },
              { text: " ▏ ", color: COLORS.rule },
            ] satisfies Segment[])
          : []),
        { text: providerCount, color: COLORS.textFaint },
        { text: " ▏ ", color: COLORS.rule },
        { text: alertText, color: alertColor },
        { text: " ▏ ", color: COLORS.rule },
        { text: `updated ${updatedLabel}`, color: COLORS.textFaint },
        { text: ` ${spinner.padEnd(1)}`, color: COLORS.info },
      ]}
    />
  );
}

const TAB_LABELS: Record<ViewKey, string> = {
  overview: "overview",
  claude: "claude code",
  codex: "codex",
  go: "opencode go",
  settings: "settings",
};

interface TabsProps {
  width: number;
  activeView: ViewKey;
  rangeLabel: string;
  actions: AppActions;
}

interface TabCell {
  view: ViewKey;
  label: string;
  isActive: boolean;
  width: number;
}

/**
 * Picks the widest run of tabs that fits, always including the active one so its
 * underline never points at a label that was dropped. Grows forward first so the
 * strip keeps reading left to right.
 */
function visibleTabs(tabs: TabCell[], activeIndex: number, budget: number): TabCell[] {
  const active = tabs[activeIndex];
  if (!active) return [];
  if (active.width > budget) return [active];

  let start = activeIndex;
  let end = activeIndex;
  let used = active.width;
  for (;;) {
    const next = tabs[end + 1];
    if (next && used + next.width <= budget) {
      used += next.width;
      end += 1;
      continue;
    }
    const previous = tabs[start - 1];
    if (previous && used + previous.width <= budget) {
      used += previous.width;
      start -= 1;
      continue;
    }
    return tabs.slice(start, end + 1);
  }
}

function visibleQueryText(query: string, budget: number): string {
  const characters = [...query];
  if (characters.length <= budget) return query;
  if (budget === 1) return "…";
  return `…${characters.slice(-(budget - 1)).join("")}`;
}

export function Tabs({ width, activeView, rangeLabel, actions }: TabsProps) {
  const cycleRange = () => actions.cycleRange();
  const right: Segment[] = [
    { text: "range ", color: COLORS.textFaint, onClick: cycleRange },
    { text: rangeLabel, color: COLORS.text, onClick: cycleRange },
    { text: " t", color: COLORS.textDisabled, onClick: cycleRange },
  ];

  const allTabs: TabCell[] = VIEW_KEYS.map((view, index) => {
    const label = ` ${index + 1} ${TAB_LABELS[view]} `;
    return { view, label, isActive: view === activeView, width: columnWidth(label) };
  });
  const activeIndex = VIEW_KEYS.indexOf(activeView);
  const tabBudget = Math.max(0, width - segmentsWidth(right) - 1);
  const tabs = visibleTabs(allTabs, activeIndex, tabBudget);

  const left: Segment[] = tabs.flatMap((tab) => {
    const background = tab.isActive ? COLORS.bgTabActive : COLORS.bgTabIdle;
    const onClick = () => actions.setView(tab.view);
    return [
      {
        text: tab.label.slice(0, 3),
        color: tab.isActive ? COLORS.textSoft : COLORS.textGhost,
        background,
        onClick,
      },
      {
        text: tab.label.slice(3),
        color: tab.isActive ? COLORS.textBright : COLORS.textSoft,
        background,
        isBold: tab.isActive,
        onClick,
      },
    ];
  });

  const underline: Segment[] = tabs.map((tab) => ({
    text: "─".repeat(tab.width),
    color: tab.isActive ? COLORS.accent : COLORS.divider,
  }));
  const tabsWidth = tabs.reduce((acc, tab) => acc + tab.width, 0);
  underline.push({ text: "─".repeat(Math.max(0, width - tabsWidth)), color: COLORS.divider });

  return (
    <box flexDirection="column" flexShrink={0}>
      <SplitLine width={width} left={left} right={right} />
      <Line segments={underline} width={width} />
    </box>
  );
}

interface FilterBarProps {
  width: number;
  query: string;
  matchCount: number;
}

/** Owns its blink timer so a cursor tick never commits the App tree. */
export function FilterBar({ width, query, matchCount }: FilterBarProps) {
  const isCursorVisible = useBlink(true);
  const queryBudget = Math.max(1, Math.floor(width * 0.6) - 4);
  const visibleQuery = visibleQueryText(query, queryBudget);
  return (
    <box flexDirection="column" flexShrink={0}>
      <Rule width={width} color={COLORS.border} />
      <SplitLine
        width={width}
        background={COLORS.bgFilter}
        left={[
          { text: "/", color: COLORS.info },
          { text: ` ${visibleQuery}`, color: COLORS.text },
          { text: isCursorVisible ? "█" : " ", color: COLORS.text },
        ]}
        right={[
          {
            text: `${matchCount} of 3 providers · enter to keep · esc to clear`,
            color: COLORS.textGhost,
          },
        ]}
      />
    </box>
  );
}

const SEPARATOR_WIDTH = 3;

export function StatusBar({
  width,
  view,
  actions,
  message,
}: {
  width: number;
  view: ViewKey;
  actions: AppActions;
  message?: string;
}) {
  const hints: Array<[string, string, (() => void)?]> = view === "settings"
    ? [
        ["j/k", "move"],
        ["↵", "reconnect"],
        ["space", "toggle", () => actions.settingsToggle()],
        ["m", "mode", () => actions.toggleMode()],
        ["p", "poll", () => actions.cyclePollInterval()],
        ["w", "alert", () => actions.cycleWarnThreshold()],
        ["r", "refresh", () => actions.refresh()],
        ["?", "help", () => actions.toggleHelp()],
      ]
    : [
        ["j/k", "move", () => actions.moveSelection(1)],
        ["↵", "open", () => actions.openSelected()],
        ["tab", "next view", () => actions.cycleView()],
        ["m", "mode", () => actions.toggleMode()],
        ["w", "window", () => actions.toggleScope()],
        ["t", "range", () => actions.cycleRange()],
        ["r", "refresh", () => actions.refresh()],
        ["/", "filter", () => actions.startFilter()],
        ["?", "help", () => actions.toggleHelp()],
        ["5", "settings", () => actions.setView("settings")],
      ];

  const quit = () => actions.quit();
  const right: Segment[] = [
    { text: "q", color: COLORS.textSoft, onClick: quit },
    { text: " quit", color: COLORS.textGhost, onClick: quit },
  ];

  // Hints are dropped from the right rather than allowed to wrap the footer.
  const budget = width - segmentsWidth(right) - SEPARATOR_WIDTH;
  const left: Segment[] = message ? [{ text: message, color: COLORS.danger }] : [];
  let used = 0;
  for (const [key, description, onClick] of message ? [] : hints) {
    const labelWidth = columnWidth(key) + 1 + columnWidth(description);
    const separatorWidth = left.length > 0 ? SEPARATOR_WIDTH : 0;
    const cost = labelWidth + separatorWidth;
    if (used + cost > budget) break;
    if (left.length > 0) left.push({ text: " · ", color: COLORS.footerSeparator });
    left.push({ text: key, color: COLORS.textSoft, onClick });
    left.push({ text: ` ${description}`, color: COLORS.textGhost, onClick });
    used += cost;
  }

  return <SplitLine width={width} background={COLORS.bgChrome} left={left} right={right} />;
}

interface FooterHintsProps {
  width: number;
  hints: Array<[string, string]>;
  right?: Segment[];
}

/** Key legend used by the onboarding steps, which have their own keymap. */
export function KeyLegend({ width, hints, right }: FooterHintsProps) {
  const left: Segment[] = [];
  hints.forEach(([key, description], index) => {
    if (index > 0) left.push({ text: "  ", color: COLORS.rule });
    left.push(...keyHint(key, description));
  });
  return <SplitLine width={width} left={left} right={right} />;
}
