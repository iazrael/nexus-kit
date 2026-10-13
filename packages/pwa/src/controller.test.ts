// @vitest-environment happy-dom
/**
 * 控制器接线测试：registerSW 回调、心跳与切前台探测、version.json 嗅探命中→快照/开窗、
 * 暂缓与「稍后」、手动检查三路、beginUpgrade 的探测/接管令/激活刷新/卡死兜底、强制更新、
 * nosw 开关。navigator.serviceWorker / fetch / caches 全部假件注入——真 SW 集成由
 * playground e2e（scripts/e2e-upgrade.ts）覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPwaController, type PwaControllerOptions, type RegisterSwOptions } from "./controller.ts";

type Listener = () => void;
function makeWorker(state = "installed") {
  const listeners = new Set<Listener>();
  const worker = {
    state,
    addEventListener: (_t: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_t: string, fn: Listener) => listeners.delete(fn),
    postMessage: vi.fn(),
    setState(next: string) {
      worker.state = next;
      for (const fn of [...listeners]) fn();
    },
  };
  return worker;
}
type FakeWorker = ReturnType<typeof makeWorker>;

function makeRegistration(over: { waiting?: FakeWorker | null; installing?: FakeWorker | null; active?: FakeWorker | null } = {}) {
  return {
    waiting: over.waiting ?? null,
    installing: over.installing ?? null,
    active: over.active === undefined ? makeWorker("activated") : over.active,
    scope: "/",
    addEventListener: () => {},
    removeEventListener: () => {},
    update: vi.fn(async () => {}),
  };
}
type FakeRegistration = ReturnType<typeof makeRegistration>;

function patchServiceWorker(container: Record<string, unknown>): void {
  Object.defineProperty(window.navigator, "serviceWorker", { value: container, configurable: true });
}
function unpatchServiceWorker(): void {
  delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
}

const LOCAL = { version: "1.0.0", build: 10, notesDigest: "x" };
const REMOTE_NEXT = {
  version: "1.1.0",
  build: 12,
  buildTime: "2026-10-13T00:00:00.000Z",
  releases: [{ version: "1.1.0", date: "2026-10-13", notes: ["新增：测试条目"] }],
};
const REMOTE_SAME = { version: "1.0.0", build: 10, buildTime: "2026-10-12T00:00:00.000Z", releases: [] };

const respond = (body: unknown, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 404, json: async () => body }));
const fetchCalls = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setup(over: Partial<PwaControllerOptions> = {}, reg: FakeRegistration = makeRegistration()) {
  let captured: RegisterSwOptions | null = null;
  const registerSW = vi.fn((opts: RegisterSwOptions) => {
    captured = opts;
  });
  patchServiceWorker({ controller: null, addEventListener: () => {}, removeEventListener: () => {}, ready: Promise.resolve(reg) });
  const ctl = createPwaController({ local: LOCAL, registerSW, logger: silent, ...over });
  return {
    ctl,
    reg,
    registerSW,
    opts: () => {
      if (captured === null) throw new Error("registerSW 未被调用");
      return captured;
    },
  };
}

/** 注册完成态：start 已跑、onRegisteredSW 已回调 */
function registered(reg: FakeRegistration = makeRegistration(), over: Partial<PwaControllerOptions> = {}) {
  const s = setup(over, reg);
  s.ctl.start();
  s.opts().onRegisteredSW?.("/sw.js", reg as unknown as ServiceWorkerRegistration);
  return s;
}

beforeEach(() => {
  vi.stubGlobal("fetch", respond(REMOTE_SAME));
  vi.stubGlobal("caches", { keys: async () => [], delete: async () => true });
  const backing = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  unpatchServiceWorker();
  window.history.replaceState(null, "", "/");
});

