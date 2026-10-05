import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { configPath } from "../config";
import { isRecord } from "../data/real/json";
import {
  byProvider,
  PROVIDER_IDS,
  type ProviderConnection,
  type ProviderId,
  type ProviderUsage,
  type UsageBlock,
  type UsageLimit,
  type UsageSnapshot,
} from "../data/types";
import { withFileLock } from "../lib/file-lock";
import { isProviderLive } from "../state/app-state";
import type { DeliveryResult, SendNotification } from "./desktop";

const CAP_PERCENT = 100;

/** Sent from the setup wizard, so permission problems surface before a real alert is missed. */
export const TEST_NOTIFICATION = {
  title: "open-usage notifications are on",
  body: "you will hear from us when a limit runs out, and again when it resets",
};

/** Limit ids each provider last reported at or past its cap. */
export type CappedLimits = Record<ProviderId, string[]>;

export interface LimitNotification {
  providerId: ProviderId;
  kind: "reached" | "reset";
  title: string;
  body: string;
}

export interface LimitDelivery {
  notification: LimitNotification;
  result: DeliveryResult;
}

export function defaultLimitAlertsPath(): string {
  return configPath("limit-alerts.json");
}

function emptyCappedLimits(): CappedLimits {
  return byProvider(() => []);
}

export function readCappedLimits(path: string): CappedLimits {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.capped)) {
      return emptyCappedLimits();
    }
    const capped = parsed.capped;
    return byProvider((id) => {
      const ids = capped[id];
      return Array.isArray(ids) ? ids.filter((value): value is string => typeof value === "string") : [];
    });
  } catch {
    return emptyCappedLimits();
  }
}

function writeCappedLimitsFile(path: string, capped: CappedLimits): void {
  let temporary: string | null = null;
  try {
    temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify({ version: 1, capped })}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (temporary) rmSync(temporary, { force: true });
  }
}

/**
 * Forgets every recorded cap. Run when notifications are switched on, because
 * a record left from before they were switched off would otherwise announce a
 * reset that happened while nobody was watching.
 */
export function clearCappedLimits(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  withFileLock(path, () => writeCappedLimitsFile(path, emptyCappedLimits()));
}

/** The record's id for a provider-wide block, kept apart from every meter id. */
const BLOCK_ID = "usage-block";

/**
 * Anything that can stop a provider: one of its meters, or its own verdict
 * that it is refusing usage, which can outlive every meter's reset.
 */
interface Gate {
  id: string;
  label: string;
  /** null when there is no current reading. */
  isCapped: boolean | null;
  /** The line announcing it reached. */
  reachedText: string;
  /** The line naming it as what still blocks a partial reset. */
  blockingText: string;
}

function meterGate(limit: UsageLimit): Gate {
  const label = limit.detailLabel ?? limit.label;
  const reset = limit.resetLong ?? limit.reset;
  return {
    id: limit.id,
    label,
    isCapped: limit.percent === null ? null : limit.percent >= CAP_PERCENT,
    reachedText: `${label} at ${limit.percent}% · ${reset}`,
    blockingText: `${label} · ${reset}`,
  };
}

