// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogStore, pickLevel, type LogStoreOptions, type StorageLike } from "./store.ts";

function memStorage(init: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const stores: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  vi.useRealTimers();
});

function make(over: Partial<LogStoreOptions> = {}) {
  let now = Date.UTC(2026, 9, 14, 4, 0, 0);
  const storage = memStorage();
  const store = createLogStore({
    key: "app.log",
    storage,
    sessionStorage: memStorage(),
    clock: () => now,
    console: null,
    session: "S2",
    env: () => ["环境：测试"],
    search: "",
    ...over,
  });
  stores.push(store);
  return { store, storage: (over.storage as ReturnType<typeof memStorage> | undefined) ?? storage, tick: (ms: number) => (now += ms) };
}

describe("pickLevel", () => {
  it("URL 优先，其次本会话记住的，最后默认值；非法值忽略", () => {
    expect(pickLevel("?log=debug", "warn", "info")).toBe("debug");
    expect(pickLevel("?a=1", "warn", "info")).toBe("warn");
    expect(pickLevel("", null, "info")).toBe("info");
    expect(pickLevel("?log=verbose", "nope", "info")).toBe("info");
  });
});

describe("createLogStore", () => {
  it("低于阈值的不入缓冲；命名 logger 带模块名与结构化数据", () => {
    const { store } = make();
    const log = store.log("audio");
    log.debug("细节");
    log.info("解锁", { ok: true });
    log.warn("重建", { attempt: 1 });
    expect(store.entries().map((e) => [e.lv, e.m, e.msg, e.data])).toEqual([
      ["info", "audio", "解锁", { ok: true }],
      ["warn", "audio", "重建", { attempt: 1 }],
    ]);
    store.setLevel("debug");
    log.debug("现在记了");
    expect(store.entries()).toHaveLength(3);
    expect(store.level()).toBe("debug");
  });

  it("?log=debug 打开详细日志并只记在本会话", () => {
    const session = memStorage();
    const { store } = make({ search: "?log=debug", sessionStorage: session });
    expect(store.level()).toBe("debug");
    expect(session.data.get("app.log.level")).toBe("debug");
  });

  it("数据不可序列化或过长时就地降级，不抛、不撑爆预算", () => {
    const { store } = make();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    store.log("x").info("环", loop);
    store.log("x").info("长", { s: "y".repeat(5000) });
    const [a, b] = store.entries();
    expect(String(a!.data)).toMatch(/无法序列化/);
    expect(String(b!.data).length).toBeLessThanOrEqual(2100);
  });

  it("防抖落盘；页面隐藏时立即写；下次启动读回上一会话", () => {
    vi.useFakeTimers();
    const { store, storage } = make({ flushDelayMs: 1000 });
    store.log("boot").info("启动");
    expect(storage.data.has("app.log")).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(storage.data.get("app.log")!)).toHaveLength(1);

    store.log("boot").info("第二条");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(JSON.parse(storage.data.get("app.log")!)).toHaveLength(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

    store.log("boot").info("第三条");
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(storage.data.get("app.log")!)).toHaveLength(3);

    const next = make({ storage, session: "S3" }).store;
    next.log("boot").info("新会话");
    expect(next.entries().map((e) => `${e.s}:${e.msg}`)).toEqual(["S2:启动", "S2:第二条", "S2:第三条", "S3:新会话"]);
    expect(next.lastEntryAt("S2")).toBe(next.entries()[2]!.t);
    expect(next.lastEntryAt("nope")).toBeNull();
  });

  it("持久化按会话轮转：只留最近 N 个会话", () => {
    const storage = memStorage();
    for (const s of ["A", "B", "C", "D"]) {
      const st = make({ storage, session: s, sessionsKept: 2 }).store;
      st.log("app").info(`会话 ${s}`);
      st.flush();
    }
    expect((JSON.parse(storage.data.get("app.log")!) as Array<{ s: string }>).map((e) => e.s)).toEqual(["C", "D"]);
  });

  it("写盘失败不抛，记数并写进导出头部；恢复到坏数据也如实说明", () => {
    const broken: StorageLike = {
      getItem: () => "{坏",
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    const { store } = make({ storage: broken });
    store.log("app").info("x");
    store.flush();
    store.flush();
    expect(store.persistHealth()).toMatchObject({ failures: 2, lastError: expect.stringMatching(/Quota/) });
    const text = store.exportText();
    expect(text).toMatch(/持久化：失败 2 次.*Quota/);
    expect(text).toMatch(/读回其他会话出错/);
  });

  it("导出：环境头 + 宿主摘要节 + 按会话分段的日志行；注销的节不再出现", () => {
    const { store, tick } = make();
    const off = store.registerSection("上次退出", () => ["判词：正常"]);
    store.log("pwa").info("检测到新版本", { to: "1.2.0" });
    tick(1500);
    store.log("app").error("崩了");
    const text = store.exportText();
    expect(text).toContain("环境：测试");
    expect(text).toContain("## 上次退出\n判词：正常");
    expect(text).toMatch(/--- 会话 S2（本次）/);
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} INFO {2}\[pwa\] 检测到新版本 \{"to":"1\.2\.0"\}/);
    expect(text).toMatch(/ERROR \[app\] 崩了/);
    off();
    expect(store.exportText()).not.toContain("## 上次退出");
  });

  it("摘要节抛错不影响导出；清空同步清掉持久化", () => {
    const { store, storage } = make();
    store.registerSection("坏节", () => {
      throw new Error("boom");
    });
    store.log("app").info("x");
    store.flush();
    expect(store.exportText()).toMatch(/## 坏节\n（生成失败：.*boom）/);
    store.clear();
    expect(store.entries()).toEqual([]);
    expect(storage.data.has("app.log")).toBe(false);
  });

  it("分区声明生效：高频模块冲满不挤掉低频记录", () => {
    const { store } = make({
      domains: [
        { name: "busy", cap: 2, modules: ["combat"] },
        { name: "calm", cap: 10 },
      ],
    });
    store.log("boot").info("启动");
    for (let i = 0; i < 10; i++) store.log("combat").info(`命中 ${i}`);
    expect(store.entries().map((e) => e.msg)).toEqual(["启动", "命中 8", "命中 9"]);
    expect(store.exportText()).toMatch(/丢弃：busy 8 条/);
  });

  it("Error 载荷保留名称、消息与截断后的堆栈；BigInt 转字符串；原始类型原样", () => {
    const { store } = make();
    const err = new TypeError("读不到 x");
    store.log("app").error("失败", err);
    store.log("app").info("大数", { n: 10n });
    store.log("app").info("字符串", "纯文本");
    const [a, b, c] = store.entries();
    expect(a!.data).toMatchObject({ name: "TypeError", message: "读不到 x", stack: expect.stringContaining("TypeError") });
    expect(String((a!.data as { stack: string }).stack).length).toBeLessThanOrEqual(1000);
    expect(b!.data).toEqual({ n: "10" });
    expect(c!.data).toBe("纯文本");
    expect(store.exportText()).toMatch(/ERROR \[app\] 失败 \{"name":"TypeError","message":"读不到 x"/);
  });

  it("两个窗口共用存储：各自落盘时保留对方的会话，导出能看到两边", () => {
    const storage = memStorage();
    let tick = 0;
    const clock = (): number => ++tick; // 两个窗口共享一条递增时钟，时间线可比
    const a = make({ storage, session: "A", clock }).store;
    const b = make({ storage, session: "B", clock }).store;
    a.log("app").info("A 的记录");
    a.flush();
    b.log("app").info("B 的记录");
    b.flush();
    a.log("app").info("A 又一条");
    a.flush();
    const persisted = JSON.parse(storage.data.get("app.log")!) as Array<{ msg: string }>;
    expect(persisted.map((e) => e.msg)).toEqual(["A 的记录", "B 的记录", "A 又一条"]);
    expect(a.exportText()).toContain("B 的记录");
  });

  it("写盘失败先降级重试（只留本会话、预算减半），首次失败打一条 console 警告", () => {
    const data = new Map<string, string>();
    data.set("app.log", JSON.stringify([{ t: 1, s: "OLD", lv: "info", m: "app", msg: "x".repeat(300) }]));
    const tight: StorageLike = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        if (v.length > 200) throw new Error("QuotaExceededError");
        data.set(k, v);
      },
      removeItem: (k) => void data.delete(k),
    };
    const out = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { store } = make({ storage: tight, console: out });
    store.log("app").info("本次");
    store.flush();
    expect((JSON.parse(data.get("app.log")!) as Array<{ s: string }>).map((e) => e.s)).toEqual(["S2"]);
    expect(store.persistHealth()).toMatchObject({ failures: 0, degraded: 1 });
    expect(out.warn).toHaveBeenCalledTimes(1);
    expect(store.exportText()).toMatch(/持久化：降级保存 1 次/);
  });

  it("导出时自由文本里的 URL 去掉查询串（兜底防凭证外泄）", () => {
    const { store } = make();
    store.log("net").warn("请求失败 https://api.x.com/v1/user?token=secret", { url: "https://a.com/p?k=1#f" });
    const text = store.exportText();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("k=1");
    expect(text).toContain("https://api.x.com/v1/user");
  });

  it("时钟回拨时间戳也单调不减，时间线不乱序", () => {
    let now = 5000;
    const { store } = make({ clock: () => now });
    store.log("app").info("一");
    now = 1000;
    store.log("app").info("二");
    const [a, b] = store.entries();
    expect(b!.t).toBeGreaterThanOrEqual(a!.t);
    expect(store.entries().map((e) => e.msg)).toEqual(["一", "二"]);
  });

  it("console 输出达到阈值的记录", () => {
    const out = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { store } = make({ console: out });
    store.log("app").debug("不打");
    store.log("app").warn("打", { a: 1 });
    expect(out.debug).not.toHaveBeenCalled();
    expect(out.warn).toHaveBeenCalledWith("[app] 打", { a: 1 });
  });
});
