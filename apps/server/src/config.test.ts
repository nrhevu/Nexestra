import { describe, expect, it } from "vitest";
import { resolveHost } from "./config.js";

describe("server bind address", () => {
  it.each([undefined, "", "127.0.0.1", "localhost", "::1"])(
    "accepts loopback value %s",
    (value) => {
      expect(resolveHost(value)).toBe(value?.trim() || "127.0.0.1");
    },
  );

  it.each(["0.0.0.0", "192.168.1.20", "example.com"])("rejects non-loopback value %s", (value) => {
    expect(() => resolveHost(value)).toThrow(/must be a loopback host/);
  });
});
