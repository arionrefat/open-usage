import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import pkg from "../package.json";

export const APP_NAME = "open-usage";
export const APP_VERSION = pkg.version;

/** Every file the app owns lives here. Honors $XDG_CONFIG_HOME. */
export function configDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, APP_NAME);
}

export function configPath(
  file: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return join(configDir(env, home), file);
}

/** Shortens $HOME to `~` so paths stay readable in the narrow right-hand readouts. */
export function abbreviateHome(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
export const POLL_INTERVAL_OPTIONS = [1, 2, 3, 4, 5] as const;
export const WARN_THRESHOLD_OPTIONS = [80, 85, 90] as const;
export const DEFAULT_POLL_INTERVAL_MINUTES = 1;
export const DEFAULT_WARN_THRESHOLD = 85;
export const COLOR_MODE_LABEL = "per-provider brand";
