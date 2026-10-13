import { type ChangelogOptions } from "./changelog.ts";
import { type RuntimePartitionSpec } from "./runtime-cache.ts";
export interface BuildBudgets {
    /** 单张首屏预载图上限（KB） */
    preloadImageKB?: number;
    /** 预缓存总量上限（KB） */
    precacheKB?: number;
    /** 首屏关键路径合计上限（brotli 压缩后 KB）：index.html + 预载图 + 入口 JS/CSS/modulepreload + extraCriticalUrls */
    criticalKB?: number;
    /** 计入首屏关键路径的额外站内地址（如首屏必取的数据 JSON） */
    extraCriticalUrls?: readonly string[];
}
export interface VerifyBuildOptions {
    /** 应用根（package.json、CHANGELOG.md、public/、dist/ 所在） */
    root: string;
    /** 与 nexusPwa 同值 */
    appId: string;
    /** dist 目录（相对 root），默认 dist */
    distDir?: string;
    /** manifest.name 期望值（不传不校验） */
    manifestName?: string;
    changelog?: string;
    changelogOptions?: ChangelogOptions;
    /** 与 nexusPwa 同一份声明 */
    runtimePartitions?: readonly RuntimePartitionSpec[];
    budgets?: BuildBudgets;
}
export interface VerifyReport {
    version: string;
    build: number;
    precacheEntries: number;
    precacheKB: number;
    criticalKB: number | null;
}
/** sw.js 里 workbox precacheAndRoute 的条目 url */
export declare function parsePrecacheUrls(sw: string): string[];
/** index.html 里的站内预载图与入口 JS/CSS（含 modulepreload） */
export declare function parseHtmlRefs(html: string): {
    preloadImages: string[];
    entryAssets: string[];
};
export declare function verifyPwaBuild(opts: VerifyBuildOptions): VerifyReport;
