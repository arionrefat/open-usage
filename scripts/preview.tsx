/**
 * Headless screenshot harness: renders the TUI into an off-screen buffer and
 * prints the resulting character frame, so screens can be reviewed without a TTY.
 *
 *   bun scripts/preview.tsx --view settings --width 140
 *   bun scripts/preview.tsx --screen onboarding --keys j,SPACE,ENTER
 *   bun scripts/preview.tsx --clicks "20,3;40,6"   # left-click at column,row
 */
import { testRender } from "@opentui/react/test-utils";
import { App } from "../src/app";
import { selectUsageProvider } from "../src/data/real-provider";
import { providerModeFromFlags, readFlags, startupFromFlags } from "../src/lib/args";

const DEFAULT_WIDTH = 140;
const DEFAULT_HEIGHT = 46;
const INPUT_SETTLE_MS = 30;

// React's act() advisory is noise here — this harness drives real input, not a test.
const reportError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("act(...)")) return;
  reportError(...args);
};

const flags = readFlags(process.argv.slice(2));

// Previews stay deterministic on the mock; pass --real to read local sources.
const provider = selectUsageProvider(providerModeFromFlags(flags, "mock"));

const setup = await testRender(
  <App
    provider={provider}
    startup={startupFromFlags(flags)}
  />,
  {
    width: Number(flags.get("width") ?? DEFAULT_WIDTH),
    height: Number(flags.get("height") ?? DEFAULT_HEIGHT),
  },
);

/** React commits the dispatch on a later task, so let the loop drain first. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, INPUT_SETTLE_MS));
  await setup.flush();
}

let frame = "";
try {
  await settle();

  for (const click of (flags.get("clicks") ?? "").split(";").filter(Boolean)) {
    const [x, y] = click.split(",").map(Number);
    await setup.mockMouse.click(Number(x), Number(y));
    await settle();
  }

  for (const key of (flags.get("keys") ?? "").split(",").filter(Boolean)) {
    if (key === "ENTER") setup.mockInput.pressEnter();
    else if (key === "TAB") setup.mockInput.pressTab();
    else if (key === "ESC") setup.mockInput.pressEscape();
    else if (key === "SPACE") setup.mockInput.pressKey(" ");
    else setup.mockInput.pressKey(key);
    await settle();
  }

  frame = setup.captureCharFrame();
} finally {
  setup.renderer.destroy();
}

console.log(frame);
