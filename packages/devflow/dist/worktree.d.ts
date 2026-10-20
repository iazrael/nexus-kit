import type { WorktreeConfig } from "./config.ts";
/** 本机进程探测与处置（生产实现见 worktree-procs.ts） */
export interface ProcessProbe {
    /** pid → 监听端口 */
    listening(): Map<number, number[]>;
    /** pid → 工作目录 */
    cwdOf(pids: readonly number[]): Map<number, string>;
    /** 本进程及其祖先：回收钩子可能就跑在该工作树的会话里，不能停掉自己 */
    ancestors(): Set<number>;
    describe(pid: number): string;
    /** SIGTERM，等 3 秒不退再 SIGKILL */
    stop(pid: number): void;
    /** 工作目录落在 root 内的 pm2 应用名；不先删掉的话杀进程会被 pm2 拉起来 */
    pm2AppsIn(root: string): string[];
    pm2Delete(name: string): void;
}
export interface WorktreeEnv {
    /** 调用方所在目录（主仓库或任一工作树内） */
    cwd: string;
    config: WorktreeConfig;
    /** 从目录向上读 nexus.config.json 的工作树段；合入后用它重读主仓库配置，合入可能改了 postMerge */
    loadConfig(dir: string): WorktreeConfig;
    log(message: string): void;
    procs: ProcessProbe;
    /** 执行命令（输出不进 stdout，钩子模式下 stdout 只许输出路径）；非零退出抛错 */
    run(cmd: string, args: readonly string[], cwd: string): void;
}
/** 判定锁残留时看到的样子：锁目录 mtime 与锁内 pid 文件内容 */
export interface LockSnapshot {
    mtimeMs: number;
    pid: string | null;
}
/**
 * 清残锁：先改名到唯一名字（rename 原子，两个进程同时清只有一个成功），再核对搬走的正是判定残留时看到的
 * 那把锁（mtime 与 pid 都相同）。判定与改名之间别人可能已清掉旧锁并建了新锁——搬错了就原样放回，
 * 不把别人刚拿到的锁删掉。返回是否真清掉了残锁。
 */
export declare function removeStaleLock(lock: string, seen: LockSnapshot): boolean;
export interface NewOptions {
    branch: string;
    /** 新分支起点，默认主干 */
    from?: string;
    /** 不挂软链、留空目录的共享项 */
    isolate?: readonly string[];
}
/** 建树 + 挂软链 + 登记端口 + postCreate；返回工作树根与端口。任一步失败整体回滚 */
export declare function worktreeNew(env: WorktreeEnv, opts: NewOptions): {
    root: string;
    port: number;
};
/**
 * 在当前工作树把共享项改为本树独立：默认复制主仓库现有内容，empty 留空目录；已是本地目录的保留。
 * 先全部预检、再全部暂存副本：任一项复制失败时所有共享关系不变。替换阶段某项改名失败，该项恢复软链，
 * 之前已替换的项保持独立（已替换的项是完整副本，不需要回退）。
 */
export declare function worktreeIsolate(env: WorktreeEnv, names: readonly string[], empty: boolean): void;
/** 合回主干（只快进）+ 合入后命令；返回 "ff" 或 "up-to-date" */
export declare function worktreeMerge(env: WorktreeEnv, arg: string): "ff" | "up-to-date";
/**
 * 回收工作树：先停服务，再查残留，最后删目录。分支保留。
 * 调用方的当前目录在待删树内时拒绝：目录删掉后调用方 shell 的工作目录失效，后续命令一律
 * spawn ENOENT；工具改不了调用方的工作目录，只能拒绝。钩子回收不走这里（Claude 自己管会话目录）。
 */
export declare function worktreeRemove(env: WorktreeEnv, arg: string, opts: {
    force: boolean;
}): void;
/** 每个工作树一行：路径、分支、端口与服务、领先主干的提交数、是否干净、是否锁定 */
export declare function worktreeList(env: WorktreeEnv): string[];
/**
 * WorktreeCreate：替代 Claude 自带的 git worktree add，让 claude --worktree 与子 Agent 的
 * isolation: "worktree" 也拿到共享软链和登记端口。返回工作树路径（调用方打印到 stdout，
 * 其余输出一律走 stderr）。起点取发起会话当前的 HEAD：子 Agent 通常要在进行中的分支上接着干。
 * 同名再开时复用既有工作树（恢复会话走这条路）。
 */
export declare function hookCreate(env: WorktreeEnv, input: unknown): string;
/** WorktreeRemove：同 rm，另外删除已合入的 worktree-* 分支；拒绝时抛错，Claude 会把工作树留在磁盘上 */
export declare function hookRemove(env: WorktreeEnv, input: unknown): void;
