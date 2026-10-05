import type { GoCostReply, GoCostSpan, GoUsageHistory } from "./opencode-server";
import type { GoBilling, GoCostRow } from "./opencode-usage";

/**
 * The chart answers for 30 days while the history shows three months, so older
 * days exist only because an earlier read banked them, and absence never erases one.
 */
export interface CostHistory {
  months: GoUsageHistory[];
  coverage: GoCostSpan[];
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

/** Local months, like every other period label, though the chart dates its days in UTC. */
function recentMonths(now: Date, count: number): string[] {
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
  // How the `since` query broke: a reply narrower than its window. Trusting it
  // would mark the dropped days as covered and unspent.
  const hasCostGap = [...byDate.values()].some(
    (row) => row.usd > 0 && isInside(row.date, reply.coverage) && !reported.has(row.date),
  );
  for (const row of reply.rows) {
    // Before the window starts the figure is partial and must not replace a whole one.
    if (isInside(row.date, reply.coverage) || !byDate.has(row.date)) byDate.set(row.date, row);
  }

  const months = recentMonths(now, monthCount);
  const oldest = `${months.at(-1)}-01`;
  const coverage = mergeSpans([...(held?.costCoverage ?? []), ...(hasCostGap ? [] : [reply.coverage])])
    .filter((span) => span.until >= oldest);
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
