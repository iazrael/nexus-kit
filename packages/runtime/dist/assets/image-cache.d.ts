/**
 * 图像缓存（机制见 docs/架构算法/图像资源.md）：管「解码后的图放多久」。
 *
 * 解码位图加载即占进程内存（宽 × 高 × 4），与画没画到屏幕无关；只置空引用要等垃圾回收才释放，换页时新旧两份
 * 同时存活（旧项目A 性能与显存「显存之外」）。所以这里按引用计数持有、引用为零进 LRU、超预算从最久没用的开始
 * 淘汰，淘汰时立即 close() 并扣账，再通知宿主销毁自己基于它建的纹理。
 *
 * - acquire 经调度器下载并解码，同一张同时取只下一次；成功才占一个引用，失败或被取消不占。
 * - release 只对成功的 acquire 调；多释放记 warn 不抛。
 * - 被引用的图不淘汰：超预算就照实记账（预算管的是「不用了还留着」的那部分）。
 * - 失败不进缓存，下次 acquire 重新下载。
 */
import type { Logger } from "../log/store.ts";
import type { GaugeRegistry, Loader, Priority } from "./loader.ts";
export interface ImageCacheOptions {
    loader: Loader;
    /** 不再被引用的图最多留多少（与被引用的合计算），单位 MB */
    budgetMB: number;
    /** 默认 globalThis.fetch */
    fetch?: (url: string) => Promise<Response>;
    /** 默认 createImageBitmap */
    decode?: (blob: Blob) => Promise<ImageBitmap>;
    /** 淘汰后通知宿主（此时位图已 close）：宿主在这里销毁基于它上传的纹理 */
    onEvict?: (url: string) => void;
    /** 传入时登记 assets.bitmapMB / assets.bitmaps 两个水位指标 */
    perf?: GaugeRegistry;
    log?: Logger;
}
export interface ImageCacheStats {
    /** 已解码在内存里的张数 */
    images: number;
    /** 其中正被引用的张数 */
    referenced: number;
    /** 解码字节合计（宽 × 高 × 4） */
    bytes: number;
    /** 本局解码字节最高点 */
    peakBytes: number;
    budgetBytes: number;
    hits: number;
    misses: number;
    evictions: number;
}
export declare function createImageCache(options: ImageCacheOptions): {
    /** 取一张图并占一个引用；成功后用完调 release */
    acquire(url: string, priority: Priority, opts?: {
        signal?: AbortSignal;
    }): Promise<ImageBitmap>;
    /** 放回一个引用；引用为零进 LRU，超预算时可能被淘汰 */
    release(url: string): void;
    /** 已解码的图（不改引用、不算命中）；没有返回 undefined */
    peek: (url: string) => ImageBitmap | undefined;
    stats(): ImageCacheStats;
    /** 关掉全部位图（包括还在被引用的）、注销水位指标；之后在飞的加载下完即关，acquire 直接拒绝，release 忽略 */
    dispose(): void;
};
export type ImageCache = ReturnType<typeof createImageCache>;
