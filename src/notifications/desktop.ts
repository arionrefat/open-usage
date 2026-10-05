import { APP_NAME } from "../config";
import { createSubprocessGuard, subprocessEnvironment } from "../data/real/subprocess";

const SEND_TIMEOUT_MS = 5_000;

export interface NotificationCommand {
  argv: string[];
  env?: Record<string, string>;
}

export type DeliveryResult = { isDelivered: true } | { isDelivered: false; reason: string };

export type SendNotification = (title: string, body: string) => Promise<DeliveryResult>;

// No stock toast cmdlet exists; WinRT shows one under PowerShell's own app id.
const WINDOWS_TOAST_SCRIPT = [
  "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$text = $template.GetElementsByTagName('text')",
  "$null = $text.Item(0).AppendChild($template.CreateTextNode($env:OPEN_USAGE_NOTIFY_TITLE))",
  "$null = $text.Item(1).AppendChild($template.CreateTextNode($env:OPEN_USAGE_NOTIFY_BODY))",
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($template))",
].join("; ");

export function desktopNotificationCommand(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
): NotificationCommand | null {
  if (platform === "darwin") {
    // The text travels as argv rather than inside the script, so a quote in a
    // label cannot end the AppleScript string early.
    return {
      argv: [
        "osascript",
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
      ],
    };
  }
  if (platform === "win32") {
    return {
      argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TOAST_SCRIPT],
      env: { OPEN_USAGE_NOTIFY_TITLE: title, OPEN_USAGE_NOTIFY_BODY: body },
    };
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    return { argv: ["notify-send", "--app-name", APP_NAME, title, body] };
  }
  return null;
}

export const sendDesktopNotification: SendNotification = async (title, body) => {
  const command = desktopNotificationCommand(title, body);
  if (!command) return { isDelivered: false, reason: `no notifier on ${process.platform}` };
  const notifier = command.argv[0]!;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command.argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...subprocessEnvironment(), ...command.env },
      windowsHide: true,
    });
  } catch {
    return { isDelivered: false, reason: `${notifier} not found` };
  }

  const guard = createSubprocessGuard(proc, {
    timeoutMs: SEND_TIMEOUT_MS,
    timeoutError: () => new Error(`${notifier} did not respond`),
  });
  try {
    const exitCode = await guard.waitFor(proc.exited);
    return exitCode === 0
      ? { isDelivered: true }
      : { isDelivered: false, reason: `${notifier} exited with ${exitCode}` };
  } catch (error) {
    return {
      isDelivered: false,
      reason: error instanceof Error ? error.message : `${notifier} failed`,
    };
  } finally {
    guard.dispose();
  }
};
