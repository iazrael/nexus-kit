import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTime, safeGlobalStorage, scrubUrl, scrubUrlsInText } from "./util.ts";

afterEach(() => vi.unstubAllGlobals());

describe("safeGlobalStorage", () => {
  it("访问属性即抛 SecurityError 时返回 null，不把页面搞挂", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    expect(safeGlobalStorage("sessionStorage")).toBeNull();
    // @ts-expect-error 清理测试桩
    delete globalThis.sessionStorage;
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    expect(safeGlobalStorage("localStorage")).not.toBeNull();
    vi.stubGlobal("localStorage", undefined);
    expect(safeGlobalStorage("localStorage")).toBeNull();
  });
});

describe("scrubUrl / scrubUrlsInText", () => {
  it("去掉查询串、片段与凭证；不是 URL 原样返回", () => {
    expect(scrubUrl("https://u:p@a.com/x/y?token=1#h")).toBe("https://a.com/x/y");
    expect(scrubUrl("/rel?q=1")).toBe("/rel?q=1");
  });

  it("自由文本里的 URL 统一去查询串，句尾标点保留", () => {
    expect(scrubUrlsInText('拉取失败 https://api.x.com/v1?token=secret#a，重试 {"u":"http://b.com/p?k=1"}.')).toBe(
      '拉取失败 https://api.x.com/v1，重试 {"u":"http://b.com/p"}.',
    );
    expect(scrubUrlsInText("见 (https://a.com/x?y=1).")).toBe("见 (https://a.com/x).");
  });
});

describe("formatTime", () => {
  it("本地时区完整时刻", () => {
    expect(formatTime(new Date(2026, 9, 14, 9, 5, 7, 8).getTime())).toBe("2026-10-14 09:05:07.008");
  });
});
