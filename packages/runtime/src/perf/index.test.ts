// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogStore } from "../log/store.ts";
import type { StorageLike } from "../util.ts";
import { createPerf, type PerfOptions } from "./index.ts";

function mem(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  vi.useRealTimers();
});

function setup(over: Partial<PerfOptions> = {}, session = "S2", storage = mem()) {
  let epoch = Date.UTC(2026, 9, 14, 2, 0, 0);
  let now = 1000;
  const store = createLogStore({ key: "app.log", storage: null, sessionStorage: null, console: null, session, env: () => [] });
  const perf = createPerf({
    prefix: "app",
    store,
    version: "v1.0.0",
    build: 7,
    storage,
    raf: () => 0,
    caf: () => undefined,
    clock: () => now,
    epoch: () => epoch,
    performance: {
      memory: { usedJSHeapSize: 30 * 1024 * 1024 },
      getEntriesByType: (type: string) =>
        type === "navigation"
          ? [
              {
                redirectStart: 0,
                redirectEnd: 0,
                workerStart: 0,
                fetchStart: 5,
                requestStart: 10,
                responseStart: 60,
                responseEnd: 80,
                domInteractive: 200,
                domContentLoadedEventEnd: 260,
                loadEventEnd: 0,
              },
            ]
          : [{ name: "https://a.com/a.js?x=1", duration: 90, transferSize: 2048, decodedBodySize: 2048 }],
    },
    ...over,
  });
  disposers.push(
    () => perf.dispose(),
    () => store.dispose(),
  );
  return { store, perf, storage, tick: (ms: number) => ((epoch += ms), (now += ms)) };
}

