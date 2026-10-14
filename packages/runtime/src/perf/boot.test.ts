import { describe, expect, it } from "vitest";
import type { StorageLike } from "../util.ts";
import {
  captureBootTrace,
  formatBootTrace,
  groupResources,
  loadBootTraces,
  rollTraces,
  slowestResources,
  summarizeNavigation,
  type BootTrace,
} from "./boot.ts";

function mem(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const NAV = {
  redirectStart: 0,
  redirectEnd: 0,
  workerStart: 10,
  fetchStart: 30,
  requestStart: 40,
  responseStart: 140,
  responseEnd: 160,
  domInteractive: 300,
  domContentLoadedEventEnd: 420,
  loadEventEnd: 0,
};
const res = (name: string, duration: number, transferSize: number, decodedBodySize = transferSize) => ({
  name,
  duration,
  transferSize,
  decodedBodySize,
});

describe("summarizeNavigation", () => {
  it("分段耗时；SW 唤醒取 workerStart→fetchStart；load 还没发生为 null；没有导航条目为 null", () => {
    expect(summarizeNavigation(NAV)).toEqual({
      redirectMs: 0,
      swBootMs: 20,
      ttfbMs: 110,
      requestMs: 120,
      domParseMs: 140,
      dclMs: 420,
      loadMs: null,
    });
    expect(summarizeNavigation(undefined)).toBeNull();
  });
});

describe("groupResources / slowestResources", () => {
  it("按类型汇总：请求数、走网络的 KB、缓存命中数、耗时；最慢的几个去掉查询串", () => {
    const entries = [
      res("https://a.com/assets/index-x.js?v=1", 300, 80 * 1024),
      res("https://a.com/assets/index-x.css", 50, 0, 2000), // 缓存命中
      res("https://a.com/icon.png", 20, 1024),
      res("https://a.com/font.woff2", 90, 20 * 1024),
      res("https://a.com/version.json?t=1", 15, 300),
    ];
    expect(groupResources(entries)).toEqual({
      js: { n: 1, kb: 80, cached: 0, ms: 300 },
      css: { n: 1, kb: 0, cached: 1, ms: 50 },
      img: { n: 1, kb: 1, cached: 0, ms: 20 },
      font: { n: 1, kb: 20, cached: 0, ms: 90 },
      data: { n: 1, kb: 0.3, cached: 0, ms: 15 },
    });
    expect(slowestResources(entries, 2)).toEqual([
      { url: "https://a.com/assets/index-x.js", ms: 300, kb: 80 },
      { url: "https://a.com/font.woff2", ms: 90, kb: 20 },
    ]);
  });
});

describe("captureBootTrace / rollTraces / loadBootTraces", () => {
  const input = (sid: string, phase = "mounted") => ({
    sid,
    phase,
    version: "v1.0.0",
    build: 3,
    at: Date.UTC(2026, 9, 14),
    swControlled: true,
    nav: NAV,
    resources: [res("https://a.com/a.js", 100, 1024)],
    spans: { 读存档: 120 },
    milestones: { mounted: 480 },
  });

  it("采一条画像并落盘，留最近 keep 次；同一次启动再采覆盖前一条，不占两个名额", () => {
    const storage = mem();
    for (const sid of ["A", "B", "C"]) captureBootTrace(input(sid), { key: "boot", storage, keep: 2 });
    captureBootTrace(input("C", "loaded"), { key: "boot", storage, keep: 2 });
    const traces = loadBootTraces("boot", storage);
    expect(traces.map((t) => `${t.sid}:${t.phase}`)).toEqual(["C:loaded", "B:mounted"]);
    expect(traces[0]).toMatchObject({ swControlled: true, spans: { 读存档: 120 }, milestones: { mounted: 480 }, nav: { ttfbMs: 110 } });
  });

  it("坏条目丢掉、好条目保留；写失败（配额满）先退到只存这一条，再不行放弃，都不抛", () => {
    const storage = mem();
    storage.setItem(
      "boot",
      JSON.stringify([{ sid: 1 }, rollTraces([], captureBootTrace(input("OK"), { key: "x", storage: mem(), keep: 5 }))[0]]),
    );
    expect(loadBootTraces("boot", storage).map((t) => t.sid)).toEqual(["OK"]);
    let calls = 0;
    const tight: StorageLike = {
      getItem: () =>
        JSON.stringify(
          Array.from({ length: 4 }, (_, i) => ({ ...captureBootTrace(input(`P${i}`), { key: "y", storage: mem(), keep: 5 }) })),
        ),
      setItem: (_k, v) => {
        calls++;
        if (v.startsWith("[{") && (JSON.parse(v) as unknown[]).length > 1) throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    expect(() => captureBootTrace(input("NEW"), { key: "z", storage: tight, keep: 5 })).not.toThrow();
    expect(calls).toBe(2);
  });

  it("旧记录损坏、两级写盘都失败：经 onError 报原因，不静默", () => {
    const errors: string[] = [];
    const broken: StorageLike = {
      getItem: () => "{坏",
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    captureBootTrace(input("NEW"), { key: "z", storage: broken, keep: 5, onError: (e) => errors.push(e) });
    expect(errors.some((e) => /损坏/.test(e))).toBe(true);
    expect(errors.some((e) => /写盘失败.*Quota/.test(e))).toBe(true);
  });

  it("人读摘要一条几行：版本、是否 SW 接管、导航分段、阶段、网络、时刻、最慢资源", () => {
    const lines = formatBootTrace(captureBootTrace(input("A"), { key: "b", storage: null, keep: 5 }) as BootTrace);
    const text = lines.join("\n");
    expect(text).toMatch(/v1\.0\.0（构建 3）· mounted · SW 接管/);
    expect(text).toMatch(/首字节 110ms/);
    expect(text).toMatch(/读存档 120ms/);
    expect(text).toMatch(/js 1 个 1KB 100ms/);
    expect(text).toMatch(/mounted 480ms/);
    expect(text).toMatch(/最慢 https:\/\/a\.com\/a\.js 100ms/);
  });
});
