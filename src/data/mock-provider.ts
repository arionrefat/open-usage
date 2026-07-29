import { COLORS } from "../theme";
import type {
  ProviderConnection,
  ProviderId,
  ProviderMeta,
  UsageProvider,
  UsageSnapshot,
} from "./types";

const META: Record<ProviderId, ProviderMeta> = {
  cl: {
    id: "cl",
    name: "claude code",
    plan: "Max (20x)",
    planShort: "Max (20x)",
    planDetail: "Max (20x) · anthropic oauth",
    requirement: "oauth login or ANTHROPIC_API_KEY",
    source: "~/.claude/usage.jsonl",
  },
  cx: {
    id: "cx",
    name: "codex",
    plan: "Plus · shared with Work",
    planShort: "Plus · shared w/ Work",
    planDetail: "Plus · codex and work share one limit",
    requirement: "openai api key with usage.read",
    source: "platform.openai.com/usage",
  },
  go: {
    id: "go",
    name: "opencode go",
    plan: "Go subscription",
    planShort: "Go · subscribed",
    planDetail: "Go · subscribed",
    requirement: "opencode auth token",
    source: "opencode auth token",
  },
};

const INITIAL_CONNECTIONS: Record<ProviderId, ProviderConnection> = {
  cl: { isEnabled: true, status: "active", credential: "oauth · claude-max", note: "token expires in 27d" },
  cx: { isEnabled: true, status: "expired", credential: "sk-proj-•••••••••••4f2a", note: "Plus renewal failed Jul 24" },
  go: { isEnabled: true, status: "active", credential: "oc_live_•••••••9d1c", note: "renews Aug 3" },
};

const DAILY: Record<ProviderId, number[]> = {
  cl: [38, 42, 12, 55, 61, 48, 9, 71, 66, 52, 44, 18, 7, 63, 58, 72, 49, 55, 21, 11, 68, 74, 59, 46, 33, 15, 62, 77, 84, 69],
  cx: [12, 9, 22, 31, 7, 4, 0, 18, 26, 14, 33, 11, 3, 21, 17, 29, 38, 12, 6, 2, 24, 19, 35, 41, 13, 8, 27, 16, 22, 31],
  go: [0, 0, 3, 5, 2, 8, 1, 4, 11, 14, 9, 6, 0, 12, 18, 15, 22, 19, 7, 3, 17, 25, 21, 28, 16, 9, 24, 31, 27, 35],
};

const HOURLY: Record<ProviderId, number[]> = {
  cl: [0, 0, 0, 0, 0, 0, 1, 3, 6, 8, 7, 4, 2, 5, 8, 9, 6, 4, 3, 2, 1, 0, 0, 0],
  cx: [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 2, 1, 3, 4, 5, 3, 2, 1, 0, 0, 0, 0, 0],
  go: [0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 4, 3, 1, 2, 5, 6, 4, 3, 2, 0, 0, 0, 0, 0],
};

const DAILY_DATES = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 5, 28 + index));
  return date.toISOString().slice(0, 10);
});