describe("createPerf", () => {
  it("采样：内置指标（JS 堆、DOM 节点、帧统计）与宿主登记的指标；读数抛错记 null 不中断；注销后不再采", () => {
    const { perf } = setup();
    const off = perf.registerGauge("精灵数", () => 42);
    perf.registerGauge("坏指标", () => {
      throw new Error("渲染库内部结构变了");
    });
    const s = perf.sampleNow();
    expect(s.v).toMatchObject({ heapMB: 30, 精灵数: 42, 坏指标: null, fps: null, hitches: 0 });
    expect(typeof s.v.dom).toBe("number");
    off();
    expect("精灵数" in perf.sampleNow().v).toBe(false);
  });

  it("宿主驱动帧：帧统计进采样点（帧率、卡顿、每帧工作耗时）", () => {
    const { perf, tick } = setup();
    for (const dt of [16, 16, 80]) {
      perf.frameStart();
      tick(4);
      perf.frameEnd();
      tick(dt - 4);
    }
    perf.frameStart(); // 帧间隔量的是相邻两次 frameStart：补一帧才量得到最后那个 80ms
    tick(4);
    perf.frameEnd();
    const s = perf.sampleNow();
    expect(s.v).toMatchObject({ hitches: 1, workMs: 4 });
    expect(s.v.fps).toBeGreaterThan(0);
  });

  it("定时采样并写盘；页面隐藏时补采并写盘；下一局能读到上一局最后的水位，导出里标明是哪一局", () => {
    vi.useFakeTimers();
    const storage = mem();
    const { perf } = setup({ sampleMs: 5000 }, "S1", storage);
    perf.start();
    vi.advanceTimersByTime(10_000);
    expect(perf.series()).toHaveLength(3); // 启动即采一个基线点 + 两次定时
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    expect(perf.series()).toHaveLength(4);
    perf.dispose();
    const next = setup({}, "S2", storage);
    const text = next.store.exportText();
    expect(text).toMatch(/## 其他会话最后的水位\n会话 S1：4 个点/);
    expect(next.perf.exportJsonl()).toMatch(/"kind":"savedVital","session":"S1"/);
  });

  it("时间点、阶段耗时与启动画像；画像落盘、进导出摘要", async () => {
    const { perf, store, tick, storage } = setup();
    perf.milestone("mounted");
    perf.span("读存档", () => tick(120));
    await perf.spanAsync("拉配置", new Promise<void>((r) => setTimeout(r, 5)));
    const trace = perf.captureBoot("mounted");
    expect(trace).toMatchObject({
      sid: "S2",
      version: "v1.0.0",
      build: 7,
      phase: "mounted",
      milestones: { mounted: 1000 },
      spans: { 读存档: 120 },
    });
    expect(trace.res.js).toEqual({ n: 1, kb: 2, cached: 0, ms: 90 });
    expect(storage.data.get("app.boot")).toContain('"sid":"S2"');
    const text = store.exportText();
    expect(text).toMatch(/## 启动画像\n.*v1\.0\.0（构建 7）· mounted/);
    expect(text).toMatch(/最慢 https:\/\/a\.com\/a\.js 90ms/);
    expect(store.entries().some((e) => e.m === "perf" && /启动画像/.test(e.msg))).toBe(true);
  });

  it("导出：走势摘要节与 JSONL 附录（一行一条、首键 kind），复制到聊天的版本不带附录", () => {
    const { perf, store, tick } = setup();
    perf.registerGauge("tex", () => 10);
    perf.sampleNow();
    tick(5000);
    perf.sampleNow();
    perf.captureBoot("mounted");
    const text = store.exportText();
    expect(text).toMatch(/## 性能走势\n2 个点，跨 5 秒/);
    expect(text).toMatch(/heapMB 30 → 30/);
    const jsonl = perf.exportJsonl().trim().split("\n");
    expect(jsonl.every((l) => (Object.keys(JSON.parse(l) as object)[0] ?? "") === "kind")).toBe(true);
    expect(jsonl.map((l) => (JSON.parse(l) as { kind: string }).kind)).toEqual(expect.arrayContaining(["meta", "trend", "vital", "boot"]));
    expect(text).toMatch(/## 性能数据（JSONL）\n\{"kind":"meta"/);
    expect(store.exportText({ appendix: false })).not.toContain("性能数据（JSONL）");
  });

  it("指标读数抛错：记 null，并在日志里按指标与原因只记一条 warn", () => {
    const { perf, store } = setup();
    perf.registerGauge("坏指标", () => {
      throw new Error("内部结构变了");
    });
    perf.sampleNow();
    perf.sampleNow();
    const warns = store.exportText().match(/WARN {2}\[perf\] 指标读数失败.*坏指标.*内部结构变了/g) ?? [];
    expect(warns).toHaveLength(1);
  });

  it("指标名不能占用内置指标与 JSONL 行字段（fps、dom、t、kind、session……）", () => {
    const { perf } = setup();
    for (const name of ["fps", "dom", "heapMB", "t", "kind", "session"]) expect(() => perf.registerGauge(name, () => 1)).toThrow(/保留/);
  });

  it("存储用量：start 时读一次，之后最多每 60 秒读一次；读失败记一条 warn，不静默", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let fail = false;
    const { perf, store } = setup({
      sampleMs: 5000,
      clock: () => Date.now(), // 假定时器推进的是 Date
      estimateStorage: async () => {
        calls++;
        if (fail) throw new Error("配额接口被禁用");
        return { usage: 5 * 1024 * 1024 };
      },
    });
    perf.start();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(perf.series().at(-1)?.v.storageMB).toBe(5);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(calls).toBe(1);
    fail = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(2);
    expect(store.exportText()).toMatch(/WARN {2}\[perf\] .*存储用量.*配额接口被禁用/);
  });

  it("dispose 之后不能再 start（摘要节已注销，静默跑会少数据）", () => {
    const { perf } = setup();
    perf.dispose();
    expect(() => perf.start()).toThrow(/dispose/);
  });

  it("不支持的浏览器 API（无 performance.memory、无 getEntriesByType）：对应读数为 null / 画像为空，不抛", () => {
    const { perf } = setup({ performance: {} });
    expect(perf.sampleNow().v.heapMB).toBeNull();
    expect(perf.captureBoot("mounted")).toMatchObject({ nav: null, res: {}, slowest: [] });
  });
});
