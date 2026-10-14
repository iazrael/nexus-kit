import { describe, expect, it } from "vitest";
import { LogRing, mergeByTime, trimForPersist, type LogEntry } from "./ring.ts";

const e = (t: number, m: string, s = "S1", msg = `${m}@${t}`): LogEntry => ({ t, s, lv: "info", m, msg });

describe("LogRing", () => {
  it("不声明分区时只有一个默认区，满了淘汰最旧并计数", () => {
    const ring = new LogRing([{ name: "main", cap: 3 }]);
    for (let t = 1; t <= 5; t++) ring.push(e(t, "app"));
    expect(ring.entries().map((x) => x.t)).toEqual([3, 4, 5]);
    expect(ring.dropped()).toEqual({ main: 2 });
  });

  it("高频区冲满只淘汰本区：启动段那几条低频记录一条都不丢", () => {
    const ring = new LogRing([
      { name: "busy", cap: 3, modules: ["combat"] },
      { name: "calm", cap: 10 },
    ]);
    ring.push(e(1, "boot"));
    ring.push(e(2, "pwa"));
    for (let t = 3; t <= 100; t++) ring.push(e(t, "combat"));
    const out = ring.entries();
    expect(out.filter((x) => x.m !== "combat").map((x) => x.t)).toEqual([1, 2]);
    expect(out.filter((x) => x.m === "combat").map((x) => x.t)).toEqual([98, 99, 100]);
    expect(ring.dropped()).toEqual({ busy: 95, calm: 0 });
  });

  it("循环写满多圈后顺序与内容仍正确", () => {
    const ring = new LogRing([{ name: "main", cap: 4 }]);
    for (let t = 1; t <= 23; t++) ring.push(e(t, "app"));
    expect(ring.entries().map((x) => x.t)).toEqual([20, 21, 22, 23]);
    expect(ring.dropped()).toEqual({ main: 19 });
  });

  it("导出按时间归并成一条时间线；同一时刻保持写入次序", () => {
    const ring = new LogRing([
      { name: "busy", cap: 10, modules: ["combat"] },
      { name: "calm", cap: 10 },
    ]);
    ring.push(e(1, "boot"));
    ring.push(e(2, "combat"));
    ring.push(e(2, "save", "S1", "同刻后写"));
    ring.push(e(3, "combat"));
    expect(ring.entries().map((x) => `${x.t}${x.m}`)).toEqual(["1boot", "2combat", "2save", "3combat"]);
    ring.clear();
    expect(ring.entries()).toEqual([]);
  });

  it.each([
    [[], /至少一个/],
    [[{ name: "a", cap: 0 }], /cap/],
    [
      [
        { name: "a", cap: 1 },
        { name: "b", cap: 1 },
      ],
      /只能有一个默认区/,
    ],
    [[{ name: "a", cap: 1, modules: ["x"] }], /默认区/],
    [
      [
        { name: "a", cap: 1, modules: ["x"] },
        { name: "a", cap: 1 },
      ],
      /重名/,
    ],
    [
      [
        { name: "a", cap: 1, modules: ["x"] },
        { name: "b", cap: 1, modules: ["x"] },
        { name: "c", cap: 1 },
      ],
      /模块 x/,
    ],
  ])("非法分区声明被拒 %#", (domains, err) => {
    expect(() => new LogRing(domains)).toThrow(err);
  });
});

describe("mergeByTime", () => {
  it("多段各自有序的记录归并为整体有序", () => {
    expect(mergeByTime([[e(1, "a"), e(4, "a")], [e(2, "b")], [e(3, "c"), e(5, "c")]]).map((x) => x.t)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("trimForPersist", () => {
  const big = (t: number, s: string): LogEntry => e(t, "app", s, "x".repeat(90));

  it("只留最近 N 个会话（本次会话总在），按会话首条时间判新旧", () => {
    const all = [e(1, "a", "A"), e(2, "a", "B"), e(3, "a", "C"), e(4, "a", "D")];
    const r = trimForPersist(all, { sessionsKept: 2, charBudget: 1e6, current: "D" });
    expect(r.kept.map((x) => x.s)).toEqual(["C", "D"]);
    expect(r.droppedSessions).toBe(2);
    expect(r.droppedEntries).toBe(0);
  });

  it("可传入每条长度的缓存函数，结果与默认计算一致", () => {
    const all = [big(1, "A"), big(2, "B"), big(3, "C")];
    const calls: LogEntry[] = [];
    const sizeOf = (x: LogEntry): number => (calls.push(x), JSON.stringify(x).length + 1);
    const opts = { sessionsKept: 5, charBudget: 250, current: "C" };
    expect(trimForPersist(all, opts, sizeOf)).toEqual(trimForPersist(all, opts));
    expect(calls.length).toBeGreaterThan(0);
  });

  it("超总字符预算时整段淘汰最旧的会话，仍超才从本次会话最旧的条目开始丢", () => {
    const all = [big(1, "A"), big(2, "A"), big(3, "B"), big(4, "C"), big(5, "C"), big(6, "C")];
    const one = JSON.stringify(all[0]).length + 1;
    const r = trimForPersist(all, { sessionsKept: 5, charBudget: one * 3 + 2, current: "C" });
    expect(r.kept.map((x) => `${x.s}${x.t}`)).toEqual(["C4", "C5", "C6"]);
    expect(r.droppedSessions).toBe(2);

    const r2 = trimForPersist(all, { sessionsKept: 5, charBudget: one * 2 + 2, current: "C" });
    expect(r2.kept.map((x) => `${x.s}${x.t}`)).toEqual(["C5", "C6"]);
    expect(r2.droppedEntries).toBe(1);
    expect(JSON.stringify(r2.kept).length).toBeLessThanOrEqual(one * 2 + 2);
  });
});
