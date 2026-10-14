/**
 * 启动画像：一次启动一条低频摘要，回答「点开图标白屏那几秒花在哪」。JS 开始执行前的耗时（SW 唤醒、首字节、
 * 下载与解析）只有 Navigation Timing / Resource Timing 记得，没人去读就等于没有。
 *
 * 一条画像：导航分段耗时、宿主记的阶段（span）与时间点（milestone）、按类型汇总的资源（请求数、走网络的字节、
 * 缓存命中数——区分「首次真下载」与「二次读缓存」，两种慢的治法完全不同）、最慢的几个资源（地址去查询串）、
 * 本次是否由 SW 接管。落盘 localStorage 留最近 keep 次（默认 5）；同一次启动（sid 相同）再采覆盖前一条——
 * 先在挂载时采一份兜底，load 之后再采一份完整的，不占两个名额。写失败先退到只存这一条，再不行放弃，不抛。
 *
 * 采集只读传入的数据（导航条目、资源条目），浏览器 API 的读取在 perf/index.ts，单测直接造条目。
 */
import { type StorageLike } from "../util.ts";
export type NavTimingLike = Pick<PerformanceNavigationTiming, "redirectStart" | "redirectEnd" | "workerStart" | "fetchStart" | "requestStart" | "responseStart" | "responseEnd" | "domInteractive" | "domContentLoadedEventEnd" | "loadEventEnd">;
export type ResTimingLike = Pick<PerformanceResourceTiming, "name" | "duration" | "transferSize" | "decodedBodySize">;
export interface NavSummary {
    redirectMs: number;
    /** SW 唤醒（workerStart→fetchStart）；SW 未参与为 0 */
    swBootMs: number;
    /** 首字节（fetchStart→responseStart） */
    ttfbMs: number;
    /** 请求全程（requestStart→responseEnd） */
    requestMs: number;
    /** HTML 解析到可交互（responseEnd→domInteractive） */
    domParseMs: number;
    /** DOMContentLoaded 结束的绝对时刻 */
    dclMs: number;
    /** load 结束的绝对时刻；采集时还没发生为 null */
    loadMs: number | null;
}
export interface ResGroup {
    n: number;
    /** 走了网络的传输 KB（缓存命中 transferSize 为 0，不计入） */
    kb: number;
    /** 缓存命中条数（transferSize 为 0 且有响应体） */
    cached: number;
    /** 耗时合计 ms（并发时大于墙钟，只作量级参考） */
    ms: number;
}
export interface SlowResource {
    url: string;
    ms: number;
    kb: number;
}
export interface BootTrace {
    /** 本次启动的会话号 */
    sid: string;
    /** 墙钟时刻（epoch ms） */
    at: number;
    /** 采到哪一步：mounted / loaded …… */
    phase: string;
    version: string;
    build: number;
    swControlled: boolean;
    nav: NavSummary | null;
    spans: Record<string, number>;
    milestones: Record<string, number>;
    res: Record<string, ResGroup>;
    slowest: SlowResource[];
}
export declare function summarizeNavigation(nav: NavTimingLike | undefined): NavSummary | null;
export declare function groupResources(entries: readonly ResTimingLike[]): Record<string, ResGroup>;
export declare function slowestResources(entries: readonly ResTimingLike[], n?: number): SlowResource[];
export declare function rollTraces(prev: readonly BootTrace[], next: BootTrace, keep?: number): BootTrace[];
/** 读已存的画像；读失败或不是合法 JSON 时经 onError 报原因并按空处理（下次写盘覆盖掉坏数据） */
export declare function loadBootTraces(key: string, storage: StorageLike | null, onError?: (reason: string) => void): BootTrace[];
export interface BootInput {
    sid: string;
    phase: string;
    version: string;
    build: number;
    at: number;
    swControlled: boolean;
    nav: NavTimingLike | undefined;
    resources: readonly ResTimingLike[];
    spans: Record<string, number>;
    milestones: Record<string, number>;
}
/** 采一条画像并落盘（读不到旧记录、写失败都不抛，原因交给 onError），返回这条画像 */
export declare function captureBootTrace(input: BootInput, persist: {
    key: string;
    storage: StorageLike | null;
    keep: number;
    onError?: (reason: string) => void;
}): BootTrace;
export declare function formatBootTrace(t: BootTrace): string[];
