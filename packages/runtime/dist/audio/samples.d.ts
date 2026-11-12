/**
 * 样本播放器（机制见 docs/架构算法/音频.md）：建在引擎宿主上，管音频文件的解码缓存、音效与音乐。
 *
 * - 解码缓存：按字节预算 LRU（float32 PCM = 采样数 × 声道 × 4，属隐性内存，进 /perf 水位 audio.decodedMB）；
 *   同 key 在途去重；引擎重建时全清（AudioBuffer 跨 context 复用在 WebKit 上不保证），用到时懒解码补回。
 * - 失败分级：HTTP 错误码与解码失败是产物问题，永不重试；fetch 抛错（断网）下次再试；解码途中引擎被换不算失败。
 *   登记为已知缺失的 key 直接静默，不发注定 404 的请求。
 * - 音效 play：同 key 限频（墙钟，引擎重建后照样清账）；同时发声有上限，到顶先停优先级低、音量小的；没解码的
 *   现场解码，补播时限内解完才响，过时即丢（晚到的音比不响更糟）。预热走 /assets 调度器排队给首屏让路，真触发
 *   直接下载；同 key 的预热还在排队就先撤掉它。
 * - 音乐 playMusic / stopMusic：记账「应当在响的曲子」，取号仲裁晚到的解码结果；单次曲自然播完撤销意图；回到
 *   running 与引擎重建后按意图校对重启。
 *
 * 取材自旧项目A的音频实现（ThrottleGate、LatestIntentGate、远音让路、补播时效、失败分级、已知缺口）。
 */
import type { Loader, GaugeRegistry, Priority } from "../assets/loader.ts";
import type { Logger } from "../log/store.ts";
import type { AudioHost } from "./host.ts";
export interface SamplePlayerOptions {
    host: AudioHost;
    /** 预热排队用；真触发与音乐不经它 */
    loader: Loader;
    /** key → 文件地址 */
    urlOf: (key: string) => string;
    /** 解码缓存预算 MB，默认 32 */
    budgetMB?: number;
    /** 同时发声上限（不含音乐），默认 8 */
    maxVoices?: number;
    /** 同 key 限频窗口 ms，默认 50 */
    throttleMs?: number;
    /** 懒解码补播时限 ms，默认 300 */
    lateReplayMs?: number;
    /** 音效默认总线，默认 "sfx"；音乐默认总线 "music" */
    sfxBus?: string;
    musicBus?: string;
    /** 墙钟（限频与补播时限用）；默认 performance.now */
    clock?: () => number;
    /** 默认 globalThis.fetch */
    fetch?: (url: string) => Promise<Response>;
    log?: Logger;
    /** 传入时登记 audio.decodedMB */
    perf?: GaugeRegistry;
}
export interface PlayOptions {
    bus?: string;
    /** 0..1，默认 1 */
    gain?: number;
    /** 越大越重要；到顶时先停小的，默认 0 */
    priority?: number;
}
export interface MusicOptions {
    bus?: string;
    /** 默认 true；false 为单次曲，自然播完撤销意图 */
    loop?: boolean;
    gain?: number;
    /** 淡入毫秒，默认 0 */
    fadeMs?: number;
}
export interface SoundHandle {
    /** 淡出后停止；没起播的取消补播。幂等 */
    stop(fadeMs?: number): void;
}
export declare function createSamplePlayer(options: SamplePlayerOptions): {
    /** 登记已知缺失的 key（覆盖式）：命中直接静默，不发请求 */
    setKnownMissing(keys: Iterable<string>): void;
    /** 预热：经调度器排队下载解码（默认空闲档），不发声；没解锁时跳过 */
    warm(keys: Iterable<string>, priority?: Priority): void;
    play(key: string, opts?: PlayOptions): SoundHandle;
    /** 切音乐（同曲在播不重起）；未解锁先记下意图，解锁后补播 */
    playMusic(key: string, opts?: MusicOptions): void;
    stopMusic(fadeMs?: number): void;
    musicIntent: () => string | null;
    /** E2E 探针：累计调度数、活跃节点数（含音乐）、解码缓存、引擎状态 */
    snapshot(): {
        started: number;
        active: number;
        buffers: number;
        decodedMB: number;
        unlocked: boolean;
        rebuilds: number;
    };
    /** 停掉全部声音、清缓存、注销指标与引擎订阅；之后 play / playMusic / warm 不再工作，在飞的结果作废 */
    dispose(): void;
};
export type SamplePlayer = ReturnType<typeof createSamplePlayer>;
