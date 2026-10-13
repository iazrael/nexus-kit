// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInstallPrompt } from "./use-install-prompt.ts";

const UA_ANDROID = "Mozilla/5.0 (Linux; Android 14) Chrome/128";
const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)";

function setUA(ua: string, standalone?: boolean) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(window.navigator, "standalone", { value: standalone, configurable: true });
}
function setDisplayStandalone(matches: boolean) {
  window.matchMedia = vi.fn(() => ({ matches }) as MediaQueryList);
}

function installEvent(outcome: "accepted" | "dismissed") {
  const e = new Event("beforeinstallprompt") as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string; platform: string }>;
  };
  e.prompt = vi.fn(async () => {});
  e.userChoice = Promise.resolve({ outcome, platform: "web" });
  return e;
}

/** Node 26 自带的 localStorage 全局（未配 --localstorage-file 时为 undefined）会盖住 happy-dom 的实现，这里换内存版 */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  setDisplayStandalone(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setUA(UA_ANDROID, undefined);
});

describe("useInstallPrompt", () => {
  it("Android：捕获原生事件后可安装；接受后入口消失；appinstalled 回调", async () => {
    setUA(UA_ANDROID);
    const onInstalled = vi.fn();
    const { result } = renderHook(() => useInstallPrompt({ version: "1.0.0", onInstalled }));
    expect(result.current.canInstall).toBe(false);
    const e = installEvent("accepted");
    act(() => void window.dispatchEvent(e));
    expect(result.current.canInstall).toBe(true);
    await act(() => result.current.install());
    expect(e.prompt).toHaveBeenCalled();
    expect(result.current.canInstall).toBe(false);
    act(() => void window.dispatchEvent(new Event("appinstalled")));
    expect(onInstalled).toHaveBeenCalled();
  });

  it("Android：用户取消后事件作废、入口隐藏（原生事件只能用一次），浏览器再派发才重新出现；无事件时 install 无动作", async () => {
    setUA(UA_ANDROID);
    const { result } = renderHook(() => useInstallPrompt({ version: "1.0.0" }));
    await act(() => result.current.install());
    const e = installEvent("dismissed");
    act(() => void window.dispatchEvent(e));
    await act(() => result.current.install());
    expect(e.prompt).toHaveBeenCalledTimes(1);
    expect(result.current.canInstall).toBe(false);
    act(() => void window.dispatchEvent(installEvent("dismissed")));
    expect(result.current.canInstall).toBe(true);
  });

  it("iOS 浏览器种类：微信内置浏览器识别为 wechat；非 iOS 为 null", () => {
    setUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) MicroMessenger/8.0.50", false);
    expect(renderHook(() => useInstallPrompt({ version: "1.0.0" })).result.current.browser).toBe("wechat");
    setUA(UA_ANDROID);
    expect(renderHook(() => useInstallPrompt({ version: "1.0.0" })).result.current.browser).toBeNull();
  });

  it("iOS：install 打开图文引导；关闭按版本记忆，新版本重新允许", async () => {
    setUA(UA_IPHONE, false);
    const { result, unmount } = renderHook(() => useInstallPrompt({ version: "1.0.0" }));
    expect(result.current.ios).toBe(true);
    expect(result.current.canInstall).toBe(true);
    await act(() => result.current.install());
    expect(result.current.iosGuideOpen).toBe(true);
    act(() => result.current.dismissIosGuide());
    expect(result.current.iosGuideOpen).toBe(false);
    expect(result.current.iosGuideDismissed).toBe(true);
    unmount();
    expect(renderHook(() => useInstallPrompt({ version: "1.0.0" })).result.current.iosGuideDismissed).toBe(true);
    expect(renderHook(() => useInstallPrompt({ version: "1.1.0" })).result.current.iosGuideDismissed).toBe(false);
  });

  it("已是独立窗口：一切引导隐藏", () => {
    setUA(UA_IPHONE, true);
    const { result } = renderHook(() => useInstallPrompt({ version: "1.0.0" }));
    act(() => result.current.openIosGuide());
    expect(result.current.standalone).toBe(true);
    expect(result.current.canInstall).toBe(false);
    expect(result.current.iosGuideOpen).toBe(false);
  });
});
