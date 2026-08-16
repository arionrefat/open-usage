import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { FilterBar } from "../src/components/chrome";

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
