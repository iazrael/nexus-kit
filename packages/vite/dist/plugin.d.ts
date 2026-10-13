import type { PluginOption } from "vite";
import { type ManifestOptions } from "vite-plugin-pwa";
import { type ChangelogOptions } from "./changelog.ts";
import { type RuntimePartitionSpec } from "./runtime-cache.ts";
/** 壳预缓存默认收录：构建产物 + 图标。字体等按项目经 precache.globPatterns 追加——默认值不放
 *  可能不存在的目录：glob 不匹配只报 warning，噪音警告会让真正的漏配（换后缀忘改）被忽略 */
export declare const DEFAULT_GLOB_PATTERNS: readonly string[];
export interface NexusPwaOptions {
    /** vite 命令（defineConfig(({ command }) => …) 传入）：build 才递增构建号、实测分区指纹 */
    command: "build" | "serve";
    /** 应用 id：运行时缓存仓名前缀（小写字母、数字、连字符） */
    appId: string;
    /** 应用根（package.json、CHANGELOG.md、public/ 所在目录），通常传 import.meta.dirname */
    root: string;
    /** Web App Manifest；display/start_url/lang 有默认值 */
    manifest: Partial<ManifestOptions> & {
        name: string;
    };
    /** CHANGELOG 路径（相对 root），默认 CHANGELOG.md */
    changelog?: string;
    /** version.json 携带的已发版本数，默认 30 */
    releasesMax?: number;
    changelogOptions?: ChangelogOptions;
    /** 运行时缓存分区（按需资源）；为空则不生成运行时路由与清理脚本 */
    runtimePartitions?: readonly RuntimePartitionSpec[];
    /** 预缓存补充收录/排除（追加在默认值后）与根目录零散小件 */
    precache?: {
        globPatterns?: readonly string[];
        globIgnores?: readonly string[];
        includeAssets?: readonly string[];
        /** globIgnores 优先于 globPatterns：被忽略目录里的单条例外只能走这里（url + 内容哈希 revision） */
        additionalManifestEntries?: ReadonlyArray<{
            url: string;
            revision: string;
        }>;
    };
    /** 未开放功能泄漏门禁：Unreleased 与当前版本的对外条目提到关键词即构建失败 */
    wipGuard?: {
        keywords: readonly string[];
        allow?: readonly string[];
    };
    /** 构建计数器路径，默认 <root>/.build-number */
    buildCounterPath?: string;
}
/** 读 package.json 产品版本（纯 X.Y.Z，构建脚本不替用户决定版本） */
export declare function readPkgVersion(root: string): string;
/** 本版对外条目指纹：与 version.json 同一解析口径、与运行时同一指纹函数 */
export declare function currentNotesDigest(changelog: string | null, version: string, opts?: ChangelogOptions): string;
export declare function assertNoWipLeaks(changelog: string | null, version: string, guard: NonNullable<NexusPwaOptions["wipGuard"]>, opts?: ChangelogOptions): void;
export declare function nexusPwa(options: NexusPwaOptions): PluginOption[];