function blockGate(block: UsageBlock): Gate {
  const reason = block.isBlocked ? block.reason : "usage blocked";
  return { id: BLOCK_ID, label: reason, isCapped: block.isBlocked, reachedText: reason, blockingText: reason };
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function clearedPhrase(cleared: Gate[]): string {
  const meters = cleared.filter((gate) => gate.id !== BLOCK_ID).map((gate) => gate.label);
  const parts: string[] = [];
  if (meters.length > 0) parts.push(`${joinLabels(meters)} ${meters.length === 1 ? "has" : "have"} reset`);
  if (cleared.some((gate) => gate.id === BLOCK_ID)) parts.push("usage is no longer blocked");
  return parts.join(" and ");
}

function reachedNotification(
  id: ProviderId,
  usage: ProviderUsage,
  reached: Gate[],
  isEstimate: boolean,
): LimitNotification {
  const lines = reached.map((gate) => gate.reachedText);
  if (isEstimate) lines.push("local estimate - a dashboard cookie gives exact limits");
  return {
    providerId: id,
    kind: "reached",
    title: `${usage.meta.name} limit reached`,
    body: lines.join("\n"),
  };
}

function resetNotification(
  id: ProviderId,
  usage: ProviderUsage,
  cleared: Gate[],
  stillCapped: Gate[],
): LimitNotification {
  const phrase = clearedPhrase(cleared);
  if (stillCapped.length === 0) {
    return {
      providerId: id,
      kind: "reset",
      title: `${usage.meta.name} is ready`,
      body: `${phrase} - you can use it again`,
    };
  }
  // A partial reset is worth hearing about, but calling the provider ready
  // while something else still blocks it would send someone back to a tool
  // that refuses them.
  return {
    providerId: id,
    kind: "reset",
    title: `${usage.meta.name}: ${phrase}`,
    body: `still at the limit: ${stillCapped.map((gate) => gate.blockingText).join("; ")}`,
  };
}

/**
 * A gate is capped once it reads capped and stays so until a reading shows it
 * clear. One with no current reading - stale, or a source that went quiet -
 * keeps its last state, since "unknown" is not evidence of a reset.
 */
function providerChanges(
  id: ProviderId,
  previous: string[],
  usage: ProviderUsage,
  connection: ProviderConnection,
): { capped: string[]; notifications: LimitNotification[] } {
  if (!isProviderLive(connection)) return { capped: previous, notifications: [] };

  const gates = [
    ...usage.limits.map(meterGate),
    ...(usage.usageBlock ? [blockGate(usage.usageBlock)] : []),
  ];
  const reached = gates.filter((gate) => gate.isCapped === true && !previous.includes(gate.id));
  const cleared = gates.filter((gate) => gate.isCapped === false && previous.includes(gate.id));
  const clearedIds = new Set(cleared.map((gate) => gate.id));
  const capped = [...previous.filter((gateId) => !clearedIds.has(gateId)), ...reached.map((gate) => gate.id)];

  const notifications: LimitNotification[] = [];
  if (reached.length > 0) {
    notifications.push(reachedNotification(id, usage, reached, connection.status === "local"));
  }
  if (cleared.length > 0) {
    // A capped id with no gate this time - a lane that stopped being reported -
    // still blocks, so it is named by its id rather than dropped.
    const stillCapped = capped.map(
      (gateId) =>
        gates.find((gate) => gate.id === gateId) ??
        { id: gateId, label: gateId, isCapped: null, reachedText: gateId, blockingText: gateId },
    );
    notifications.push(resetNotification(id, usage, cleared, stillCapped));
  }
  return { capped, notifications };
}

export function detectLimitChanges(
  previous: CappedLimits,
  snapshot: UsageSnapshot,
  connections: Record<ProviderId, ProviderConnection>,
): { capped: CappedLimits; notifications: LimitNotification[] } {
  const changes = byProvider((id) =>
    providerChanges(id, previous[id], snapshot.providers[id], connections[id]),
  );
  return {
    capped: byProvider((id) => changes[id].capped),
    notifications: PROVIDER_IDS.flatMap((id) => changes[id].notifications),
  };
}

function isSameCapped(left: CappedLimits, right: CappedLimits): boolean {
  return PROVIDER_IDS.every(
    (id) => left[id].length === right[id].length && left[id].every((limitId) => right[id].includes(limitId)),
  );
}

/**
 * Compares a fresh snapshot against the shared record and sends whatever
 * changed. The dashboard and the daemon both call this after every refresh;
 * the record is read and written under one lock, so whichever sees a change
 * first announces it and the other finds it already recorded.
 */
export async function notifyLimitChanges(
  path: string,
  snapshot: UsageSnapshot,
  connections: Record<ProviderId, ProviderConnection>,
  send: SendNotification,
): Promise<LimitDelivery[]> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const notifications = withFileLock(path, () => {
    const previous = readCappedLimits(path);
    const changes = detectLimitChanges(previous, snapshot, connections);
    if (!isSameCapped(previous, changes.capped)) writeCappedLimitsFile(path, changes.capped);
    return changes.notifications;
  });
  return Promise.all(
    notifications.map(async (notification) => ({
      notification,
      result: await send(notification.title, notification.body),
    })),
  );
}
