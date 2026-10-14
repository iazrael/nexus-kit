/**
 * 帧统计：区间帧率、卡顿（帧间隔超过 hitchMs）次数与最差一帧，卡顿明细留最近 keepHitches 条。
 *
 * 两种来源：
 * - 宿主自己有渲染循环（游戏）：每帧首尾调 frameStart / frameEnd，帧间隔取相邻 frameStart，另得每帧工作耗时
 *   （frameStart→frameEnd）。宿主一调 frameStart 就停掉 rAF 自测，两边不重复计数；
 * - 普通应用：startAuto 用 requestAnimationFrame 自测帧间隔，只有帧率与卡顿。
 * 超过 1 秒的间隔算暂停（切后台时 rAF 停摆、宿主循环被冻结），不算卡顿，也不进帧率。
 * 时钟、墙钟与 rAF 可注入，单测手动推帧。
 */

export interface FrameWindow {
  /** 区间内的帧间隔数 */
  frames: number;
  /** 区间帧率；没有帧为 null */
  fps: number | null;
  /** 帧间隔超过 hitchMs 的次数 */
  hitches: number;
  /** 区间最差一帧（帧间隔 ms）；没有帧为 null */
  worstMs: number | null;
  /** 宿主驱动时每帧平均工作耗时 ms；rAF 自测为 null */
  workMs: number | null;
}

export interface Hitch {
  /** 墙钟时刻（epoch ms） */
  at: number;
  ms: number;
}

export interface FrameMeterOptions {
  hitchMs?: number;
  keepHitches?: number;
  /** 单调时钟，默认 performance.now */
  clock?: () => number;
  /** 墙钟，默认 Date.now（卡顿明细的时刻要能和日志对齐） */
  epoch?: () => number;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
}

const PAUSE_MS = 1000;

export function createFrameMeter(options: FrameMeterOptions = {}) {
  const hitchMs = options.hitchMs ?? 50;
  const keep = options.keepHitches ?? 200;
  const clock = options.clock ?? (() => performance.now());
  const epoch = options.epoch ?? Date.now;
  const raf = options.raf ?? ((cb: (t: number) => void) => requestAnimationFrame(cb));
  const caf = options.caf ?? ((id: number) => cancelAnimationFrame(id));

  let frames = 0;
  let spanMs = 0;
  let hitchCount = 0;
  let worst: number | null = null;
  let workSum = 0;
  let workN = 0;
  const hitchList: Hitch[] = [];
  let last: number | null = null;
  let rafId: number | null = null;
  let hostStart: number | null = null;
  let hostDriven = false;

  const interval = (t: number): void => {
    if (last !== null) {
      const dt = t - last;
      if (dt <= PAUSE_MS) {
        frames++;
        spanMs += dt;
        if (worst === null || dt > worst) worst = dt;
        if (dt > hitchMs) {
          hitchCount++;
          hitchList.push({ at: epoch(), ms: Math.round(dt) });
          if (hitchList.length > keep) hitchList.shift();
        }
      }
    }
    last = t;
  };

  const loop = (t: number): void => {
    interval(t);
    rafId = raf(loop);
  };

  return {
    startAuto(): void {
      if (hostDriven || rafId !== null) return;
      last = null;
      rafId = raf(loop);
    },
    stopAuto(): void {
      if (rafId !== null) caf(rafId);
      rafId = null;
    },
    frameStart(): void {
      if (!hostDriven) {
        hostDriven = true;
        if (rafId !== null) caf(rafId);
        rafId = null;
        last = null;
      }
      const t = clock();
      interval(t);
      hostStart = t;
    },
    frameEnd(): void {
      if (hostStart === null) return;
      workSum += clock() - hostStart;
      workN++;
      hostStart = null;
    },
    /** 取本区间统计并清零（水位采样每 5 秒取一次） */
    takeWindow(): FrameWindow {
      const w: FrameWindow = {
        frames,
        fps: frames > 0 && spanMs > 0 ? Math.round((frames / (spanMs / 1000)) * 10) / 10 : null,
        hitches: hitchCount,
        worstMs: worst === null ? null : Math.round(worst),
        workMs: workN > 0 ? workSum / workN : null,
      };
      frames = 0;
      spanMs = 0;
      hitchCount = 0;
      worst = null;
      workSum = 0;
      workN = 0;
      return w;
    },
    hitches: (): Hitch[] => [...hitchList],
  };
}

export type FrameMeter = ReturnType<typeof createFrameMeter>;
