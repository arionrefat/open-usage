import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateTranscriptLines,
  parseTranscriptLine,
  readClaudeTranscripts,
} from "../../../src/data/real/claude-transcripts";

const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-30T10:15:00.000Z",
  sessionId: "abc",
  message: {
    model: "claude-fable-5",
    usage: {
      input_tokens: 10,
      output_tokens: 200,
      cache_creation_input_tokens: 3_000,
      cache_read_input_tokens: 900_000,
    },
  },
});

/** Cache reads with nothing else: unobserved locally, but it would be silent if it happened. */
const CACHE_ONLY_LINE = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-30T11:15:00.000Z",
  sessionId: "abc",
  message: {
    id: "msg_cache_only",
    model: "claude-fable-5",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 40_000,
    },
  },
});

describe("parseTranscriptLine", () => {
  test("blends input, output and cache writes, holding cache reads out", () => {
    const event = parseTranscriptLine(ASSISTANT_LINE);
    expect(event).not.toBeNull();
    // 10 input + 200 output + 3,000 cache write. The 900,000 cache reads are out.
    expect(event?.tokens).toBe(3_210);
    expect(event?.epochMs).toBe(Date.parse("2026-07-30T10:15:00.000Z"));
  });

  test("still reports cache reads separately, so the split can show them", () => {
    const event = parseTranscriptLine(ASSISTANT_LINE);
    // Held out of `tokens` to match Codex's blended_total (non_cached_input +
    // output) and Anthropic's own weighting - cache reads bill at 10% of input
    // and count nothing toward ITPM - but never discarded: the detail screen's
    // token split needs all four kinds.
    expect(event?.cacheReadTokens).toBe(900_000);
    expect(event?.tokens).toBeLessThan(event!.cacheReadTokens);
  });

  test("keeps an event whose only measured tokens are cache reads", () => {
    // No blended tokens at all, but 40,000 reads really happened. Dropping the
    // row would undercount `cacheRead30d` with nothing on screen to show for it.
    const event = parseTranscriptLine(CACHE_ONLY_LINE);
    expect(event).not.toBeNull();
    expect(event?.tokens).toBe(0);
    expect(event?.cacheReadTokens).toBe(40_000);
  });

  test("skips non-assistant lines cheaply", () => {
    expect(parseTranscriptLine('{"type":"user","message":{}}')).toBeNull();
    expect(parseTranscriptLine("")).toBeNull();
  });

  test("tolerates malformed json and missing fields", () => {
    expect(parseTranscriptLine('{"type":"assistant", broken')).toBeNull();
    expect(parseTranscriptLine('{"type":"assistant"}')).toBeNull();
    expect(
      parseTranscriptLine('{"type":"assistant","timestamp":"nope","message":{"usage":{}}}'),
    ).toBeNull();
    expect(
      parseTranscriptLine(
        '{"type":"assistant","timestamp":"2026-07-30T10:15:00Z","message":{"usage":{"input_tokens":0}}}',
      ),
    ).toBeNull();
  });

  test("does not trip on the marker inside content", () => {
    const decoy = '{"type":"user","content":"{\\"type\\":\\"assistant\\"}"}';
    expect(parseTranscriptLine(decoy)).toBeNull();
  });
});

