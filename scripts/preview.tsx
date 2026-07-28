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
import { mockUsageProvider } from "../src/data/mock-provider";
import { VIEW_KEYS, type OverviewMode, type Screen, type ViewKey } from "../src/state/app-state";

const DEFAULT_WIDTH = 140;
const DEFAULT_HEIGHT = 46;

function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const [name, inlineValue] = arg.slice(2).split("=", 2);
    if (name) flags.set(name, inlineValue ?? argv[++i] ?? "");
  }
  return flags;
}

// React's act() advisory is noise here — this harness drives real input, not a test.
const reportError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("act(...)")) return;
  reportError(...args);
};

const flags = readFlags(process.argv.slice(2));
const view = flags.get("view");
const mode = flags.get("mode");

const setup = await testRender(
  <App
    provider={mockUsageProvider}
    startup={{
      screen: (flags.get("screen") === "onboarding" ? "onboarding" : "app") as Screen,
      view: (VIEW_KEYS.includes(view as ViewKey) ? view : "overview") as ViewKey,
      mode: (mode === "simple" ? "simple" : "detailed") as OverviewMode,
      useSeverityColors: flags.has("severity-colors"),
      isDailySplitVisible: !flags.has("no-daily-split"),
    }}
  />,
  {
    width: Number(flags.get("width") ?? DEFAULT_WIDTH),
    height: Number(flags.get("height") ?? DEFAULT_HEIGHT),
  },
);

/** React commits the dispatch on a later task, so let the loop drain first. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await setup.flush();
}

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

console.log(setup.captureCharFrame());
process.exit(0);
