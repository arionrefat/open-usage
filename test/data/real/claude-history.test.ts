import { describe, expect, test } from "bun:test";
import {
  historyStatsFromLines,
  parseHistoryLine,
  readHistoryStats,
} from "../../../src/data/real/claude-history";

describe("parseHistoryLine", () => {
  test("reads timestamp and session id", () => {
    const event = parseHistoryLine(
      '{"display":"/help","timestamp":1785343643895,"sessionId":"abc-123"}',
    );
    expect(event).toEqual({ epochMs: 1_785_343_643_895, sessionId: "abc-123" });
  });

  test("rejects malformed lines", () => {
    expect(parseHistoryLine("not json")).toBeNull();
    expect(parseHistoryLine('{"timestamp":"soon","sessionId":"a"}')).toBeNull();
    expect(parseHistoryLine('{"timestamp":123}')).toBeNull();
  });
});

describe("historyStatsFromLines", () => {
  test("counts prompts and distinct sessions within the window", () => {
    const lines = [
      '{"timestamp":1000,"sessionId":"old"}',
      '{"timestamp":5000,"sessionId":"a"}',
      '{"timestamp":6000,"sessionId":"a"}',
      '{"timestamp":7000,"sessionId":"b"}',
      "garbage",
    ];
    const stats = historyStatsFromLines(lines, 5000);
    expect(stats.prompts).toBe(3);
    expect(stats.sessions).toBe(2);
    expect(stats.latestMs).toBe(7000);
    expect(stats.available).toBe(true);
  });

  test("marks a missing history file unavailable", () => {
    expect(readHistoryStats("/nonexistent/claude-history.jsonl", 0)).toEqual({
      available: false,
      prompts: 0,
      sessions: 0,
      latestMs: 0,
    });
  });
});
