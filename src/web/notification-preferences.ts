const STORAGE_KEY = "nexestra.desktopNotifications";

export interface DesktopNotificationPreferences {
  enabled: boolean;
}

export function readDesktopNotificationPreferences(): DesktopNotificationPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: false };
    const parsed: unknown = JSON.parse(raw);
    return {
      enabled:
        typeof parsed === "object" &&
        parsed !== null &&
        "enabled" in parsed &&
        parsed.enabled === true,
    };
  } catch {
    return { enabled: false };
  }
}

export function writeDesktopNotificationPreferences(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled }));
  } catch {
    // Browser storage may be unavailable; the in-memory preference still applies.
  }
}

export async function requestDesktopNotificationPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission !== "default") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export function showDesktopAttentionNotification(workspaceName: string, count: number): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification("Nexestra needs your attention", {
      body: `${workspaceName}: ${count} item${count === 1 ? "" : "s"} need review.`,
    });
  } catch {
    // Notification construction can fail in restricted browser contexts.
  }
}
