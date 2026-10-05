import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockUsageProvider } from "../../src/data/mock-provider";
import type {
  ConnectionStatus,
  ProviderConnection,
  ProviderId,
  UsageLimit,
  UsageSnapshot,
} from "../../src/data/types";
import { desktopNotificationCommand, type SendNotification } from "../../src/notifications/desktop";
import {
  clearCappedLimits,
  detectLimitChanges,
  notifyLimitChanges,
  readCappedLimits,
  type CappedLimits,
} from "../../src/notifications/limit-alerts";

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function alertsPath(): string {
  const root = mkdtempSync(join(tmpdir(), "open-usage-limit-alerts-"));
  tempRoots.push(root);
  return join(root, "limit-alerts.json");
}

const NONE_CAPPED: CappedLimits = { cl: [], cx: [], go: [] };

function limit(id: string, label: string, percent: number | null): UsageLimit {
  return { id, label, percent, reset: `${id} resets in 2h` };
}

/** The sample snapshot with every provider's limits replaced by the ones given. */
function snapshotWith(limits: Partial<Record<ProviderId, UsageLimit[]>>): UsageSnapshot {
  const snapshot = structuredClone(mockUsageProvider.readSnapshot());
  for (const id of ["cl", "cx", "go"] as const) {
    snapshot.providers[id].limits = limits[id] ?? [];
  }
  return snapshot;
}

function connections(
  statuses: Partial<Record<ProviderId, ConnectionStatus>> = {},
): Record<ProviderId, ProviderConnection> {
  const one = (id: ProviderId): ProviderConnection => ({
    isEnabled: true,
    status: statuses[id] ?? "active",
    credential: "",
    note: "",
  });
  return { cl: one("cl"), cx: one("cx"), go: one("go") };
}

describe("detectLimitChanges", () => {
  test("announces a limit the first time it reaches its cap", () => {
    const snapshot = snapshotWith({
      cl: [limit("session", "current session", 40), limit("weekly", "weekly · all models", 100)],
    });
    const first = detectLimitChanges(NONE_CAPPED, snapshot, connections());
    expect(first.capped.cl).toEqual(["weekly"]);
    expect(first.notifications).toEqual([
      {
        providerId: "cl",
        kind: "reached",
        title: "claude code limit reached",
        body: "weekly · all models at 100% · weekly resets in 2h",
      },
    ]);

    const again = detectLimitChanges(first.capped, snapshot, connections());
    expect(again.notifications).toEqual([]);
  });

  test("calls a provider ready once its last capped limit resets", () => {
    const capped = { ...NONE_CAPPED, cx: ["weekly"] };
    const result = detectLimitChanges(
      capped,
      snapshotWith({ cx: [limit("weekly", "7d limit", 0)] }),
      connections(),
    );
    expect(result.capped.cx).toEqual([]);
    expect(result.notifications).toEqual([
      {
        providerId: "cx",
        kind: "reset",
        title: "codex is ready",
        body: "7d limit has reset - you can use it again",
      },
    ]);
  });

  test("does not call a provider ready while another limit still blocks it", () => {
    const capped = { ...NONE_CAPPED, cl: ["session", "weekly"] };
    const result = detectLimitChanges(
      capped,
      snapshotWith({
        cl: [limit("session", "current session", 3), limit("weekly", "weekly · all models", 100)],
      }),
      connections(),
    );
    expect(result.capped.cl).toEqual(["weekly"]);
    expect(result.notifications).toEqual([
      {
        providerId: "cl",
        kind: "reset",
        title: "claude code: current session has reset",
        body: "still at the limit: weekly · all models · weekly resets in 2h",
      },
    ]);
  });

  test("treats a limit with no current reading as unchanged, not as reset", () => {
    const capped = { ...NONE_CAPPED, cl: ["weekly"] };
    const stale = detectLimitChanges(
      capped,
      snapshotWith({ cl: [limit("weekly", "weekly · all models", null)] }),
      connections(),
    );
    expect(stale.capped.cl).toEqual(["weekly"]);
    expect(stale.notifications).toEqual([]);

    const missing = detectLimitChanges(capped, snapshotWith({}), connections());
    expect(missing.capped.cl).toEqual(["weekly"]);
    expect(missing.notifications).toEqual([]);
  });

  test("ignores providers whose limits are not being read", () => {
    const snapshot = snapshotWith({ cx: [limit("weekly", "7d limit", 100)] });
    for (const status of ["expired", "none"] as const) {
      const result = detectLimitChanges(NONE_CAPPED, snapshot, connections({ cx: status }));
      expect(result.notifications).toEqual([]);
      expect(result.capped.cx).toEqual([]);
    }
  });

  test("holds the ready notification while the provider still refuses usage", () => {
    const capped = { ...NONE_CAPPED, cx: ["weekly"] };
    const snapshot = snapshotWith({ cx: [limit("weekly", "7d limit", 2)] });
    snapshot.providers.cx.usageBlock = { isBlocked: true, reason: "included usage blocked" };

    const reset = detectLimitChanges(capped, snapshot, connections());
    expect(reset.capped.cx).toEqual(["usage-block"]);
    expect(reset.notifications.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: "codex limit reached", body: "included usage blocked" },
      { title: "codex: 7d limit has reset", body: "still at the limit: included usage blocked" },
    ]);

    snapshot.providers.cx.usageBlock = { isBlocked: false };
    const lifted = detectLimitChanges(reset.capped, snapshot, connections());
    expect(lifted.capped.cx).toEqual([]);
    expect(lifted.notifications.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: "codex is ready", body: "usage is no longer blocked - you can use it again" },
    ]);
  });

  test("keeps a block when the provider gives no verdict", () => {
    const capped = { ...NONE_CAPPED, cx: ["usage-block"] };
    const result = detectLimitChanges(
      capped,
      snapshotWith({ cx: [limit("weekly", "7d limit", 2)] }),
      connections(),
    );
    expect(result.capped.cx).toEqual(["usage-block"]);
    expect(result.notifications).toEqual([]);
  });

  test("labels a local estimate as one", () => {
    const result = detectLimitChanges(
      NONE_CAPPED,
      snapshotWith({ go: [limit("session", "rolling 5h", 100)] }),
      connections({ go: "local" }),
    );
    expect(result.notifications[0]?.body).toContain("local estimate");
  });
});

