import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { mockUsageProvider } from "./data/mock-provider";
import { readFlags, startupFromFlags } from "./lib/args";
import { COLORS } from "./theme";

const startup = startupFromFlags(readFlags(process.argv.slice(2)));
const renderer = await createCliRenderer({
  targetFps: 30,
  useMouse: true,
  exitOnCtrlC: false,
  screenMode: "alternate-screen",
  backgroundColor: COLORS.bg,
});
createRoot(renderer).render(<App provider={mockUsageProvider} startup={startup} />);
