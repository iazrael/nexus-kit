/**
 * PWA 配置唯一出处：vite.config.ts（构建）与 scripts/verify-build.ts（构建后门禁）共用，
 * 两边不可能分歧。改应用名、运行时缓存分区只改这里。
 */
import type { RuntimePartitionSpec } from "@nexus-kit/vite";

/** 运行时缓存仓名前缀（小写字母、数字、连字符）；上线后不要改，改了等于让用户重下全部按需资源 */
export const APP_ID = "nexus-app";

export const APP_NAME = "Nexus App";

/**
 * 按需资源（文件名不带哈希、不进首装壳）的缓存分区：按变化频率切，一个分区内任一文件变化
 * 整个分区换新仓。没有按需资源时留空数组。示例：
 *   { id: "data", dirs: ["data/"], maxEntries: 200 }
 */
export const RUNTIME_PARTITIONS: RuntimePartitionSpec[] = [];