describe("notifyLimitChanges", () => {
  test("announces a change once even when two processes see it", async () => {
    const path = alertsPath();
    const snapshot = snapshotWith({ cx: [limit("weekly", "7d limit", 100)] });
    const sent: string[] = [];
    const send: SendNotification = async (title) => {
      sent.push(title);
      return { isDelivered: true };
    };

    const dashboard = await notifyLimitChanges(path, snapshot, connections(), send);
    const daemon = await notifyLimitChanges(path, snapshot, connections(), send);

    expect(dashboard.map((delivery) => delivery.notification.title)).toEqual(["codex limit reached"]);
    expect(daemon).toEqual([]);
    expect(sent).toEqual(["codex limit reached"]);
    expect(readCappedLimits(path).cx).toEqual(["weekly"]);
  });

  test("reports a failed delivery without losing the record", async () => {
    const path = alertsPath();
    const deliveries = await notifyLimitChanges(
      path,
      snapshotWith({ go: [limit("monthly", "monthly limit", 100)] }),
      connections(),
      async () => ({ isDelivered: false, reason: "notify-send not found" }),
    );
    expect(deliveries[0]?.result).toEqual({ isDelivered: false, reason: "notify-send not found" });
    expect(readCappedLimits(path).go).toEqual(["monthly"]);
  });

  test("clearing forgets every recorded cap", () => {
    const path = alertsPath();
    writeFileSync(path, JSON.stringify({ version: 1, capped: { cl: ["weekly"], cx: [], go: [] } }));
    expect(readCappedLimits(path).cl).toEqual(["weekly"]);
    clearCappedLimits(path);
    expect(readCappedLimits(path)).toEqual(NONE_CAPPED);
  });

  test("reads a missing or malformed record as nothing capped", () => {
    expect(readCappedLimits("/nonexistent/limit-alerts.json")).toEqual(NONE_CAPPED);
    const path = alertsPath();
    writeFileSync(path, JSON.stringify({ version: 1, capped: { cl: "weekly", cx: [7, "session"] } }));
    expect(readCappedLimits(path)).toEqual({ cl: [], cx: ["session"], go: [] });
  });
});

describe("desktopNotificationCommand", () => {
  test("passes the text to osascript as arguments, never inside the script", () => {
    const command = desktopNotificationCommand('codex "limit"', "7d limit at 100%", "darwin");
    expect(command?.argv[0]).toBe("osascript");
    expect(command?.argv.slice(-2)).toEqual(['codex "limit"', "7d limit at 100%"]);
    expect(command?.argv.filter((part) => part.includes('"limit"'))).toHaveLength(1);
  });

  test("uses notify-send on linux and a WinRT toast on windows", () => {
    expect(desktopNotificationCommand("t", "b", "linux")?.argv).toEqual([
      "notify-send",
      "--app-name",
      "open-usage",
      "t",
      "b",
    ]);
    const windows = desktopNotificationCommand("t", "b", "win32");
    expect(windows?.argv[0]).toBe("powershell.exe");
    expect(windows?.env).toEqual({ OPEN_USAGE_NOTIFY_TITLE: "t", OPEN_USAGE_NOTIFY_BODY: "b" });
  });

  test("has no notifier for an unknown platform", () => {
    expect(desktopNotificationCommand("t", "b", "aix")).toBeNull();
  });
});
