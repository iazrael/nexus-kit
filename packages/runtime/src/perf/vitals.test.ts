import { describe, expect, it } from "vitest";
import { VitalRing, trendOf, type VitalSample } from "./vitals.ts";

/** t 是墙钟毫秒 */
const s = (t: number, v: Record<string, number | null>): VitalSample => ({ t, v });

describe("VitalRing", () => {
  it("环形写满后按时间顺序返回最近 cap 个点", () => {
    const r = new VitalRing(3);
    for (let i = 1; i <= 5; i++) r.push(s(i, { a: i }));
    expect(r.series().map((x) => x.t)).toEqual([3, 4, 5]);
    r.clear();
    expect(r.series()).toEqual([]);
  });
});

describe("trendOf", () => {
  it("每项指标给首末值、净增与峰值（含峰值时刻）；峰值能抓到中间的瞬时叠加", () => {
    const t = trendOf([s(0, { mem: 10, dom: 100 }), s(5000, { mem: 80, dom: 100 }), s(10_000, { mem: 20, dom: 130 })]);
    expect(t.spanSec).toBe(10);
    expect(t.samples).toBe(3);
    expect(t.metrics.mem).toEqual({ first: 10, last: 20, delta: 10, peak: 80, peakAt: 5 });
    expect(t.metrics.dom).toEqual({ first: 100, last: 130, delta: 30, peak: 130, peakAt: 10 });
  });

  it("读数为 null（浏览器不提供）的点跳过；全为 null 的指标各项为 null；不足两点也能算", () => {
    const t = trendOf([s(0, { heap: null, a: 1 }), s(5000, { heap: null, a: null }), s(9000, { a: 4 })]);
    expect(t.metrics.heap).toEqual({ first: null, last: null, delta: null, peak: null, peakAt: null });
    expect(t.metrics.a).toEqual({ first: 1, last: 4, delta: 3, peak: 4, peakAt: 9 });
    expect(trendOf([])).toEqual({ samples: 0, spanSec: 0, metrics: {} });
  });
});
