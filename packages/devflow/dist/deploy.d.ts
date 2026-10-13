import type { DeployConfig } from "./config.ts";
export interface DeployDeps {
    /** 本机执行命令，返回 stdout；失败抛错（错误对象带 status） */
    run(cmd: string, args: readonly string[]): string;
    /** 远端执行 shell 命令，返回 stdout；失败抛错（ssh 自身失败 status=255） */
    ssh(remoteCmd: string): string;
    log(message: string): void;
    readFile(path: string): string;
    exists(path: string): boolean;
    /** dist/assets 下全部 JS 文本 */
    readBundleCodes(assetsDir: string): string[];
    /** 断言 bundle 里有构建号字面量（@nexus-kit/vite assertInjectedBuild） */
    assertInjectedBuild(codes: readonly string[], build: number): void;
}
export interface DeployInput {
    config: DeployConfig;
    /** 应用根绝对路径 */
    appRoot: string;
}
export interface DeployResult {
    releaseName: string;
    previous: string | null;
    removed: string[];
}
/** 服务器 version.json 正文 → 「版本+构建号」；非 JSON 抛错 */
export declare function parseServedFingerprint(body: string): string;
/** 从 `ls releases` 输出挑出要清的旧版本（按构建号倒序，保留 keep 版，含本次） */
export declare function pickStaleReleases(listing: string, keep: number, current: string): string[];
/** 现役目录名 → 构建号（解析不出返回 null） */
export declare function buildOfReleaseDir(dir: string): number | null;
export declare function cacheControlOf(headers: string): string;
export declare function runDeploy(input: DeployInput, deps: DeployDeps): DeployResult;
