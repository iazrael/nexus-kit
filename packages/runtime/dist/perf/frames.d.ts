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
export declare function createFrameMeter(options?: FrameMeterOptions): {
    startAuto(): void;
    stopAuto(): void;
    frameStart(): void;
    frameEnd(): void;
    /** 取本区间统计并清零（水位采样每 5 秒取一次） */
    takeWindow(): FrameWindow;
    hitches: () => Hitch[];
};
export type FrameMeter = ReturnType<typeof createFrameMeter>;
