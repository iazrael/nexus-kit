/**
 * 离线首玩补缓存（机制见 docs/架构算法/离线与升级.md §2）。
 *
 * SW 推到空闲期才注册（免与首屏抢带宽），此前本会话下载的运行时资源都绕过了 SW，
 * 运行时缓存里一条没有——用过一次就断网会打不开。SW 首次装好时（控制器的
 * onOfflineReady），把「本会话已下载的同源运行时资源」清单用 workbox 内置的
 * `CACHE_URLS` 消息交给 SW，由各自的运行时路由补存；多数命中 HTTP 缓存，不重下。
 *
 * 清单来源：页面 Resource Timing + 宿主登记的额外地址（Worker 里取的资源页面时间线
 * 看不见）。expand 供宿主按自己的资源格式派生关联文件（如图集 JSON → 同名页图）。
 */
import type { PwaLogger } from "./controller.ts";
export interface WarmUrlOptions {
    /** 运行时缓存域前缀（与 SW 运行时路由同口径；壳文件走预缓存不收），如 ["/data/", "/assets-lazy/"] */
    prefixes: readonly string[];
    /** 额外地址（Worker 里取的资源） */
    extra?: Iterable<string>;
    /** 由一条命中路径派生关联路径 */
    expand?: (path: string) => readonly string[];
}
/** 汇总要补存的站内路径（去重、排序、只收同源且落在运行时前缀内的） */
export declare function collectWarmUrls(entries: ReadonlyArray<{
    name: string;
}>, origin: string, opts: WarmUrlOptions): string[];
/** 补存回执超时：workbox 按条 Promise.all 聚合，任一条取不到整批不回执——超时不代表全失败 */
export declare const WARM_ACK_TIMEOUT_MS = 60000;
/**
 * 把清单交 SW 补存；成功 resolve（宿主据此提示「已可离线使用」），失败/超时 reject。
 * 补存失败不影响使用，只是那次断网可能打不开——调用方记日志即可，不要对用户承诺。
 */
export declare function warmRuntimeCache(urls: readonly string[], logger?: PwaLogger): Promise<void>;
