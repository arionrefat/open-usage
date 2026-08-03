import pkg from "../package.json";

export const APP_NAME = "limitless";
export const APP_VERSION = pkg.version;
export const POLL_INTERVAL_OPTIONS = [1, 2, 3, 4, 5] as const;
export const WARN_THRESHOLD_OPTIONS = [80, 85, 90] as const;
export const DEFAULT_POLL_INTERVAL_MINUTES = 1;
export const DEFAULT_WARN_THRESHOLD = 85;
export const COLOR_MODE_LABEL = "per-provider brand";
