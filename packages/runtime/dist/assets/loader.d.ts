/**
 * 加载调度器（机制见 docs/架构算法/图像资源.md）：管「什么时候发请求」。
 *
 * - 任务带档位（0 挡门 / 1 可见 / 2 附近 / 3 空闲），同档按次序值、再按提交先后；只给还没发出的任务排序，
 *   在飞的请求不打断（打断会白白浪费已下的字节）。
 * - 同一个 key 在排队或在飞时，后来的调用复用同一个结果，不发第二次；排队中的取更急的档位。
 *   key 必须唯一标识一份资源（通常就是 URL）：后来者的 run 不会被执行。
 * - 每个调用可带 AbortSignal：取消只拒绝它自己；全部调用方都取消、且任务还在排队时才出队、不发请求。
 * - hold(关键Promise, 封顶毫秒)：关键资源有结论（成或败）或时限到之前，档位 2、3 不发。新的 hold 取代旧闸门。
 *
 * 取材 旧项目A load/asset-scheduler.ts 与 critical-gate.ts。时钟可注入，单测不碰真定时器。
 */
import type { Logger } from "../log/store.ts";
export type Tier = 0 | 1 | 2 | 3;
export interface Priority {
    /** 0 挡门 / 1 可见 / 2 附近 / 3 空闲 */
    tier: Tier;
    /** 同档次序值，小的先发（例如与视口中心的距离）；默认 0 */
    order?: number;
}
/** 只用到 /perf 的登记接口：kit 内各子路径之间不互相 import 实现 */
export interface GaugeRegistry {
    registerGauge(name: string, read: () => number | null): () => void;
}
export interface LoaderOptions {
    /** 同时在飞的上限，默认 6（旧项目A 高延迟真机实测值，也是 HTTP/1.1 每域连接数的惯例） */
    concurrency?: number;
    /** 闸门封顶用的定时器，返回撤销函数；默认 setTimeout / clearTimeout */
    setTimer?: (fn: () => void, ms: number) => () => void;
    log?: Logger;
    /** 传入时登记 assets.queued / assets.running 两个水位指标 */
    perf?: GaugeRegistry;
}
export declare function createLoader(options?: LoaderOptions): {
    schedule<T>(key: string, priority: Priority, run: () => Promise<T>, opts?: {
        signal?: AbortSignal;
    }): Promise<T>;
    /** 改排队中任务的优先级（可升可降）；在飞或不存在返回 false */
    reprioritize(key: string, priority: Priority): boolean;
    /** 关键闸门：critical 有结论或 capMs 到期前，档位 2、3 不发。新的 hold 取代旧闸门 */
    hold(critical: Promise<unknown>, capMs: number): void;
    has: (key: string) => boolean;
    /** 任务在哪：排队中 / 在飞 / 不存在 */
    state(key: string): "queued" | "running" | null;
    snapshot(): {
        running: string[];
        queued: string[];
        gateOpen: boolean;
    };
    /** 注销水位指标（排队与在飞的任务不受影响） */
    dispose(): void;
};
export type Loader = ReturnType<typeof createLoader>;
