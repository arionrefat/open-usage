import type { ProviderId, ScopeKey } from "../data/types";
import type { OverviewMode, ViewKey } from "./app-state";

/**
 * Everything a pointer can trigger. Screens receive this instead of `dispatch`
 * so mouse targets and key bindings always resolve to the same behavior.
 */
export interface AppActions {
  setView(view: ViewKey): void;
  cycleRange(): void;
  setMode(mode: OverviewMode): void;
  toggleMode(): void;
  setScope(scope: ScopeKey): void;
  toggleScope(): void;
  selectProvider(id: ProviderId): void;
  refresh(): void;
  startFilter(): void;
  toggleHelp(): void;
  closeHelp(): void;
  openOnboarding(): void;
  /** Moves the onboarding cursor to a row and flips its checkbox. */
  onboardingPick(index: number): void;
  onboardingContinue(): void;
  onboardingFinish(): void;
  quit(): void;
}
