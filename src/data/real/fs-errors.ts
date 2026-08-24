import { isRecord } from "./json";

/** True when a filesystem call failed only because the path is not there. */
export function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
