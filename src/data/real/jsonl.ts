import { closeSync, openSync, readSync } from "node:fs";

const CHUNK_BYTES = 1 << 20;
/**
 * A line past this is not one we parse - the records we read are a few KB -
 * and buffering it whole would be the very allocation this reader exists to
 * avoid, so it is skipped rather than assembled.
 */
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const NEWLINE = 10;

export interface MatchingLinesOptions {
  /** Test seam: a small chunk makes lines straddle boundaries. */
  chunkBytes?: number;
  maxLineBytes?: number;
}

/**
 * Yields the lines of a JSONL file that contain one of `markers`, decoded one
 * at a time; with no markers, every line.
 *
 * The file is read through one reused buffer and only matching lines ever
 * become strings, so reading a 65 MB session transcript costs the size of its
 * matching lines rather than the size of the file. Reading it whole did the
 * opposite: the string and its line array grew the heap by twice the file
 * every time the file changed, and the runtime never gave those pages back,
 * which is how a dashboard came to sit at 400 MB for a 2 MB heap.
 */
export function* matchingLines(
  path: string,
  markers: readonly string[],
  options: MatchingLinesOptions = {},
): Generator<string> {
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const needles = markers.map((marker) => Buffer.from(marker, "utf8"));
  const isWanted = (line: Buffer) =>
    needles.length === 0 || needles.some((needle) => line.includes(needle));

  const fd = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(chunkBytes);
  // The part of a line that began in an earlier chunk, copied out because the
  // chunk itself is reused on the next read.
  let carried: Buffer[] = [];
  let carriedBytes = 0;
  // Set once a line outgrows the cap; the rest of it is skipped to its newline.
  let isSkippingLine = false;
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunkBytes, null);
      if (read === 0) break;
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(NEWLINE, start);
        if (newline === -1 || newline >= read) break;
        const tail = chunk.subarray(start, newline);
        start = newline + 1;
        if (isSkippingLine) {
          isSkippingLine = false;
          continue;
        }
        const line = carried.length > 0 ? Buffer.concat([...carried, tail]) : tail;
        carried = [];
        carriedBytes = 0;
        if (isWanted(line)) yield line.toString("utf8");
      }
      if (start >= read || isSkippingLine) continue;
      const rest = chunk.subarray(start, read);
      carriedBytes += rest.length;
      if (carriedBytes > maxLineBytes) {
        carried = [];
        carriedBytes = 0;
        isSkippingLine = true;
        continue;
      }
      carried.push(Buffer.from(rest));
    }
    // A last line without a newline is still a line.
    if (carried.length > 0 && !isSkippingLine) {
      const line = Buffer.concat(carried);
      if (isWanted(line)) yield line.toString("utf8");
    }
  } finally {
    closeSync(fd);
  }
}