describe("start 注册与检测链", () => {
  it("无 SW 环境：不注册", () => {
    const registerSW = vi.fn();
    createPwaController({ local: LOCAL, registerSW, logger: silent }).start();
    expect(registerSW).not.toHaveBeenCalled();
  });

  it("重复 start 只注册一次", () => {
    const { ctl, registerSW } = setup();
    ctl.start();
    ctl.start();
    expect(registerSW).toHaveBeenCalledTimes(1);
  });

  it("注册成功：立即探测一轮，已是最新不开窗", async () => {
    const { ctl, reg } = registered();
    await vi.waitFor(() => expect(fetchCalls()).toBe(1));
    expect(reg.update).toHaveBeenCalledTimes(1);
    expect(ctl.getSnapshot().promptOpen).toBe(false);
  });

  it("嗅探命中：快照带 pending、remoteVersion 去 v 前缀、promptOpen 打开并通知订阅者", async () => {
    vi.stubGlobal("fetch", respond({ ...REMOTE_NEXT, version: "v1.1.0" }));
    const { ctl } = registered();
    const listener = vi.fn();
    ctl.subscribe(listener);
    await vi.waitFor(() => expect(ctl.getSnapshot().promptOpen).toBe(true));
    const s = ctl.getSnapshot();
    expect(s.needRefresh).toBe(true);
    expect(s.remoteVersion).toBe("1.1.0");
    expect(s.pending?.kind).toBe("upgrade");
    expect(listener).toHaveBeenCalled();
  });

  it("退订后不再通知", async () => {
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    const { ctl } = setup();
    const listener = vi.fn();
    const unsub = ctl.subscribe(listener);
    unsub();
    ctl.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(listener).not.toHaveBeenCalled();
  });

  it("onNeedRefresh 先到、嗅探未命中：不开窗，等下一拍", () => {
    const { ctl, opts } = registered();
    opts().onNeedRefresh?.();
    expect(ctl.getSnapshot().promptOpen).toBe(false);
  });

  it("onNeedRefresh 在嗅探命中之后到：开窗（「稍后」过同一构建则不开）", async () => {
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    const { ctl, opts } = registered();
    await vi.waitFor(() => expect(ctl.getSnapshot().promptOpen).toBe(true));
    ctl.dismissPrompt();
    opts().onNeedRefresh?.();
    expect(ctl.getSnapshot().promptOpen).toBe(false);
  });

  it("心跳：到点再探测（interval 注册一次），间隔可配", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    registered(makeRegistration(), { checkIntervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchCalls()).toBe(3);
  });

  it("同一构建心跳重复命中不重复开窗；新构建再开", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    const { ctl } = registered(makeRegistration(), { checkIntervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.getSnapshot().promptOpen).toBe(true);
    ctl.dismissPrompt();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctl.getSnapshot().promptOpen).toBe(false);
    vi.stubGlobal("fetch", respond({ ...REMOTE_NEXT, build: 13 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctl.getSnapshot().promptOpen).toBe(true);
  });

  it("切前台：visibilitychange → visible 再嗅探", async () => {
    registered();
    await vi.waitFor(() => expect(fetchCalls()).toBe(1));
    const before = fetchCalls();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(fetchCalls()).toBeGreaterThan(before));
  });

  it("注册失败与 registration 缺失：只记日志，不探测", async () => {
    const { ctl, opts } = setup();
    ctl.start();
    opts().onRegisterError?.(new Error("boom"));
    opts().onRegisteredSW?.("/sw.js", undefined);
    expect(silent.error).toHaveBeenCalledWith("SW 注册失败", expect.anything());
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCalls()).toBe(0);
  });

  it("onOfflineReady 转交宿主钩子", () => {
    const onOfflineReady = vi.fn();
    const { opts } = registered(makeRegistration(), { onOfflineReady });
    opts().onOfflineReady?.();
    expect(onOfflineReady).toHaveBeenCalledTimes(1);
  });

  it("version.json 非 200 / 结构非法 / 网络异常：按无更新处理并记日志", async () => {
    vi.stubGlobal("fetch", respond({}, false));
    const a = registered();
    await expect(a.ctl.checkForUpdate("t")).resolves.toBe("failed");
    vi.stubGlobal("fetch", respond({ nope: 1 }));
    await expect(a.ctl.checkForUpdate("t")).resolves.toBe("failed");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    await expect(a.ctl.checkForUpdate("t")).resolves.toBe("failed");
    expect(silent.warn).toHaveBeenCalled();
  });

  it("version.json 请求带时间戳绕过中间缓存，路径可配", async () => {
    registered(makeRegistration(), { versionUrl: "/app/version.json" });
    await vi.waitFor(() => expect(fetchCalls()).toBe(1));
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toMatch(/^\/app\/version\.json\?t=\d+$/);
  });
});

describe("暂缓与稍后", () => {
  it("暂缓期间命中只记 needRefresh 不开窗，解除时补开", async () => {
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    const { ctl } = setup();
    ctl.setPromptBlocked(true);
    ctl.start();
    // 手动触发一次判定（registration 未接线也能嗅探）
    await ctl.checkForUpdate("t");
    expect(ctl.getSnapshot().needRefresh).toBe(true);
    expect(ctl.getSnapshot().promptOpen).toBe(false);
    ctl.setPromptBlocked(false);
    expect(ctl.getSnapshot().promptOpen).toBe(true);
  });

  it("「稍后」过的构建：解除暂缓不补开；手动检查强制重开", async () => {
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    const { ctl } = registered();
    await vi.waitFor(() => expect(ctl.getSnapshot().promptOpen).toBe(true));
    ctl.dismissPrompt();
    ctl.setPromptBlocked(true);
    ctl.setPromptBlocked(false);
    expect(ctl.getSnapshot().promptOpen).toBe(false);
    await expect(ctl.manualCheck()).resolves.toBe("update");
    expect(ctl.getSnapshot().promptOpen).toBe(true);
  });
});

