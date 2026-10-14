import { describe, expect, it } from "vitest";
import { createFrameMeter } from "./frames.ts";

/** 假 rAF：手动推帧 */
function fakeRaf() {
  let cb: ((t: number) => void) | null = null;
  let id = 0;
  return {
    raf: (f: (t: number) => void) => ((cb = f), ++id),
    caf: () => void (cb = null),
    tick: (t: number) => {
      const f = cb;
      cb = null;
      f?.(t);
    },
    pending: () => cb !== null,
  };
}

describe("createFrameMeter（rAF 自测）", () => {
  it("区间帧率、卡顿数（>50ms）与最差一帧；取一次清零", () => {
    const r = fakeRaf();
    let now = 0;
    const m = createFrameMeter({ raf: r.raf, caf: r.caf, clock: () => now, epoch: () => 1_000_000 + now });
    m.startAuto();
    for (const t of [0, 16, 33, 50, 120, 136]) r.tick(t); // 5 个间隔，一个 70ms
    now = 1000;
    const w = m.takeWindow();
    expect(w.frames).toBe(5);
    expect(w.hitches).toBe(1);
    expect(w.worstMs).toBe(70);
    expect(w.fps).toBeCloseTo(5 / ((136 - 0) / 1000), 0);
    expect(m.hitches()).toEqual([{ at: 1_000_000, ms: 70 }]); // at 记的是墙钟（epoch）
    expect(m.takeWindow()).toMatchObject({ frames: 0, fps: null, worstMs: null, hitches: 0 });
  });

  it("超过 1 秒的间隔算暂停（切后台 rAF 停摆），不算卡顿；stopAuto 后不再推帧", () => {
    const r = fakeRaf();
    const m = createFrameMeter({ raf: r.raf, caf: r.caf, clock: () => 0, epoch: () => 0 });
    m.startAuto();
    for (const t of [0, 16, 5000, 5016]) r.tick(t);
    expect(m.takeWindow()).toMatchObject({ frames: 2, hitches: 0 });
    m.stopAuto();
    expect(r.pending()).toBe(false);
  });

  it("卡顿明细只留最近 N 条", () => {
    const r = fakeRaf();
    const m = createFrameMeter({ raf: r.raf, caf: r.caf, clock: () => 0, epoch: () => 0, keepHitches: 3 });
    m.startAuto();
    let t = 0;
    r.tick(t);
    for (let i = 0; i < 5; i++) r.tick((t += 60 + i));
    expect(m.hitches().map((h) => h.ms)).toEqual([62, 63, 64]);
  });
});

describe("createFrameMeter（宿主驱动）", () => {
  it("frameStart 间隔算帧率与卡顿，frameStart→frameEnd 算每帧工作耗时；宿主一驱动就停掉 rAF 自测", () => {
    const r = fakeRaf();
    let now = 0;
    const m = createFrameMeter({ raf: r.raf, caf: r.caf, clock: () => now, epoch: () => now });
    m.startAuto();
    for (const [start, end] of [
      [0, 5],
      [16, 21],
      [80, 90],
    ] as const) {
      now = start;
      m.frameStart();
      now = end;
      m.frameEnd();
    }
    expect(r.pending()).toBe(false);
    const w = m.takeWindow();
    expect(w.frames).toBe(2);
    expect(w.hitches).toBe(1);
    expect(w.workMs).toBeCloseTo((5 + 5 + 10) / 3, 5);
  });
});