const SNAPSHOT: UsageSnapshot = {
  dailyDates: DAILY_DATES,
  hourlyAxis: ["00:00", "12:00", "23:00"],
  fetchedAt: Date.now(),
  windowNote:
    "windows differ per provider — codex publishes one shared weekly pool, opencode go also caps monthly (91%, 6d 5h left)",
  providers: {
    cl: {
      id: "cl",
      meta: META.cl,
      series: { daily: DAILY.cl, hourly: HOURLY.cl },
      limits: [
        {
          id: "session",
          label: "current session",
          percent: 21,
          reset: "resets in 1h 37m",
        },
        {
          id: "weekly",
          label: "weekly · all models",
          percent: 88,
          reset: "resets Wed 5:59 AM",
          resetLong: "resets Wed 5:59 AM · 2d 11h",
          alert: { text: "▲ burn rate 12.4M tok/h → projected 104% before reset", color: COLORS.danger },
        },
        {
          id: "fable",
          label: "weekly · Fable",
          percent: 60,
          reset: "resets Wed 5:59 AM",
        },
      ],
      scopes: {
        session: { percent: 21, window: "5h rolling", reset: "resets in 1h 37m" },
        weekly: { percent: 88, window: "7d · all models", reset: "resets Wed 5:59 AM · 2d 11h" },
      },
      burn: {
        limit: "weekly · all models",
        timeToReset: "2d 11h to reset",
        rate: "12.4M tok/h",
        projectedPercent: 104,
        capsOutAt: "Tue 19:40",
      },
      notice: {
        icon: "ⓘ",
        iconColor: COLORS.info,
        segments: [
          {
            text: "Fable is still included with your Max plan. If you see a prompt to set up usage credits for it, restart Claude Code.",
          },
        ],
      },
    },
    cx: {
      id: "cx",
      meta: META.cx,
      series: { daily: DAILY.cx, hourly: HOURLY.cx },
      limits: [
        {
          id: "weekly",
          label: "weekly limit",
          detailLabel: "weekly usage limit",
          percent: 34,
          detailValueLabel: "66% remaining",
          reset: "resets in 3d 4h",
          resetLong: "resets in 3d 4h · 66% remaining",
          alert: { text: "✓ most headroom of your three providers — route new work here", color: COLORS.ok },
        },
        {
          id: "credits",
          label: "credits remaining",
          percent: null,
          valueLabel: "0",
          valueColor: COLORS.danger,
          reset: "top up to extend past the plan cap",
          footnote: "credits extend usage past plan limits",
        },
        {
          id: "review",
          label: "code review",
          percent: null,
          valueLabel: "shared pool",
          valueColor: COLORS.textGhost,
          reset: "shared pool",
          footnote: "no separate cap",
          isCardOnly: true,
        },
      ],
      scopes: {
        session: { percent: null, window: "no session cap", reset: "counted in the weekly pool" },
        weekly: { percent: 34, window: "7d · shared with Work", reset: "resets in 3d 4h" },
      },
      burn: {
        limit: "weekly · shared with Work",
        timeToReset: "3d 4h to reset",
        rate: "3.1M tok/h",
        projectedPercent: 61,
        capsOutAt: "not before reset",
      },
      detailFooter: "code review runs 18 ▏ avg per run 1.9M ▏ counted against the same weekly pool",
    },
    go: {
      id: "go",
      meta: META.go,
      series: { daily: DAILY.go, hourly: HOURLY.go },
      limits: [
        {
          id: "rolling",
          label: "rolling 5h",
          detailLabel: "rolling usage · 5h",
          percent: 12,
          reset: "resets in 5h 0m",
        },
        {
          id: "weekly",
          label: "weekly",
          detailLabel: "weekly usage",
          percent: 41,
          reset: "resets in 6d 8h",
        },
        {
          id: "monthly",
          label: "monthly",
          detailLabel: "monthly usage",
          percent: 91,
          reset: "resets in 6d 5h",
          alert: { text: "▲ 91% of the month gone with 6d 5h left → projected 118%", color: COLORS.danger },
        },
      ],
      scopes: {
        session: { percent: 12, window: "5h rolling", reset: "resets in 5h 0m" },
        weekly: { percent: 41, window: "7d rolling", reset: "resets in 6d 8h" },
      },
      burn: {
        limit: "monthly",
        timeToReset: "6d 5h to reset",
        rate: "5.8M tok/h",
        projectedPercent: 118,
        capsOutAt: "Fri 02:10",
      },
      notice: {
        segments: [
          { text: "Select " },
          { text: '"OpenCode Go"', isEmphasis: true },
          { text: " as the provider in your opencode configuration to use Go models." },
        ],
      },
    },
  },
};

const REFRESH_LATENCY_MS = 1600;

/** Serves the design's sample figures; swap for a polling adapter to go live. */
export const mockUsageProvider: UsageProvider = {
  scopeTitles: { session: "current session", weekly: "weekly limit" },
  listMeta: () => META,
  initialConnections: () => structuredClone(INITIAL_CONNECTIONS),
  readSnapshot: () => SNAPSHOT,
  refresh: (signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ ...SNAPSHOT, fetchedAt: Date.now() }),
        REFRESH_LATENCY_MS,
      );
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Refresh aborted", "AbortError"));
        },
        { once: true },
      );
    }),
  maskCredential: (raw) =>
    raw.length <= 24
      ? "•".repeat(raw.length)
      : `${raw.slice(0, 4)}${"•".repeat(Math.min(9, raw.length - 8))}${raw.slice(-4)}`,
};
