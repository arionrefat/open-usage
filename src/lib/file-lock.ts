import { Database } from "bun:sqlite";

const TIMEOUT_MS = 2_000;

/** Serializes short synchronous file updates across running app instances. */
export function withFileLock<T>(targetPath: string, update: () => T): T {
  const database = new Database(`${targetPath}.lock`, { create: true });
  try {
    database.run(`PRAGMA busy_timeout = ${TIMEOUT_MS}`);
    database.run("BEGIN IMMEDIATE");
    try {
      const result = update();
      database.run("COMMIT");
      return result;
    } catch (error) {
      database.run("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
