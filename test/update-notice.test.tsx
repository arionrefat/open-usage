import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "../src/app";
import { mockUsageProvider } from "../src/data/mock-provider";

const WIDTH = 140;
const HEIGHT = 44;

async function renderFrame(checkUpdate?: () => Promise<string | null>): Promise<string> {
  // The check settles on a microtask after mount, so both the mount and the
  // wait have to happen inside act() for the state update it triggers to be
  // attributed to a scope React knows about.
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <App
        provider={mockUsageProvider}
        startup={{
          screen: "app",
          view: "overview",
          mode: "detailed",
          useSeverityColors: false,
          isDailySplitVisible: true,
        }}
        {...(checkUpdate ? { checkUpdate } : {})}
      />,
      { width: WIDTH, height: HEIGHT },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  try {
    await setup.flush();
    return setup.captureCharFrame();
  } finally {
    act(() => setup.renderer.destroy());
  }
}

test("the header announces a newer published version", async () => {
  const frame = await renderFrame(() => Promise.resolve("0.9.0"));
  expect(frame).toContain("v0.9.0 available");
});

test("the header says nothing when the check reports no newer version", async () => {
  const frame = await renderFrame(() => Promise.resolve(null));
  expect(frame).not.toContain("available");
});

test("a failing check leaves the dashboard untouched rather than surfacing an error", async () => {
  const frame = await renderFrame(() => Promise.reject(new Error("offline")));

  expect(frame).not.toContain("available");
  expect(frame).not.toContain("offline");
  // The rest of the header still renders, so a dead registry costs nothing.
  expect(frame).toContain("OPEN USAGE");
  expect(frame).toContain("3 providers");
});

test("no check runs unless one is injected, so tests and previews stay offline", async () => {
  // The default must not reach the registry: the render harness, `preview.tsx`
  // and `shot.tsx` all construct App without supplying `checkUpdate`.
  const frame = await renderFrame();
  expect(frame).not.toContain("available");
  expect(frame).toContain("OPEN USAGE");
});
