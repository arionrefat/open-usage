import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import {
  useSecondsSince,
  type SecondsSinceScheduler,
} from "../../src/hooks/use-seconds-since";

class ControlledScheduler implements SecondsSinceScheduler {
  nowMs: number;
  readonly delays: number[] = [];
  readonly cleared: unknown[] = [];
  private nextId = 1;
  private tasks = new Map<number, () => void>();

  constructor(nowMs: number) {
    this.nowMs = nowMs;
  }

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.delays.push(delayMs);
    this.tasks.set(id, callback);
    return id;
  }

  clearTimeout(timer: unknown): void {
    this.cleared.push(timer);
    this.tasks.delete(timer as number);
  }

  runNext(): void {
    const next = this.tasks.entries().next().value as [number, () => void] | undefined;
    if (!next) throw new Error("no timer scheduled");
    this.tasks.delete(next[0]);
    next[1]();
  }

  get timerCount(): number {
    return this.tasks.size;
  }
}

function Clock({ timestamp, scheduler }: { timestamp: number; scheduler: SecondsSinceScheduler }) {
  return <text>{String(useSecondsSince(timestamp, scheduler))}</text>;
}

describe("useSecondsSince", () => {
  test("ticks every second initially, then coarsens to ten seconds", async () => {
    const scheduler = new ControlledScheduler(100_000);
    const setup = await testRender(
      <Clock timestamp={100_000} scheduler={scheduler} />,
      { width: 20, height: 2 },
    );
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("0");
      expect(scheduler.delays).toEqual([1_000]);

      scheduler.nowMs = 101_000;
      act(() => scheduler.runNext());
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("1");
      expect(scheduler.delays.at(-1)).toBe(1_000);

      scheduler.nowMs = 161_000;
      act(() => scheduler.runNext());
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("61");
      expect(scheduler.delays.at(-1)).toBe(10_000);
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("resets immediately when the timestamp changes", async () => {
    const scheduler = new ControlledScheduler(200_000);
    let changeTimestamp: ((timestamp: number) => void) | undefined;
    function Harness() {
      const [timestamp, setTimestamp] = useState(140_000);
      changeTimestamp = setTimestamp;
      return <Clock timestamp={timestamp} scheduler={scheduler} />;
    }
    const setup = await testRender(<Harness />, { width: 20, height: 2 });
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("60");
      act(() => changeTimestamp?.(199_000));
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("1");
      expect(scheduler.cleared).toHaveLength(1);
      expect(scheduler.timerCount).toBe(1);
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("cleans up its pending timer on unmount", async () => {
    const scheduler = new ControlledScheduler(300_000);
    const setup = await testRender(
      <Clock timestamp={300_000} scheduler={scheduler} />,
      { width: 20, height: 2 },
    );
    await setup.flush();
    expect(scheduler.timerCount).toBe(1);
    act(() => setup.renderer.destroy());
    expect(scheduler.cleared).toHaveLength(1);
    expect(scheduler.timerCount).toBe(0);
  });
});
