/**
 * 构建计数器（默认 <应用根>/.build-number）的读与原子递增。
 *
 * 计数器不入 git：真身在主仓库，工作树挂软链共享（@nexus-kit/devflow worktree）；
 * 每次构建（vite build，含日常验证构建）都递增——它就是「第几次构建」，与产品
 * 版本（package.json，release 人工进位）完全解耦。升级检测链只依赖它单调递增，
 * 测试构建消耗号段留下的洞无影响。
 *
 * 缺失处理分两界：CI / 新 clone 本来就没有本地状态，ensureBuildCounter 自动以 0
 * 起步（构建只比单调，不比绝对值）；主仓真身意外丢失则号会回退、发版后升级弹窗
 * 失明——警告文案指向真实恢复源（线上 version.json 的 build 字段 / 服务器
 * releases/<版本>+<构建号> 目录名），发版前必须核对。
 *
 * 递增用「排他锁文件 + 陈旧强破」防两个工作树并行构建互踩：锁内容写
 * pid + 获锁时刻，超过 STALE_LOCK_MS 视为上次构建中断残留，强删重拿；内容
 * 残缺（刚获锁还没写完的窗口）按新鲜等待，不误杀刚拿锁的持有者。锁路径跟
 * 计数器 realpath 走，软链场景全局唯一一把。单测见 build-counter.test.ts。
 */
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
const STALE_LOCK_MS = 10_000;
const RETRY_MS = 50;
const DEFAULT_MAX_WAIT_MS = 5_000;
const RESTORE_HINT = "主仓发过版的话务必先核对真实号：线上 version.json 的 build 字段" +
    "或服务器 releases/<版本>+<构建号> 目录名，" +
    "echo <真实号> > 该文件——从 0 起步发版会让老用户本地构建号更大、升级弹窗失明。" +
    "CI / 新 clone 环境可忽略（从 0 递增不影响门禁与部署校验）。";
/** 确保计数器存在：缺失（CI / 新 clone / 主仓真身丢失）时以 0 建档并醒目警告 */
export function ensureBuildCounter(counterPath) {
    if (existsSync(counterPath))
        return;
    writeFileSync(counterPath, "0\n");
    console.warn(`[build-counter] ${counterPath} 不存在（不入 git 的本地计数器），已从 0 建档。${RESTORE_HINT}`);
}
/** 读当前构建号；内容非法时报损坏 */
export function readBuildCounter(counterPath) {
    const raw = readFileSync(counterPath, "utf8");
    const build = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(build) || build < 0) {
        throw new Error(`[build-counter] 计数器损坏（应为纯整数）：${counterPath} 内容 ${JSON.stringify(raw)}`);
    }
    return build;
}
/**
 * 锁的年龄（毫秒）。null = 锁已不在（持有者刚释放/被强破，调用方应立即重试 wx）；
 * 内容残缺 = 按新鲜（0）处理——那可能是刚获锁还没写完的持有者，强破会误杀。
 */
function lockAgeMs(lockPath, now) {
    let content;
    try {
        content = readFileSync(lockPath, "utf8");
    }
    catch {
        return null;
    }
    const stamp = Number.parseInt(content.split(/\s+/)[1] ?? "", 10);
    return Number.isInteger(stamp) ? now - stamp : 0;
}
/** 同步睡眠（构建脚本是单线程短任务，阻塞可接受） */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * 原子递增并返回新构建号。流程：拿排他锁（等待或强破陈旧）→ 读旧值 +1 →
 * 回写 → 释放锁。锁获取失败在 maxWaitMs 后报错，计数器保持原值不动。
 */
export function bumpBuildCounter(counterPath, options = {}) {
    // 锁跟计数器「真实位置」走：计数器是跨工作树软链时，锁必须落在真身旁边才是
    // 全局唯一的一把——各工作树各持一把锁等于没锁（写的是同一个计数器文件）
    const realCounterPath = existsSync(counterPath) ? realpathSync(counterPath) : counterPath;
    const lockPath = options.lockPath ?? `${realCounterPath}.lock`;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? sleepSync;
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const start = now();
    let fd;
    for (;;) {
        try {
            fd = openSync(lockPath, "wx");
            break;
        }
        catch (err) {
            if (err?.code !== "EEXIST")
                throw err;
            const age = lockAgeMs(lockPath, now());
            if (age !== null && age > STALE_LOCK_MS) {
                try {
                    rmSync(lockPath, { force: true });
                }
                catch {
                    /* 别的进程抢先强破：下一轮 wx 重试 */
                }
                continue;
            }
            if (now() - start >= maxWaitMs) {
                throw new Error(`[build-counter] 拿锁超时（${lockPath} 被其他构建持有）——确认没有并行构建后可删除该锁文件重试`, { cause: err });
            }
            sleep(RETRY_MS);
        }
    }
    try {
        // 写获锁时刻而非进入函数的时刻：等锁近 maxWaitMs 才拿到的进程，
        // 锁不能一出生就带着大年龄被后来者误判陈旧
        writeFileSync(fd, `${process.pid} ${now()}`);
    }
    finally {
        closeSync(fd);
    }
    try {
        const build = readBuildCounter(counterPath) + 1;
        writeFileSync(counterPath, `${build}\n`);
        return build;
    }
    finally {
        rmSync(lockPath, { force: true });
    }
}
