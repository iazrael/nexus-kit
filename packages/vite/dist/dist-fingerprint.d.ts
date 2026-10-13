/** 读构建产物目录（dist/assets）下全部 JS 文本；目录不存在返回空表（让断言报「找不到」而非 ENOENT） */
export declare function readBundleCodes(assetsDir: string): string[];
/**
 * 断言 bundle 代码里存在注入的构建号字面量（词边界匹配，10650/6500/0x650 不算
 * 命中 650）。找不到 = dist 半新半旧或 vite define 与 version.json 口径跑偏。
 */
export declare function assertInjectedBuild(bundleCodes: readonly string[], build: number): void;
