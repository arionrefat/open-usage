import type { SendNotification } from "./desktop";

export interface TerminalNotifier {
  readonly capabilities: { notifications: boolean } | null;
  triggerNotification(message: string, title?: string): boolean;
}

// An escape sequence has no room for structure: a control character would end
// it early, and a semicolon splits OSC 777's title from its body.
function terminalText(text: string): string {
  return text.replace(/\n+/g, " · ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/**
 * The terminal's own notification reaches the machine the user sits at, even
 * over SSH, under the terminal's name and icon; the system notifier covers
 * terminals that have none.
 */
export function preferTerminal(terminal: TerminalNotifier, fallback: SendNotification): SendNotification {
  return async (title, body) => {
    const isSent =
      terminal.capabilities?.notifications === true &&
      terminal.triggerNotification(terminalText(body), terminalText(title).replaceAll(";", ","));
    return isSent ? { isDelivered: true, channel: "terminal" } : fallback(title, body);
  };
}