describe("aggregateTranscriptLines", () => {
  test("buckets by hour and tracks the newest event", () => {
    const second = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-30T10:45:00.000Z",
      message: { usage: { input_tokens: 90, output_tokens: 700 } },
    });
    const { buckets, latestMs } = aggregateTranscriptLines([ASSISTANT_LINE, second, "garbage"]);
    expect(buckets.size).toBe(1); // both fall in the 10:00 UTC hour
    expect([...buckets.values()][0]).toBe(4_000); // 3,210 + 790
    expect(latestMs).toBe(Date.parse("2026-07-30T10:45:00.000Z"));
  });

  test("returns an empty aggregate for empty input", () => {
    const { buckets, latestMs } = aggregateTranscriptLines([]);
    expect(buckets.size).toBe(0);
    expect(latestMs).toBe(0);
  });

  test("banks a re-logged message once", () => {
    const line = (id: string, tokens: number) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-30T10:15:00.000Z",
        message: { id, usage: { output_tokens: tokens } },
      });

    const { events, buckets } = aggregateTranscriptLines([
      line("msg_1", 100),
      line("msg_1", 100),
      line("msg_1", 100),
      line("msg_2", 50),
    ]);
    expect([...buckets.values()][0]).toBe(150);
    expect(events.length).toBe(2);
  });

  test("keeps a cache-only event out of the histogram while banking its reads", () => {
    const { events, buckets } = aggregateTranscriptLines([ASSISTANT_LINE, CACHE_ONLY_LINE]);

    // Both events survive the parse, but only the blended one moves the chart
    // and the burn rate - a zero-token bucket would flatten neither honestly.
    expect(events.length).toBe(2);
    expect(buckets.size).toBe(1);
    expect([...buckets.values()][0]).toBe(3_210);
    expect(events.map((event) => event.cacheReadTokens)).toEqual([900_000, 40_000]);
  });

  test("totals the four token kinds and models for 30 days", () => {
    const line = (id: string, model: string, usage: Record<string, number>) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-30T10:15:00.000Z",
        message: { id, model, usage },
      });
    const { events } = aggregateTranscriptLines([
      line("one", "sonnet", {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      }),
      line("one", "sonnet", { output_tokens: 999 }),
      line("two", "opus", { input_tokens: 5, cache_read_input_tokens: 15 }),
    ]);

    const modelTokens = new Map<string, number>();
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
    for (const event of events) {
      if (event.model) {
        const total = event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;
        modelTokens.set(event.model, (modelTokens.get(event.model) ?? 0) + total);
      }
      input += event.inputTokens;
      output += event.outputTokens;
      cacheRead += event.cacheReadTokens;
      cacheWrite += event.cacheWriteTokens;
    }
    expect(modelTokens).toEqual(new Map([["sonnet", 100], ["opus", 20]]));
    expect({ input, output, cacheRead, cacheWrite }).toEqual({ input: 15, output: 20, cacheRead: 45, cacheWrite: 40 });
  });

  test("still counts messages that carry no id", () => {
    const { buckets } = aggregateTranscriptLines([ASSISTANT_LINE, ASSISTANT_LINE]);
    expect([...buckets.values()][0]).toBe(6_420); // 3,210 counted twice
  });
});

describe("readClaudeTranscripts", () => {
  test("per-model totals sum to the headline total", () => {
    // These once disagreed by the whole cache-read volume - the overview read
    // 68M while the detail screen's own bars summed to 2.7B off the same events.
    const now = new Date("2026-07-30T12:00:00.000Z");
    const line = (model: string, usage: Record<string, number>) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-30T10:15:00.000Z",
        message: { id: `msg_${model}_${usage.output_tokens}`, model, usage },
      });
    const dir = mkdtempSync(join(tmpdir(), "open-usage-transcripts-"));
    writeFileSync(
      join(dir, "a.jsonl"),
      [
        line("opus", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 900_000 }),
        line("sonnet", { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 400 }),
      ].join("\n"),
    );

    const { modelTokens, tokenSplit, buckets } = readClaudeTranscripts(dir, now);
    const modelSum = [...modelTokens.values()].reduce((a, b) => a + b, 0);
    const bucketSum = [...buckets.values()].reduce((a, b) => a + b, 0);
    const blended = tokenSplit.input + tokenSplit.output + tokenSplit.cacheWrite;

    expect(modelSum).toBe(blended);
    expect(bucketSum).toBe(blended);
    // The cache reads are still measured, just held out of the blended figure.
    expect(tokenSplit.cacheRead).toBe(900_000);
  });
});
