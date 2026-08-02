import { describe, expect, test } from "bun:test";
import { aggregateTranscriptLines, parseTranscriptLine } from "../../../src/data/real/claude-transcripts";

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

describe("parseTranscriptLine", () => {
  test("counts input, output, and cache writes but not cache reads", () => {
    const event = parseTranscriptLine(ASSISTANT_LINE);
    expect(event).not.toBeNull();
    expect(event?.tokens).toBe(3_210);
    expect(event?.epochMs).toBe(Date.parse("2026-07-30T10:15:00.000Z"));
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
    expect([...buckets.values()][0]).toBe(4_000);
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

    // Claude Code re-logs a message as it streams; on real transcripts this
    // triple-counting inflated totals by about 3x.
    const { buckets } = aggregateTranscriptLines([
      line("msg_1", 100),
      line("msg_1", 100),
      line("msg_1", 100),
      line("msg_2", 50),
    ]);
    expect([...buckets.values()][0]).toBe(150);
  });

  test("still counts messages that carry no id", () => {
    const { buckets } = aggregateTranscriptLines([ASSISTANT_LINE, ASSISTANT_LINE]);
    expect([...buckets.values()][0]).toBe(6_420);
  });
});
