import type { ReleaseConfig } from "../config/config.ts";
export declare const RELEASE_LOCK = "nexus-release.lock";
/** 发版执行人持令豁免的环境变量 */
export declare const TOKEN_ENV = "NEXUS_RELEASE_TOKEN";
export interface ReleaseLock {
    /** 发布中的版本；release --lock 放锁时还不知道，记 "pending" */
    version: string;
    token: string;
    /** 被冻结的引用，如 refs/heads/main */
    ref: string;
    startedAt: string;
    /** 失效时刻（epoch 秒，与钩子里 date +%s 同单位） */
    expires: number;
    pid: number;
}
/** 读锁（不存在、不是 JSON、缺字段 → null） */
export declare function readReleaseLock(path: string): ReleaseLock | null;
/**
 * 手动放锁（release --lock）：发版令下达即冻结主干，直到发版链收锁。已有未过期锁拒绝重放；
 * 过期锁替换。返回新锁（调用方把 token 告诉发版执行人）。
 */
export declare function holdReleaseLock(commonDir: string, opts: {
    ref: string;
    ttlMin: number;
    now: Date;
    token: string;
    pid: number;
}): ReleaseLock;
/** 清锁；返回是否真删了 */
export declare function clearReleaseLock(commonDir: string): boolean;
export interface ReleaseDeps {
    /** 在调用目录执行 git，返回去掉首尾空白的 stdout；失败抛错 */
    git(args: readonly string[]): string;
    /** 执行发版步骤（输出直通终端）；失败抛错 */
    run(cmd: string, args: readonly string[]): void;
    log(message: string): void;
    now(): Date;
    /** 随机令牌 */
    token(): string;
    pid: number;
    /** CHANGELOG 里 `## [version]` 小节的日期与全量条目（含留档条目）；没有该小节 → null */
    changelogSection(markdown: string, version: string): {
        date: string;
        entries: string[];
    } | null;
    internalPrefix: string;
    wipPrefix: string;
}
export interface ReleaseInput {
    /** 调用目录（必须是主仓库根） */
    repoRoot: string;
    /** 应用根绝对路径（package.json 与 dist/ 所在） */
    appRoot: string;
    changelogPath: string;
    /** 主干分支 */
    base: string;
    config: ReleaseConfig;
    /** 发版前两道门禁（全量变更整体评审 + 对外条目实机走查）已完成 */
    ack: boolean;
}
export declare function runRelease(input: ReleaseInput, deps: ReleaseDeps): void;