describe("checkForUpdate / manualCheck", () => {
  it("壳探测放后台：update 永不完成也即时返回", async () => {
    const reg = makeRegistration();
    reg.update = vi.fn(() => new Promise<never>(() => {}));
    const { ctl } = registered(reg);
    await expect(ctl.checkForUpdate("manual")).resolves.toBe("latest");
  });

  it("嗅探拿不到说明但 SW waiting 已就绪：按有更新处理", async () => {
    vi.stubGlobal("fetch", respond({}, false));
    const { ctl, reg } = registered(makeRegistration({ waiting: makeWorker("installed") }));
    await expect(ctl.manualCheck()).resolves.toBe("update");
    expect(reg.update).toHaveBeenCalled();
  });

  it("quiet：命中只判定不开窗不记 pending", async () => {
    const { ctl } = registered();
    await vi.waitFor(() => expect(fetchCalls()).toBe(1));
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    await expect(ctl.checkForUpdate("force", { quiet: true })).resolves.toBe("update");
    expect(ctl.getSnapshot().promptOpen).toBe(false);
    expect(ctl.getSnapshot().pending).toBeNull();
  });

  it("升级进行中：嗅探命中不开窗", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    const { ctl } = registered(makeRegistration({ installing: makeWorker("installing") }));
    await vi.advanceTimersByTimeAsync(0);
    ctl.beginUpgrade();
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    await expect(ctl.checkForUpdate("manual")).resolves.toBe("update");
    expect(ctl.getSnapshot().promptOpen).toBe(false);
  });

  it("ensureRegistration：已接线 true；未接线接管浏览器既有注册；真无注册 false；查询抛错 false", async () => {
    const { ctl } = registered();
    expect(await ctl.ensureRegistration()).toBe(true);

    const reg = makeRegistration();
    patchServiceWorker({ controller: null, addEventListener: () => {}, removeEventListener: () => {}, getRegistration: async () => reg });
    expect(await createPwaController({ local: LOCAL, registerSW: vi.fn(), logger: silent }).ensureRegistration()).toBe(true);

    patchServiceWorker({
      controller: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      getRegistration: async () => undefined,
    });
    expect(await createPwaController({ local: LOCAL, registerSW: vi.fn(), logger: silent }).ensureRegistration()).toBe(false);

    patchServiceWorker({
      controller: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      getRegistration: async () => Promise.reject(new Error("x")),
    });
    expect(await createPwaController({ local: LOCAL, registerSW: vi.fn(), logger: silent }).ensureRegistration()).toBe(false);

    unpatchServiceWorker();
    expect(await createPwaController({ local: LOCAL, registerSW: vi.fn(), logger: silent }).ensureRegistration()).toBe(false);
  });
});

