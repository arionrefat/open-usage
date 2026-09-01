import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { FilterBar, updatedAgeLabel } from "../src/components/chrome";

describe("filter bar", () => {
  test("owns and renders its cursor blink in the leaf component", async () => {
    const setup = await testRender(<FilterBar width={80} query="codex" matchCount={1} />, {
      width: 80,
      height: 3,
    });

    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("/ codex█");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 550));
      });
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("/ codex█");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
});

describe("header age", () => {
  test("counts seconds only while they still mean something", () => {
    expect(updatedAgeLabel(0)).toBe("just now");
    expect(updatedAgeLabel(4)).toBe("just now");
    expect(updatedAgeLabel(5)).toBe("5s ago");
    expect(updatedAgeLabel(59)).toBe("55s ago");
    expect(updatedAgeLabel(60)).toBe("1m ago");
    expect(updatedAgeLabel(4 * 60 + 30)).toBe("4m ago");
    expect(updatedAgeLabel(2 * 3600 + 10 * 60)).toBe("2h 10m ago");
    expect(updatedAgeLabel(3 * 86400 + 5 * 3600)).toBe("3d 5h ago");
  });
});
