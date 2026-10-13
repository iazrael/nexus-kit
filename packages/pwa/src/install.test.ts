import { describe, expect, it } from "vitest";
import { iosBrowser, isIOS, isStandalone, type InstallEnvLike } from "./install.ts";

const env = (overrides: Partial<InstallEnvLike> = {}): InstallEnvLike => ({
  userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/128",
  maxTouchPoints: 5,
  ...overrides,
});

describe("isIOS", () => {
  it("iPhone / iPad UA 判定为 iOS", () => {
    expect(isIOS(env({ userAgent: "iPhone OS 17_5 like Mac OS X" }))).toBe(true);
    expect(isIOS(env({ userAgent: "iPad; CPU OS 17_5" }))).toBe(true);
  });

  it("iPadOS 13+ UA 伪装 Macintosh，以多点触控识别", () => {
    expect(isIOS(env({ userAgent: "Macintosh; Intel Mac OS X 10_15_7", maxTouchPoints: 5 }))).toBe(true);
  });

  it("桌面 Mac（无多点触控）不误判", () => {
    expect(isIOS(env({ userAgent: "Macintosh; Intel Mac OS X 10_15_7", maxTouchPoints: 0 }))).toBe(false);
  });

  it("Android / Windows 不判定为 iOS", () => {
    expect(isIOS(env())).toBe(false);
    expect(isIOS(env({ userAgent: "Windows NT 10.0; Win64; x64", maxTouchPoints: 10 }))).toBe(false);
  });
});

describe("isStandalone", () => {
  it("iOS Safari 私有 standalone 标志优先", () => {
    expect(isStandalone(env({ standalone: true }), false)).toBe(true);
    expect(isStandalone(env({ standalone: false }), true)).toBe(false);
  });

  it("非 iOS 环境读 display-mode: standalone", () => {
    expect(isStandalone(env(), true)).toBe(true);
    expect(isStandalone(env(), false)).toBe(false);
  });
});

describe("iosBrowser", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit Version/17.5 Mobile Safari/604.1", "safari"],
    ["Mozilla/5.0 (iPhone) AppleWebKit Mobile/15E148 MicroMessenger/8.0.50", "wechat"],
    ["Mozilla/5.0 (iPhone) AppleWebKit Mobile/15E148 QQ/9.0.0", "qq"],
    ["Mozilla/5.0 (iPhone) AppleWebKit CriOS/128.0 Mobile Safari", "other"],
    ["Mozilla/5.0 (iPhone) AppleWebKit EdgiOS/128.0 Mobile Safari", "other"],
  ])("%s → %s", (ua, want) => {
    expect(iosBrowser(env({ userAgent: ua }))).toBe(want);
  });
});
