import type { ProviderConnection, ProviderId, ProviderUsage, UsageSnapshot } from "../data/types";
import { CAP_PERCENT } from "../notifications/limit-alerts";
import { hasResetSinceRead, reportedLimits, shownProviderIds } from "./report";

export const CHECK_EXIT_OK = 0;
export const CHECK_EXIT_NEAR_LIMIT = 10;
export const CHECK_EXIT_CAPPED = 11;
export const CHECK_EXIT_NO_DATA = 20;

function currentPercents(provider: ProviderUsage, nowMs: number): number[] {
  return reportedLimits(provider)
    .filter((limit) => !hasResetSinceRead(limit, nowMs))
    .map((limit) => limit.percent)
    .filter((percent): percent is number => percent !== null);
}

/** Judges every limit rather than the headline ones: a capped model lane still stops work. */
export function checkExitCode(
  snapshot: UsageSnapshot,
  connections: Record<ProviderId, ProviderConnection>,
  now: Date,
  warnThreshold: number,
): number {
  const providers = shownProviderIds(connections).map((id) => snapshot.providers[id]);
  if (providers.some((provider) => provider.usageBlock?.isBlocked)) return CHECK_EXIT_CAPPED;
  const percents = providers.flatMap((provider) => currentPercents(provider, now.getTime()));
  if (percents.length === 0) return CHECK_EXIT_NO_DATA;
  const tightest = Math.max(...percents);
  if (tightest >= CAP_PERCENT) return CHECK_EXIT_CAPPED;
  return tightest >= warnThreshold ? CHECK_EXIT_NEAR_LIMIT : CHECK_EXIT_OK;
}
