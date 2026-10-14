// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogStore } from "../log/store.ts";
import type { StorageLike } from "../util.ts";
import { interpretLastExit, startForensics, type LockManagerLike } from "./forensics.ts";

/** 假 Web Locks：held 里的锁名视为被其他页面持有；request 记下本页拿的锁，回调结束即视为释放 */
function fakeLocks(
  held: string[],
  query?: () => Promise<{ held: Array<{ name: string }> }>,
): LockManagerLike & {
  requested: string[];
  released: string[];
} {
  const requested: string[] = [];
  const released: string[] = [];
  return {
    requested,
    released,
    request: (name: string, cb: () => Promise<void>) => {
      requested.push(name);
      return cb().then(() => void released.push(name));
    },
    query: query ?? (async () => ({ held: held.map((name) => ({ name })) })),
  };
}

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

type Row = { openAt: number; aliveAt: number; exitAt?: number };
const table = (sessions: Record<string, Row>): string => JSON.stringify({ v: 1, sessions });
const KEY = "app.sessions";
const HB = 30_000;
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  vi.useRealTimers();
});

describe("interpretLastExit", () => {
  const now = 1_000_000;
  it("首次、正常、疑似异常；以最近开启的那个会话为「上一局」", () => {
    expect(interpretLastExit(null, now, HB)).toEqual({ verdict: { kind: "first-run" }, previousSession: null });
    expect(interpretLastExit(table({ A: { openAt: 1, aliveAt: 5, exitAt: 9 } }), now, HB)).toEqual({
      verdict: { kind: "clean", endedAt: 9 },
      previousSession: "A",
    });
    const raw = table({ A: { openAt: 1, aliveAt: 5, exitAt: 9 }, B: { openAt: 10, aliveAt: 50 } });
    expect(interpretLastExit(raw, now, HB)).toEqual({ verdict: { kind: "abrupt", lastAliveAt: 50 }, previousSession: "B" });
  });

  it("不知道哪些会话还在运行时：两个心跳周期内还有心跳的判无法判定，不误报异常", () => {
    const raw = table({ B: { openAt: 10, aliveAt: now - HB } });
    expect(interpretLastExit(raw, now, HB)).toMatchObject({
      verdict: { kind: "unknown", reason: expect.stringMatching(/其他窗口/) },
      previousSession: "B",
    });
  });

  it("知道哪些会话还在运行（Web Locks）：锁还在 = 确实开在别的窗口；锁不在 = 刚死掉，不管心跳多近都判疑似异常", () => {
    const raw = table({ B: { openAt: 10, aliveAt: now - 1000 } });
    expect(interpretLastExit(raw, now, HB, undefined, new Set(["B"])).verdict).toMatchObject({
      kind: "unknown",
      reason: expect.stringMatching(/仍开在其他窗口/),
    });
    expect(interpretLastExit(raw, now, HB, undefined, new Set()).verdict).toEqual({ kind: "abrupt", lastAliveAt: now - 1000 });
  });

  it("表损坏或结构不对：无法判定", () => {
    expect(interpretLastExit("{坏", now, HB).verdict).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/损坏/) });
    expect(interpretLastExit(JSON.stringify({ v: 1, sessions: { A: { openAt: "x" } } }), now, HB).verdict).toMatchObject({
      kind: "unknown",
    });
  });
});

