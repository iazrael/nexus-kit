export interface RuntimePartitionSpec {
    /** 分区 id（进仓名，只用小写字母、数字、连字符） */
    readonly id: string;
    /** 归入本分区的目录前缀（相对 public 根，以 / 结尾），如 "data/" */
    readonly dirs: readonly string[];
    /** 从 dirs 里排除的子目录前缀（交给更细的分区），如 "data/maps/" */
    readonly exclude?: readonly string[];
    /** ExpirationPlugin 条数上限（最久没用先删）；按单文件均量与典型使用半径实测标定 */
    readonly maxEntries: number;
}
export interface RuntimePartition extends RuntimePartitionSpec {
    /** 对完整 URL 匹配（workbox RegExp 路由口径） */
    readonly pattern: RegExp;
}
/** 校验分区声明并生成路由正则：id 合法唯一、前缀格式正确、上限为正整数、两两不相交 */
export declare function definePartitions(specs: readonly RuntimePartitionSpec[]): RuntimePartition[];
/** 站内路径（/data/...）归哪个分区；不是运行时资源返回 null。与 sw.js 路由同一组正则 */
export declare function partitionOf(partitions: readonly RuntimePartition[], pathname: string): string | null;
/**
 * 各分区内容指纹（sha256 前 12 位）：相对路径 + 内容逐个喂入，路径补 NUL 分帧杜绝拼接
 * 歧义；分区内没有文件记 null（资源没生成——交给 runtimeCacheNames 报错，不在这里造名）
 */
export declare function computePartitionFingerprints(publicDir: string, partitions: readonly RuntimePartition[]): Record<string, string | null>;
/** 运行时仓名公共前缀 */
export declare const runtimeCachePrefix: (appId: string) => string;
/** 各分区运行时仓名；有分区没指纹（空分区）直接抛错——sw.js 不得写出 -null 仓名 */
export declare function runtimeCacheNames(partitions: readonly RuntimePartition[], fingerprints: Record<string, string | null>, appId: string): Record<string, string>;
/**
 * 旧运行时仓清理脚本（sw.js 经 importScripts 引入，activate 时执行）：workbox 自带的
 * cleanupOutdatedCaches 只清预缓存仓，运行时仓归这里——凡前缀开头而不在本版名单的仓
 * 一律删除。名单直接写进脚本：删错的唯一后果是重下资源，不会拿错内容；清理失败只记
 * 日志不阻断激活。
 */
export declare function cleanupScriptSource(currentNames: readonly string[], appId: string): string;
/** 清理脚本文件名带内容指纹：每代名单一个新 URL，CDN/浏览器缓存不可能把旧名单递给新 SW */
export declare function cleanupScriptFileName(currentNames: readonly string[], appId: string): string;
