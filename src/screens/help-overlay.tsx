import { APP_NAME, APP_VERSION, POLL_INTERVAL_SECONDS } from "../config";
import { padEnd } from "../lib/text";
import { COLORS } from "../theme";
import { Line, Rule, SplitLine, Spacer, leftClick } from "../components/primitives";

const PANEL_WIDTH = 62;
const KEY_COLUMN = 12;
/** Translucent scrim so the app behind the keymap reads as backgrounded. */
const SCRIM_COLOR = "#050505b8";

const KEYMAP: Array<[string, string]> = [
  ["1 – 5", "jump to view · 5 is settings"],
  ["o", "re-run the setup wizard"],
  ["tab", "cycle views forward"],
  ["m", "overview mode · simplified / detailed"],
  ["w", "window · session / weekly (simplified only)"],
  ["j / k", "move between providers"],
  ["↵", "open selected provider"],
  ["t", "cycle range · today / 7d / 30d / month / all"],
  ["r", "refresh all providers"],
  ["/", "filter providers by name"],
  ["?", "this help"],
  ["q", "quit"],
];

interface HelpOverlayProps {
  width: number;
  height: number;
  onClose: () => void;
}

export function HelpOverlay({ width, height, onClose }: HelpOverlayProps) {
  const margin = width >= 4 ? 2 : 0;
  const panelWidth = Math.max(1, Math.min(PANEL_WIDTH, width - margin * 2));
  const hasFrame = panelWidth >= 4;
  const panelPadding = hasFrame ? 1 : 0;
  const innerWidth = Math.max(1, panelWidth - (hasFrame ? 2 : 0) - panelPadding * 2);
  const isNarrow = innerWidth < 32;
  const contentHeight = KEYMAP.length * (isNarrow ? 2 : 1) + 8;
  const panelHeight = Math.max(1, Math.min(contentHeight, height));

  return (
    <>
      <box
        position="absolute"
        top={0}
        left={0}
        width={width}
        height={height}
        backgroundColor={SCRIM_COLOR}
        zIndex={40}
        onMouseDown={leftClick(onClose)}
      />
      <box
        position="absolute"
        top={Math.max(0, Math.floor((height - panelHeight) / 2))}
        left={Math.max(0, Math.floor((width - panelWidth) / 2))}
        width={panelWidth}
        height={panelHeight}
        flexDirection="column"
        border={hasFrame}
        borderColor={COLORS.borderPanel}
        backgroundColor={COLORS.bgChrome}
        paddingLeft={panelPadding}
        paddingRight={panelPadding}
        zIndex={50}
      >
        <scrollbox flexGrow={1} scrollX={false} contentOptions={{ flexDirection: "column" }}>
          <SplitLine
            width={innerWidth}
            background={COLORS.bgChrome}
            left={[{ text: "keymap", color: COLORS.textBright, isBold: true }]}
            right={[{ text: "esc to close", color: COLORS.textGhost, onClick: onClose }]}
          />
          <Spacer />
          {KEYMAP.map(([key, description]) => (
            <box key={key} flexDirection="column" flexShrink={0}>
              <Line
                width={innerWidth}
                background={COLORS.bgChrome}
                segments={[
                  {
                    text: isNarrow ? key : padEnd(key, KEY_COLUMN),
                    color: COLORS.accent,
                    background: COLORS.bgChrome,
                  },
                  ...(isNarrow
                    ? []
                    : [{ text: description, color: COLORS.textMuted, background: COLORS.bgChrome }]),
                ]}
              />
              {isNarrow ? (
                <Line
                  width={innerWidth}
                  background={COLORS.bgChrome}
                  segments={[{ text: description, color: COLORS.textMuted, background: COLORS.bgChrome }]}
                />
              ) : null}
            </box>
          ))}
          <Spacer />
          <Rule width={innerWidth} />
          <Line
            width={innerWidth}
            background={COLORS.bgChrome}
            segments={[
              {
                text: `${APP_NAME} v${APP_VERSION} · @opentui/react · polls every ${POLL_INTERVAL_SECONDS}s`,
                color: COLORS.textGhost,
                background: COLORS.bgChrome,
              },
            ]}
          />
        </scrollbox>
      </box>
    </>
  );
}
