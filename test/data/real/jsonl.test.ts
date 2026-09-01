import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchingLines } from "../../../src/data/real/jsonl";

function withFile(content: string, run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "open-usage-jsonl-"));
  try {
    const path = join(directory, "records.jsonl");
    writeFileSync(path, content);
    run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("matchingLines", () => {
  test("yields only the lines carrying a marker, whichever chunk boundaries they cross", () => {
    const lines = Array.from({ length: 200 }, (_, index) =>
      index % 3 === 0
        ? `{"type":"assistant","n":${index},"pad":"${"x".repeat(index % 17)}"}`
        : `{"type":"user","n":${index},"pad":"${"y".repeat(index % 23)}"}`,
    );
    withFile(`${lines.join("\n")}\n`, (path) => {
      // A chunk far smaller than a line, so every line straddles several.
      const found = [...matchingLines(path, ['"type":"assistant"'], { chunkBytes: 16 })];
      expect(found).toEqual(lines.filter((line) => line.includes('"type":"assistant"')));
      expect(found).toHaveLength(67);
    });
  });

  test("keeps a multibyte character that straddles a chunk boundary intact", () => {
    const line = `{"type":"assistant","text":"${"é".repeat(40)}"}`;
    withFile(`${line}\n`, (path) => {
      expect([...matchingLines(path, ['"type":"assistant"'], { chunkBytes: 7 })]).toEqual([line]);
    });
  });

  test("yields every line when no marker is given, including a last line without a newline", () => {
    withFile('{"a":1}\n{"b":2}\n{"c":3}', (path) => {
      expect([...matchingLines(path, [], { chunkBytes: 5 })]).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    });
  });

  test("matches any of several markers", () => {
    withFile('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n', (path) => {
      expect([...matchingLines(path, ['"type":"a"', '"type":"c"'])]).toEqual(['{"type":"a"}', '{"type":"c"}']);
    });
  });

  test("skips a line past the size cap and picks up again after it", () => {
    const huge = `{"type":"assistant","blob":"${"z".repeat(500)}"}`;
    withFile(`{"type":"assistant","n":1}\n${huge}\n{"type":"assistant","n":2}\n`, (path) => {
      const found = [...matchingLines(path, ['"type":"assistant"'], { chunkBytes: 64, maxLineBytes: 100 })];
      expect(found).toEqual(['{"type":"assistant","n":1}', '{"type":"assistant","n":2}']);
    });
  });

  test("an empty file yields nothing", () => {
    withFile("", (path) => {
      expect([...matchingLines(path, [])]).toEqual([]);
    });
  });
});
