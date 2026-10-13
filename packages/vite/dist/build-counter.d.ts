export interface BumpOptions {
    /** 锁文件路径，默认计数器真实路径（软链解算后）旁的 <counter>.lock */
    lockPath?: string;
    /** 时钟注入（测试驱动超时/陈旧判定） */
    now?: () => number;
    /** 睡眠注入（测试不真睡） */
    sleep?: (ms: number) => void;
    /** 拿锁最长等待，超时放弃报错 */
    maxWaitMs?: number;
}
/** 确保计数器存在：缺失（CI / 新 clone / 主仓真身丢失）时以 0 建档并醒目警告 */
export declare function ensureBuildCounter(counterPath: string): void;
/** 读当前构建号；内容非法时报损坏 */
export declare function readBuildCounter(counterPath: string): number;
/**
 * 原子递增并返回新构建号。流程：拿排他锁（等待或强破陈旧）→ 读旧值 +1 →
 * 回写 → 释放锁。锁获取失败在 maxWaitMs 后报错，计数器保持原值不动。
 */
export declare function bumpBuildCounter(counterPath: string, options?: BumpOptions): number;
