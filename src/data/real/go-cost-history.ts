import type { GoCostReply, GoCostSpan, GoUsageHistory } from "./opencode-server";
import type { GoBilling, GoCostRow } from "./opencode-usage";

/**
 * Folds one read of the console's cost chart into the days already banked.
 *
 * The chart now answers for 30 days and no further, while the history line
 * shows three calendar months, so every day older than the window exists only
 * because an earlier read banked it. A day is therefore replaced only where
 * the server reports it, and never by its absence: a missing month must read
 * as unknown, not as a month in which nothing was spent.
 */
export interface CostHistory {
  /** The open month first, then the ones before it. */
  months: GoUsageHistory[];
  /** Merged runs of days some read has answered for in full, oldest first. */
  coverage: GoCostSpan[];
  /** True when the reply left out a day with spend it had answered for before. */
  hasCostGap: boolean;
}

export interface BankedCosts {
  months: GoUsageHistory[];
  costCoverage: GoCostSpan[];
}

function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Overlapping or adjacent runs become one, so a month polled daily reads as covered once. */
export function mergeSpans(spans: GoCostSpan[]): GoCostSpan[] {
  const sorted = [...spans].sort((left, right) => left.from.localeCompare(right.from));
  const merged: GoCostSpan[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.from <= addDays(last.until, 1)) {
      if (span.until > last.until) last.until = span.until;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function isInside(date: string, span: GoCostSpan): boolean {
  return date >= span.from && date <= span.until;
}

/** Calendar months as YYYY-MM, the open one first, in local time like every other period label. */
export function recentMonths(now: Date, count: number): string[] {
  return Array.from({ length: count }, (_, monthsAgo) => {
    const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  });
}

export function mergeCostHistory(
  banked: BankedCosts | null,
  reply: GoCostReply,
  now: Date,
  monthCount: number,
): CostHistory {
  // Days banked under another workspace describe someone else's spend.
  const isSameWorkspace = banked?.months[0]?.workspaceId === reply.workspaceId;
  const held = isSameWorkspace ? banked : null;
  const byDate = new Map<string, GoCostRow>();
  for (const month of held?.months ?? []) {
    for (const row of month.costs.rows) byDate.set(row.date, row);
  }

  const reported = new Set(reply.rows.map((row) => row.date));
  // A reply that drops a day with spend it once reported is narrower than it
  // claims, which is exactly how the `since` query broke: trusting its window
  // would mark the lost days as covered and spent-nothing.
  const hasCostGap = [...byDate.values()].some(
    (row) => row.usd > 0 && isInside(row.date, reply.coverage) && !reported.has(row.date),
  );
  for (const row of reply.rows) {
    // The window's cut first day is a partial figure and must not replace a
    // whole one banked earlier.
    if (isInside(row.date, reply.coverage) || !byDate.has(row.date)) byDate.set(row.date, row);
  }

  const months = recentMonths(now, monthCount);
  const oldest = `${months.at(-1)}-01`;
  const coverage = mergeSpans([...(held?.costCoverage ?? []), ...(hasCostGap ? [] : [reply.coverage])])
    .filter((span) => span.until >= oldest);
  // The billing record is one per workspace, not one per month, so only the
  // open month carries it, and a failed read keeps the last good one.
  const billing: GoBilling | null = reply.billing ?? held?.months[0]?.billing ?? null;
  const rows = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));

  return {
    months: months.map((month, monthsAgo) => ({
      costs: { rows: rows.filter((row) => row.date.startsWith(`${month}-`)), keys: [] },
      billing: monthsAgo === 0 ? billing : null,
      workspaceId: reply.workspaceId,
      month,
    })),
    coverage,
    hasCostGap,
  };
}
