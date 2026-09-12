// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readDesktopNotificationPreferences,
  requestDesktopNotificationPermission,
  showDesktopAttentionNotification,
  writeDesktopNotificationPreferences,
} from "./notification-preferences.js";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("desktop notification preferences", () => {
  it("defaults safely and survives malformed browser storage", () => {
    expect(readDesktopNotificationPreferences()).toEqual({ enabled: false });
    window.localStorage.setItem("nexestra.desktopNotifications", "not-json");
    expect(readDesktopNotificationPreferences()).toEqual({ enabled: false });
    writeDesktopNotificationPreferences(true);
    expect(readDesktopNotificationPreferences()).toEqual({ enabled: true });
  });

  it("requests permission only when explicitly invoked and emits generic content", async () => {
    const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
    class MockNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = requestPermission;
      constructor(
        readonly title: string,
        readonly options?: NotificationOptions,
      ) {}
    }
    vi.stubGlobal("Notification", MockNotification);

    expect(await requestDesktopNotificationPermission()).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    MockNotification.permission = "granted";
    showDesktopAttentionNotification("Research", 2);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});
