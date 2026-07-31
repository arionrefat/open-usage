/** Masks a secret to prefix + bullets + suffix; short keys become all bullets. */
export function maskCredential(raw: string): string {
  return raw.length <= 24
    ? "•".repeat(raw.length)
    : `${raw.slice(0, 4)}${"•".repeat(Math.min(9, raw.length - 8))}${raw.slice(-4)}`;
}
