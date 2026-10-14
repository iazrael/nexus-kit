import type { ProcessProbe } from "./worktree.ts";
/** 进程是否还在：只有 ESRCH 算不在（EPERM = 在，只是无权发信号） */
export declare function pidAlive(pid: number): boolean;
/** 同步睡眠（锁轮询、等进程退出用） */
export declare function sleepMs(ms: number): void;
/**
 * pm2 jlist 输出 → 应用列表。daemon 没在跑时 pm2 会先往 stdout 打「[PM2] Spawning...」之类的横幅，
 * JSON 在单独一行：从后往前取第一行能解析成数组的。解析不出返回 null（调用方当作没有 pm2 应用并告警）。
 */
export declare function parsePm2List(raw: string): Array<{
    name: string;
    cwd: string;
}> | null;
export declare function systemProcessProbe(): ProcessProbe;
