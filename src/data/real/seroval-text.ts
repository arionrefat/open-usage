import { timestampMs } from "./json";

/**
 * Field scanners for seroval's serialized-JavaScript responses.
 *
 * The payload is executable JS, not JSON: keys are unquoted, repeated values are
 * bound as `$R[n]=`, booleans are minified to `!0` / `!1`, and dates arrive as
 * live `new Date(...)` constructors. Reading it as JSON yields nothing, so these
 * scan the text directly.
 */

/** A value may be introduced by a back-reference binding before its literal. */
const BINDING = String.raw`(?:\$R\[\d+\]\s*=\s*)?`;

interface Range {
  start: number;
  end: number;
}

/**
 * Every balanced `{...}` span, innermost first, skipping braces inside strings.
 * Closing order guarantees a nested object is reported before its parent, which
 * is what lets a caller keep rows and discard the envelope wrapping them.
 */
function balancedRanges(text: string): Range[] {
  const open: number[] = [];
  const ranges: Range[] = [];
  let quote: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") open.push(index);
    else if (char === "}") {
      const start = open.pop();
      if (start !== undefined) ranges.push({ start, end: index });
    }
  }
  return ranges;
}

/**
 * Object literals carrying every required key. A span containing an already
 * accepted one is skipped, so an enclosing response object is never mistaken for
 * a row just because a row inside it matched.
 */
export function objectLiterals(text: string, required: string[]): string[] {
  const accepted: Range[] = [];
  const blocks: string[] = [];
  const keyPatterns = required.map((key) => new RegExp(String.raw`\b${key}\s*:`));

  for (const range of balancedRanges(text)) {
    const enclosesAcceptedBlock = accepted.some(
      (inner) => inner.start >= range.start && inner.end <= range.end,
    );
    if (enclosesAcceptedBlock) continue;
    const block = text.slice(range.start, range.end + 1);
    if (!keyPatterns.every((pattern) => pattern.test(block))) continue;
    accepted.push(range);
    blocks.push(block);
  }
  return blocks;
}

function hasKey(block: string, key: string): boolean {
  return new RegExp(String.raw`\b${key}\s*:`).test(block);
}

/** True only for a present value that is neither null nor false. */
export function hasValue(block: string, key: string): boolean {
  return hasKey(block, key) && !new RegExp(String.raw`\b${key}\s*:\s*(null|false|!1|undefined)`).test(block);
}

export function stringField(block: string, key: string): string | null {
  return new RegExp(String.raw`\b${key}\s*:\s*"([^"]*)"`).exec(block)?.[1] ?? null;
}

export function numberField(block: string, key: string): number | null {
  const raw = new RegExp(String.raw`\b${key}\s*:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)`, "i").exec(
    block,
  )?.[1];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Minification writes booleans as `!0` and `!1`, so a bare `true` scan misses them. */
export function booleanField(block: string, key: string): boolean {
  const raw = new RegExp(String.raw`\b${key}\s*:\s*(true|false|!0|!1)`).exec(block)?.[1];
  return raw === "true" || raw === "!0";
}

/**
 * Reads `key:$R[2]=new Date("...")` as well as a plain number or quoted string,
 * since the constructor form is what the wire actually carries.
 */
export function timestampField(block: string, key: string): number | null {
  const iso = new RegExp(
    String.raw`\b${key}\s*:\s*${BINDING}new Date\(\s*"([^"]*)"\s*\)`,
  ).exec(block)?.[1];
  if (iso !== undefined) return timestampMs(iso);
  return timestampMs(numberField(block, key)) ?? timestampMs(stringField(block, key));
}

/**
 * The object literal bound to a key, scoped so it cannot run past its own
 * braces. The literal must follow the key directly, optionally through a
 * `$R[n]=` binding: a repeated value is emitted as a bare `$R[n]` with no
 * literal of its own, and scanning onward would read the next key's values.
 */
export function objectAtKey(text: string, key: string): string | null {
  return new RegExp(String.raw`\b${key}\s*:\s*${BINDING}\{[^{}]*\}`).exec(text)?.[0] ?? null;
}

/** True when a key holds an explicitly empty array, e.g. `usage:$R[1]=[]`. */
export function isEmptyArrayAtKey(text: string, key: string): boolean {
  return new RegExp(String.raw`\b${key}\s*:\s*${BINDING}\[\s*\]`).test(text);
}
