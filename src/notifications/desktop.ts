import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import bundledIcon from "../../assets/icon.png" with { type: "file" };
import { APP_NAME, configPath } from "../config";
import { createSubprocessGuard, subprocessEnvironment } from "../data/real/subprocess";

const SEND_TIMEOUT_MS = 5_000;

export interface NotificationCommand {
  argv: string[];
  env?: Record<string, string>;
}

export type DeliveryChannel = "terminal" | "system";

export type DeliveryResult =
  | { isDelivered: true; channel: DeliveryChannel }
  | { isDelivered: false; reason: string };

export type SendNotification = (title: string, body: string) => Promise<DeliveryResult>;

// No stock toast cmdlet exists; WinRT shows one under PowerShell's own app id.
function windowsToastScript(hasIcon: boolean): string {
  const template = hasIcon ? "ToastImageAndText02" : "ToastText02";
  return [
    "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    `$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::${template})`,
    "$text = $template.GetElementsByTagName('text')",
    "$null = $text.Item(0).AppendChild($template.CreateTextNode($env:OPEN_USAGE_NOTIFY_TITLE))",
    "$null = $text.Item(1).AppendChild($template.CreateTextNode($env:OPEN_USAGE_NOTIFY_BODY))",
    ...(hasIcon
      ? ["$null = $template.GetElementsByTagName('image').Item(0).SetAttribute('src', $env:OPEN_USAGE_NOTIFY_ICON)"]
      : []),
    "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($template))",
  ].join("; ");
}

export function desktopNotificationCommand(
  title: string,
  body: string,
  options: { platform?: NodeJS.Platform; iconPath?: string | null } = {},
): NotificationCommand | null {
  const platform = options.platform ?? process.platform;
  const iconPath = options.iconPath ?? null;
  if (platform === "darwin") {
    // The text travels as argv rather than inside the script, so a quote in a
    // label cannot end the AppleScript string early. AppleScript has no icon
    // option: the notification always carries the sending app's.
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
      argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsToastScript(iconPath !== null)],
      env: {
        OPEN_USAGE_NOTIFY_TITLE: title,
        OPEN_USAGE_NOTIFY_BODY: body,
        ...(iconPath !== null ? { OPEN_USAGE_NOTIFY_ICON: iconPath } : {}),
      },
    };
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    return {
      argv: ["notify-send", "--app-name", APP_NAME, ...(iconPath !== null ? ["--icon", iconPath] : []), title, body],
    };
  }
  return null;
}

/** notify-send and toasts need a real file, while a compiled binary keeps its assets inside itself. */
export async function installNotificationIcon(target: string): Promise<string | null> {
  try {
    const bytes = await Bun.file(bundledIcon).bytes();
    const existing = Bun.file(target);
    const isCurrent = (await existing.exists()) && Buffer.from(await existing.bytes()).equals(bytes);
    if (!isCurrent) {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      await Bun.write(target, bytes);
    }
    return target;
  } catch {
    // Without the file the notification still says everything that matters.
    return null;
  }
}

let iconFile: Promise<string | null> | null = null;

function notificationIcon(): Promise<string | null> {
  iconFile ??= installNotificationIcon(configPath("notification-icon.png"));
  return iconFile;
}

export const sendDesktopNotification: SendNotification = async (title, body) => {
  const iconPath = process.platform === "darwin" ? null : await notificationIcon();
  const command = desktopNotificationCommand(title, body, { iconPath });
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
      ? { isDelivered: true, channel: "system" }
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
