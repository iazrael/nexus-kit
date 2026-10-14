import { describe, expect, it } from "vitest";
import { createLoader } from "./loader.ts";

function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((y, n) => ((resolve = y), (reject = n)));
  return { promise, resolve, reject };
}

/** 手动定时器：run() 触发到期的回调 */
function manualTimers() {
  const list: Array<{ at: number; fn: () => void }> = [];
  let now = 0;
  return {
    pending: () => list.length,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn };
      list.push(t);
      return () => void (list.includes(t) && list.splice(list.indexOf(t), 1));
    },
    advance(ms: number) {
      now += ms;
      for (const t of list.filter((x) => x.at <= now)) {
        list.splice(list.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(concurrency = 2) {
  const timers = manualTimers();
  const started: string[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<string>>>();
  const logs: string[] = [];
  const loader = createLoader({
    concurrency,
    setTimer: timers.setTimer,
    log: {
      debug: () => undefined,
      info: (m, d) => logs.push(`${m} ${JSON.stringify(d)}`),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
  });
  const run = (key: string) => () => {
    started.push(key);
    const d = deferred();
    pending.set(key, d);
    return d.promise;
  };
  return { loader, timers, started, pending, logs, run };
}

describe("createLoader", () => {
  it("并发上限内按档位、同档按次序值、再按提交先后发出；在飞的不被后来的高优先级打断", async () => {
    const { loader, started, pending, run } = rig(2);
    void loader.schedule("a3", { tier: 3 }, run("a3"));
    void loader.schedule("b3", { tier: 3 }, run("b3"));
    void loader.schedule("c1-far", { tier: 1, order: 9 }, run("c1-far"));
    void loader.schedule("d1-near", { tier: 1, order: 1 }, run("d1-near"));
    void loader.schedule("e0", { tier: 0 }, run("e0"));
    expect(started).toEqual(["a3", "b3"]); // 先提交的先占满并发，不被打断
    pending.get("a3")!.resolve("ok");
    await flush();
    expect(started).toEqual(["a3", "b3", "e0"]);
    pending.get("b3")!.resolve("ok");
    await flush();
    expect(started.at(-1)).toBe("d1-near");
    expect(loader.snapshot().running.sort()).toEqual(["d1-near", "e0"]);
    expect(loader.snapshot().queued).toEqual(["c1-far"]);
  });

  it("同一 key 在排队或在飞时复用同一结果，不发第二次；排队中的取更急的档位", async () => {
    const { loader, started, pending, run } = rig(1);
    void loader.schedule("block", { tier: 0 }, run("block"));
    const p1 = loader.schedule("img", { tier: 3 }, run("img"));
    void loader.schedule("other", { tier: 2 }, run("other"));
    const p2 = loader.schedule("img", { tier: 1 }, run("img-dup"));
    expect(loader.snapshot().queued).toEqual(["img", "other"]); // 升到档位 1
    pending.get("block")!.resolve("x");
    await flush();
    const p3 = loader.schedule("img", { tier: 0 }, run("img-dup2")); // 在飞时
    pending.get("img")!.resolve("bitmap");
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(["bitmap", "bitmap", "bitmap"]);
    expect(started.filter((k) => k.startsWith("img"))).toEqual(["img"]);
    expect(loader.has("img")).toBe(false);
  });

  it("取消：只有一个调用方取消时只拒绝它自己；全部取消且还在排队才出队、不发请求；在飞的取消不打断", async () => {
    const { loader, started, pending, run } = rig(1);
    void loader.schedule("block", { tier: 0 }, run("block"));
    const a = new AbortController();
    const b = new AbortController();
    const pa = loader.schedule("img", { tier: 1 }, run("img"), { signal: a.signal });
    const pb = loader.schedule("img", { tier: 1 }, run("img"), { signal: b.signal });
    a.abort(new Error("滚走了"));
    await expect(pa).rejects.toThrow("滚走了");
    expect(loader.has("img")).toBe(true);
    b.abort();
    await expect(pb).rejects.toMatchObject({ name: "AbortError" });
    expect(loader.has("img")).toBe(false);
    pending.get("block")!.resolve("x");
    await flush();
    expect(started).toEqual(["block"]);
    // 在飞时取消：调用方拿到拒绝，请求照常跑完
    const c = new AbortController();
    const pc = loader.schedule("fly", { tier: 1 }, run("fly"), { signal: c.signal });
    expect(started).toContain("fly");
    c.abort();
    await expect(pc).rejects.toMatchObject({ name: "AbortError" });
    expect(loader.has("fly")).toBe(true);
    pending.get("fly")!.resolve("done");
    await flush();
    expect(loader.has("fly")).toBe(false);
    // 已取消的信号直接拒绝，不入队
    await expect(loader.schedule("dead", { tier: 1 }, run("dead"), { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(started).not.toContain("dead");
  });

  it("关键闸门：结论到之前档位 2、3 不发，档位 0、1 照发；关键资源失败也算有结论；放行原因进日志", async () => {
    const { loader, started, run, logs } = rig(4);
    const critical = deferred();
    loader.hold(critical.promise, 10_000);
    void loader.schedule("near", { tier: 2 }, run("near"));
    void loader.schedule("idle", { tier: 3 }, run("idle"));
    void loader.schedule("seen", { tier: 1 }, run("seen"));
    expect(started).toEqual(["seen"]);
    expect(loader.snapshot().gateOpen).toBe(false);
    critical.reject(new Error("关键图 404"));
    await flush();
    expect(started).toEqual(["seen", "near", "idle"]);
    expect(logs.some((l) => /关键闸门放行.*"by":"settled".*"held":2/.test(l))).toBe(true);
  });

  it("闸门有结论后撤掉封顶定时器（不拖住进程退出）；封顶时限非法直接抛", async () => {
    const { loader, timers } = rig();
    loader.hold(Promise.resolve(), 10_000);
    expect(timers.pending()).toBe(1);
    await flush();
    expect(timers.pending()).toBe(0);
    expect(() => loader.hold(Promise.resolve(), Number.NaN)).toThrow(RangeError);
    expect(() => loader.hold(Promise.resolve(), -1)).toThrow(RangeError);
  });

  it("关键闸门封顶：时限到照样放行，不让不急的饿死；新 hold 取代旧闸门，旧闸门到期不打开新闸门", async () => {
    const { loader, started, run, timers, logs } = rig(4);
    loader.hold(new Promise(() => undefined), 3000);
    void loader.schedule("idle", { tier: 3 }, run("idle"));
    timers.advance(1000);
    loader.hold(new Promise(() => undefined), 3000); // 新屏
    timers.advance(2000); // 旧闸门到期
    expect(started).toEqual([]);
    timers.advance(1000); // 新闸门到期
    expect(started).toEqual(["idle"]);
    expect(logs.some((l) => /关键闸门放行.*"by":"cap"/.test(l))).toBe(true);
  });

  it("任务抛错（同步或异步）只拒绝该任务，后面的照常发；参数非法直接抛", async () => {
    const { loader, started, run } = rig(1);
    const bad = loader.schedule("bad", { tier: 1 }, () => {
      throw new Error("同步炸");
    });
    void loader.schedule("next", { tier: 1 }, run("next"));
    await expect(bad).rejects.toThrow("同步炸");
    await flush();
    expect(started).toEqual(["next"]);
    expect(() => loader.schedule("", { tier: 1 }, run("x"))).toThrow();
    expect(() => loader.schedule("k", { tier: 5 as 1 }, run("x"))).toThrow(RangeError);
    expect(() => createLoader({ concurrency: 0 })).toThrow(RangeError);
  });

  it("reprioritize 只改排队中的任务；perf 登记排队与在飞数", async () => {
    const gauges = new Map<string, () => number | null>();
    const loader = createLoader({ concurrency: 1, perf: { registerGauge: (n, r) => (gauges.set(n, r), () => gauges.delete(n)) } });
    const never = () => new Promise<string>(() => undefined);
    void loader.schedule("a", { tier: 1 }, never);
    void loader.schedule("b", { tier: 3 }, never);
    void loader.schedule("c", { tier: 2 }, never);
    expect(loader.reprioritize("b", { tier: 0 })).toBe(true);
    expect(loader.reprioritize("a", { tier: 0 })).toBe(false);
    expect(loader.snapshot().queued).toEqual(["b", "c"]);
    expect(gauges.get("assets.queued")!()).toBe(2);
    expect(gauges.get("assets.running")!()).toBe(1);
    loader.dispose();
    expect(gauges.size).toBe(0);
  });
});