describe("startForensics", () => {
  function setup(storage: StorageLike | null = memStorage(), session = "S2", now = () => 1_000_000, locks: LockManagerLike | null = null) {
    const store = createLogStore({ key: "app.log", storage, sessionStorage: null, console: null, session, clock: now, env: () => [] });
    const f = startForensics({ prefix: "app", store, storage, clock: now, heartbeatMs: HB, locks });
    disposers.push(
      () => f.dispose(),
      () => store.dispose(),
    );
    return { store, f };
  }
  const rows = (s: ReturnType<typeof memStorage>): Record<string, Row> =>
    (JSON.parse(s.data.get(KEY)!) as { sessions: Record<string, Row> }).sessions;

  it("上局没告别：疑似异常，最后有动静取心跳与上局最后一条日志中较晚的；写入本局一行", () => {
    const storage = memStorage();
    storage.setItem(KEY, table({ S1: { openAt: 10_000, aliveAt: 40_000 } }));
    storage.setItem("app.log", JSON.stringify([{ t: 55_000, s: "S1", lv: "info", m: "app", msg: "最后一条" }]));
    const { f, store } = setup(storage);
    expect(f.verdict).toEqual({ kind: "abrupt", lastAliveAt: 55_000 });
    expect(rows(storage).S2).toEqual({ openAt: 1_000_000, aliveAt: 1_000_000 });
    const text = store.exportText();
    expect(text).toMatch(/## 上次退出\n判词：疑似异常退出/);
    expect(text).toMatch(/不能证明/);
  });

  it("闪退后马上重开：上一局刚有心跳，但它的锁已不在 → 落定为疑似异常；本局拿自己的锁", async () => {
    const storage = memStorage();
    storage.setItem(KEY, table({ S1: { openAt: 900_000, aliveAt: 995_000 } }));
    const locks = fakeLocks([]);
    const { f, store } = setup(storage, "S2", () => 1_000_000, locks);
    expect(f.verdict.kind).toBe("unknown"); // 查询落定前的初值
    expect(await f.settled).toEqual({ kind: "abrupt", lastAliveAt: 995_000 });
    expect(f.verdict.kind).toBe("abrupt");
    expect(locks.requested).toEqual(["app.alive.S2"]);
    expect(store.exportText()).toMatch(/判词：疑似异常退出/);
    expect(store.entries().filter((e) => e.m === "lifecycle" && e.lv === "warn")).toHaveLength(1);
  });

  it("pagehide 释放存活锁（离开或进往返缓存），恢复时重新拿锁", async () => {
    const locks = fakeLocks([]);
    setup(memStorage(), "S2", () => 1_000_000, locks);
    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    await Promise.resolve();
    expect(locks.released).toEqual(["app.alive.S2"]);
    const ev = new Event("pageshow");
    Object.defineProperty(ev, "persisted", { value: true });
    window.dispatchEvent(ev);
    expect(locks.requested).toEqual(["app.alive.S2", "app.alive.S2"]);
  });

  it("锁查询迟迟不返回：3 秒后按心跳规则落定并记 warn，不永远悬着", async () => {
    vi.useFakeTimers();
    const storage = memStorage();
    storage.setItem(KEY, table({ S1: { openAt: 900_000, aliveAt: 995_000 } }));
    const { f, store } = setup(
      storage,
      "S2",
      () => 1_000_000,
      fakeLocks([], () => new Promise(() => undefined)),
    );
    vi.advanceTimersByTime(3000);
    expect(await f.settled).toMatchObject({ kind: "unknown" });
    expect(store.entries().some((e) => /查询存活锁失败/.test(e.msg))).toBe(true);
  });

  it("上一局的锁还在：确实开在别的窗口，判无法判定", async () => {
    const storage = memStorage();
    storage.setItem(KEY, table({ S1: { openAt: 900_000, aliveAt: 995_000 } }));
    const { f } = setup(storage, "S2", () => 1_000_000, fakeLocks(["app.alive.S1"]));
    expect(await f.settled).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/仍开在其他窗口/) });
  });

  it("pagehide 写本局告别并落盘；下次启动判正常", () => {
    const storage = memStorage();
    const { store } = setup(storage);
    store.log("app").info("干活");
    window.dispatchEvent(new Event("pagehide"));
    expect(rows(storage).S2!.exitAt).toBe(1_000_000);
    expect(storage.data.get("app.log")).toContain("页面告别");
    expect(setup(storage, "S3", () => 2_000_000).f.verdict).toEqual({ kind: "clean", endedAt: 1_000_000 });
  });

  it("两个窗口共用存储：各写各的行，一个关掉不影响另一个；不会把仍在运行的窗口判成异常", () => {
    const storage = memStorage();
    let now = 1_000_000;
    setup(storage, "A", () => now);
    now += 1000;
    const b = setup(storage, "B", () => now);
    expect(b.f.verdict).toMatchObject({ kind: "unknown" }); // A 刚有心跳，可能还开着
    now += 1000;
    window.dispatchEvent(new Event("pagehide")); // 两个实例都收到：各自只改自己那行
    expect(rows(storage).A!.exitAt).toBe(now);
    expect(rows(storage).B!.exitAt).toBe(now);
  });

  it("从往返缓存恢复：撤销本局告别，否则下次会误判正常关闭", () => {
    const storage = memStorage();
    setup(storage);
    window.dispatchEvent(new Event("pagehide"));
    const ev = new Event("pageshow");
    Object.defineProperty(ev, "persisted", { value: true });
    window.dispatchEvent(ev);
    expect(rows(storage).S2!.exitAt).toBeUndefined();
  });

  it("定时心跳与切后台都刷新存活时刻；dispose 后不再写", () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const storage = memStorage();
    const { f } = setup(storage, "S2", () => now);
    now = 1_030_000;
    vi.advanceTimersByTime(HB);
    expect(rows(storage).S2!.aliveAt).toBe(1_030_000);
    now = 1_040_000;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    expect(rows(storage).S2!.aliveAt).toBe(1_040_000);
    f.dispose();
    now = 9_999_000;
    vi.advanceTimersByTime(HB * 2);
    expect(rows(storage).S2!.aliveAt).toBe(1_040_000);
  });

  it("会话表只留最近若干行，不无限增长", () => {
    const storage = memStorage();
    const old: Record<string, Row> = {};
    for (let i = 0; i < 20; i++) old[`O${i}`] = { openAt: i, aliveAt: i, exitAt: i };
    storage.setItem(KEY, table(old));
    setup(storage);
    expect(Object.keys(rows(storage)).sort()).toEqual(["O15", "O16", "O17", "O18", "O19", "S2"]);
  });

  it("存储读写抛错：不打断页面，判无法判定；同类写失败只记一次日志", () => {
    vi.useFakeTimers();
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    const { f, store } = setup(throwing);
    expect(f.verdict).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/SecurityError/) });
    vi.advanceTimersByTime(HB * 5);
    expect(() => window.dispatchEvent(new Event("pagehide"))).not.toThrow();
    expect(store.entries().filter((e) => /写入失败/.test(e.msg))).toHaveLength(1);
  });

  it("不传 storage 且全局 localStorage 访问即抛：不白屏，判无法判定", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      const store = createLogStore({ key: "x.log", storage: null, sessionStorage: null, console: null, env: () => [] });
      const f = startForensics({ prefix: "x", store });
      disposers.push(
        () => f.dispose(),
        () => store.dispose(),
      );
      expect(f.verdict).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/存储不可用/) });
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