describe("beginUpgrade", () => {
  it("waiting 就绪→接管令→激活信号→reload；快照 stage 跟随，开窗即关", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    const waiting = makeWorker("installed");
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    const { ctl } = registered(makeRegistration({ waiting }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.getSnapshot().promptOpen).toBe(true);
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const stages: string[] = [];
    ctl.beginUpgrade({ onStage: (s) => stages.push(s) });
    expect(ctl.getSnapshot().promptOpen).toBe(false);
    expect(ctl.getSnapshot().stage).toBe("downloading");
    await vi.advanceTimersByTimeAsync(300);
    expect(stages).toEqual(["downloading", "switching"]);
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    waiting.setState("activated");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("switching 后未激活：卡死兜底 onFail，复位后命中可再开窗", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    const { ctl } = registered(makeRegistration({ waiting: makeWorker("installed") }));
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const onFail = vi.fn();
    ctl.beginUpgrade({ onFail });
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(6000);
    expect(onFail).toHaveBeenCalledWith("switching-stuck");
    expect(reload).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    await ctl.manualCheck();
    expect(ctl.getSnapshot().promptOpen).toBe(true);
  });

  it("服务器上没有可装的新 SW：no-install 提前收口", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    const { ctl } = registered();
    const onFail = vi.fn();
    ctl.beginUpgrade({ onFail });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onFail).toHaveBeenCalledWith("no-install");
  });

  it("探测异常只进日志，流程照常", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    const reg = makeRegistration({ installing: makeWorker("installing") });
    const { ctl } = registered(reg);
    reg.update.mockRejectedValueOnce(new Error("boom"));
    const onFail = vi.fn();
    ctl.beginUpgrade({ onFail });
    await vi.advanceTimersByTimeAsync(0);
    expect(silent.warn).toHaveBeenCalledWith("升级探测失败", expect.anything());
    expect(onFail).not.toHaveBeenCalled();
  });

  it("无 SW 注册：直接刷新收口", () => {
    const { ctl } = setup();
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    ctl.beginUpgrade();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("forceUpgrade", () => {
  it("已是最新：不保存不刷新，原样返回判定", async () => {
    const { ctl } = registered();
    const beforeReload = vi.fn(async () => {});
    await expect(ctl.forceUpgrade({ beforeReload })).resolves.toBe("latest");
    expect(beforeReload).not.toHaveBeenCalled();
  });

  it("命中：先保存再开跑（静默嗅探不开窗）", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    const { ctl } = registered(makeRegistration({ installing: makeWorker("installing") }));
    await vi.advanceTimersByTimeAsync(0);
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    const beforeReload = vi.fn(async () => {});
    await expect(ctl.forceUpgrade({ beforeReload })).resolves.toBe("started");
    expect(beforeReload).toHaveBeenCalledTimes(1);
    expect(ctl.getSnapshot().stage).toBe("downloading");
    expect(ctl.getSnapshot().promptOpen).toBe(false);
  });

  it("保存失败或超时：只记日志，照常更新", async () => {
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    const { ctl } = setup();
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    await expect(ctl.forceUpgrade({ beforeReload: async () => Promise.reject(new Error("db")) })).resolves.toBe("started");
    await expect(ctl.forceUpgrade({ beforeReload: () => new Promise<void>(() => {}), saveTimeoutMs: 5 })).resolves.toBe("started");
    expect(reload).toHaveBeenCalledTimes(2);
    expect(silent.warn).toHaveBeenCalledWith("强制更新：保存失败，放行更新", expect.anything());
    expect(silent.warn).toHaveBeenCalledWith("强制更新：保存超时，放行更新", expect.anything());
  });
});

describe("?nosw=1 验证开关", () => {
  it("反注册 + 清缓存 + 本轮不注册；清到东西时重载一次（sessionStorage 防循环）", async () => {
    window.history.replaceState(null, "", "/?nosw=1");
    const unregister = vi.fn(async () => true);
    const del = vi.fn(async () => true);
    vi.stubGlobal("caches", { keys: async () => ["a"], delete: del });
    const registerSW = vi.fn();
    patchServiceWorker({ controller: null, getRegistrations: async () => [{ unregister }] });
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    createPwaController({ local: LOCAL, registerSW, logger: silent }).start();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(unregister).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith("a");
    expect(registerSW).not.toHaveBeenCalled();
    createPwaController({ local: LOCAL, registerSW, logger: silent }).start();
    await new Promise((r) => setTimeout(r, 10));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("清理失败进错误日志", async () => {
    window.history.replaceState(null, "", "/?nosw=1");
    patchServiceWorker({ controller: null, getRegistrations: async () => Promise.reject(new Error("x")) });
    createPwaController({ local: LOCAL, registerSW: vi.fn(), logger: silent }).start();
    await vi.waitFor(() => expect(silent.error).toHaveBeenCalledWith("nosw 清理失败", expect.anything()));
  });
});

describe("reopenPrompt / consumeUpdatedNotice", () => {
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

  it("「稍后」后重开：已知有更新才开，不请求网络", async () => {
    vi.stubGlobal("fetch", respond(REMOTE_NEXT));
    const { ctl } = registered();
    ctl.reopenPrompt();
    expect(ctl.getSnapshot().promptOpen).toBe(false); // 尚不知道有更新
    await vi.waitFor(() => expect(ctl.getSnapshot().promptOpen).toBe(true));
    ctl.dismissPrompt();
    const calls = fetchCalls();
    ctl.reopenPrompt();
    expect(ctl.getSnapshot().promptOpen).toBe(true);
    expect(fetchCalls()).toBe(calls);
  });

  it("升级刷新前记旧版本；新版启动读到一次「已更新」后清掉；版本没变不报喜；存储不可用返回 null", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    setup().ctl.beginUpgrade(); // 无注册路径直接刷新
    expect(reload).toHaveBeenCalled();
    expect(window.localStorage.getItem("nexus-upgraded-from")).toBe("1.0.0");
    const next = createPwaController({ local: { version: "1.1.0", build: 12 }, registerSW: vi.fn(), logger: silent });
    expect(next.consumeUpdatedNotice()).toEqual({ from: "1.0.0", to: "1.1.0" });
    expect(next.consumeUpdatedNotice()).toBeNull();
    window.localStorage.setItem("nexus-upgraded-from", "1.0.0");
    expect(createPwaController({ local: LOCAL, registerSW: vi.fn(), logger: silent }).consumeUpdatedNotice()).toBeNull();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(next.consumeUpdatedNotice()).toBeNull();
    setup().ctl.beginUpgrade();
    expect(silent.warn).toHaveBeenCalledWith("记录升级前版本失败（只影响升级后的提示）");
  });
});
