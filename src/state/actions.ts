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
  openProvider(id: ProviderId): void;
  moveSelection(delta: number): void;
  openSelected(): void;
  cycleView(): void;
  refresh(): void;
  startFilter(): void;
  toggleHelp(): void;
  closeHelp(): void;
  openOnboarding(): void;
  /** Moves the onboarding cursor to a row and flips its checkbox. */
  onboardingPick(index: number): void;
  onboardingContinue(): void;
  onboardingFinish(): void;
  settingsToggle(id: ProviderId): void;
  /** Cycles active → expired → none → active in place, adjusting the credential. */
  settingsCycleStatus(id: ProviderId): void;
  /** Applies a fresh (mock) credential and revives the provider instantly. */
  settingsPasteKey(id: ProviderId): void;
  settingsDisconnect(id: ProviderId): void;
  quit(): void;
}
