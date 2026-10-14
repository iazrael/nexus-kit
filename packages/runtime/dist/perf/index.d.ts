/**
 * 性能采集入口（机制见 docs/架构算法/性能采集.md）：把帧统计、水位长线、跨会话保留、启动画像拼起来，接进日志导出。
 *
 * - 采样：start 后立刻采一个基线点，之后每 sampleMs（默认 5 秒）一次；页面隐藏时补采一次。每个点 = 本区间的帧统计
 *   （fps / hitches / worstMs / workMs）+ 内置指标（heapMB 只有 Chromium、dom、storageMB、longTasks / longTaskMs
 *   只有 Chromium）+ 宿主登记的指标。读不到或读数抛错记 null，不中断采样。
 * - 每次采样后把本局长线写盘（persist.ts）：下一局（或别的窗口）能读到这一局最后的水位。
 * - milestone / span / spanAsync 记时间点与阶段耗时，captureBoot 采一条启动画像（boot.ts）。
 * - 日志导出里注册三节摘要（启动画像、性能走势、其他会话最后的水位）与「性能数据（JSONL）」附录。
 *
 * 浏览器 API 全部可注入（performance、时钟、rAF、存储），单测不碰真环境。
 */
import type { LogStore } from "../log/store.ts";
import { type StorageLike } from "../util.ts";
import { type BootTrace } from "./boot.ts";
import { type Trend, type VitalSample } from "./vitals.ts";
export * from "./boot.ts";
export * from "./frames.ts";
export * from "./gl.ts";
export * from "./persist.ts";
export * from "./vitals.ts";
/** performance 里用到的部分 */
export interface PerformanceLike {
    memory?: {
        usedJSHeapSize?: number;
    };
    getEntriesByType?: (type: string) => unknown[];
}
export interface PerfOptions {
    /** 存储键前缀：`<prefix>.vitals`（水位）、`<prefix>.boot`（启动画像） */
    prefix: string;
    store: LogStore;
    version: string;
    build: number;
    /** 默认 localStorage */
    storage?: StorageLike | null;
    /** 采样间隔，默认 5000ms */
    sampleMs?: number;
    /** 内存长线点数，默认 2048（5 秒一点约 2.8 小时） */
    cap?: number;
    /** 每个会话写盘保留的点数，默认 120（约 10 分钟） */
    keepSamples?: number;
    /** 写盘保留的会话数（含本局），默认 3 */
    sessionsKept?: number;
    /** 启动画像保留次数，默认 5 */
    bootKeep?: number;
    /** 以下注入点默认取浏览器全局 */
    performance?: PerformanceLike;
    clock?: () => number;
    epoch?: () => number;
    raf?: (cb: (t: number) => void) => number;
    caf?: (id: number) => void;
    /** 默认 navigator.storage.estimate */
    estimateStorage?: () => Promise<{
        usage?: number;
    }>;
}
export declare function createPerf(o: PerfOptions): {
    /** 登记宿主指标；名字不得占用内置指标与 JSONL 行字段（见 RESERVED），否则抛错 */
    registerGauge(name: string, read: () => number | null): () => void;
    /** 记一个时间点（距导航开始的毫秒数） */
    milestone(name: string): void;
    span<T>(name: string, fn: () => T): T;
    spanAsync<T>(name: string, work: Promise<T>): Promise<T>;
    frameStart: () => void;
    frameEnd: () => void;
    sampleNow: () => VitalSample;
    series: () => VitalSample[];
    trend: () => Trend;
    captureBoot: (phase: string) => BootTrace;
    exportJsonl: () => string;
    start(): void;
    dispose(): void;
};
export type Perf = ReturnType<typeof createPerf>;
