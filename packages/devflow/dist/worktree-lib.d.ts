export type RunGit = (...argv: string[]) => string;
export interface WorktreeEntry {
    path: string;
    /** 检出的分支名（不带 refs/heads/）；detached 为 null */
    branch: string | null;
    /** 被 git worktree lock 锁定（通常是有 Claude 会话在用） */
    locked: boolean;
    /** 第一条是主仓库 */
    main: boolean;
}
/** 解析 `git worktree list --porcelain`；第一条是主仓库 */
export declare function parseWorktreeList(out: string): WorktreeEntry[];
/**
 * merge/rm 的目标参数 → 工作树检出的分支名：参数是绝对路径或 worktreesDir 下的目录名
 * （resolve 同时吃两种形态）。命中非主仓库且非 detached 的工作树才返回分支名，否则 null。
 */
export declare function branchOfWorktreeArg(target: string, worktreesDir: string, list: readonly WorktreeEntry[]): string | null;
/** a 是否为 b 的祖先（含同点）；git 异常（引用不存在等）按「不是」处理 */
export declare function isAncestor(runGit: RunGit, a: string, b: string): boolean;
/**
 * 把 branch 合入 base（合入纪律）：合入前分支必须已变基到最新 base 并在其上验证，所以这里只接受
 * 「base 是分支祖先」，按快进前移——合进主干的就是验证过的那份代码。分支已并入 → "up-to-date"；
 * 可快进 → "ff"；分叉（base 有分支没有的提交）→ 抛错，不在主仓库做真合并（合出的组合没人验证过，
 * 冲突还会留在主仓库）。runGit 的 cwd 必须是检出 base 的主仓库。
 */
export declare function mergeIntoBase(runGit: RunGit, base: string, branch: string): "up-to-date" | "ff";
/**
 * 合入失败后的主仓库善后：调用方合入前已确认主仓库干净。若失败后 HEAD 未动而工作区/暂存区有改动，
 * 这些改动只可能是这次合入留下的——实例：快进被发版锁的 reference-transaction 钩子在 prepared 阶段
 * 拒绝，git 已改了工作区与暂存区、引用却没动。用 read-tree 还原到 HEAD（不改任何引用，钩子不拦；
 * 未跟踪文件不碰）。返回是否做了还原；HEAD 已变（合入其实成功）时不动并返回 false。
 */
export declare function restoreAfterFailedMerge(runGit: RunGit, headBefore: string): boolean;
/** 取最小的未占用端口：base 归主仓库，工作树从 base+step 起按 step 递增；taken = 已登记 ∪ 正在监听 */
export declare function pickPort(taken: ReadonlySet<number>, base: number, step: number): number;
/** 解析 `lsof -nP -iTCP -sTCP:LISTEN -Fpn` → pid → 端口列表 */
export declare function parseLsofListen(out: string): Map<number, number[]>;
/** 解析 `lsof -a -d cwd -Fpn` → pid → 工作目录 */
export declare function parseLsofCwd(out: string): Map<number, string>;
export declare function isInside(path: string, root: string): boolean;
/** 仓库相对路径 path 是否落在 prefix 之下（按路径段，prefix 尾斜杠可有可无） */
export declare function matchesPathPrefix(path: string, prefix: string): boolean;
/**
 * 把 `git status --porcelain --ignored` 的行分成「回收会丢、必须拦」和「可再生、直接删」。
 * 可删 = 内置产物白名单、宿主登记的可再生路径（extraDisposable，按路径段前缀），或路径本身是软链
 * （删链不删目标）。isDisposableSymlink 对文件行回答「路径本身是软链」，对 dir/ 行回答「目录里
 * 是否只有软链」——git 把全部内容被忽略的目录坍缩成一条 dir/ 行，只有整目录纯软链才可随树删。
 */
export declare function classifyLeftovers(lines: readonly string[], isDisposableSymlink: (path: string) => boolean, extraDisposable?: readonly string[]): {
    blocking: string[];
    disposable: string[];
};
/** readdir 结果的最小形状（生产传 `(dir) => readdirSync(dir, { withFileTypes: true })`） */
export interface DirEntryLike {
    name: string;
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
}
/** 目录里是否只有软链（真子目录递归同判；空目录没有可丢内容，视同为真） */
export declare function dirOfSymlinksOnly(dir: string, readdir: (dir: string) => readonly DirEntryLike[]): boolean;
export declare const DEFAULT_LOCK_MAX_AGE_MS: number;
/**
 * 目录锁残留判定（合入锁）。pidText = 锁内 pid 文件内容（没有为 null），ageMs = 锁目录存在时长，
 * alive(pid) = 进程是否还在。超过 maxAgeMs 无论进程死活都算残留（防卡死挂起）；pid 有效看进程
 * 死活；没写或写坏的，刚建的锁可能正在写，超过 10 秒才算残留。
 */
export declare function isLockStale(input: {
    pidText: string | null;
    ageMs: number;
    alive: (pid: number) => boolean;
    maxAgeMs?: number;
}): boolean;
/** 并发合入被拒（Fail-Fast）时的提示：谁在合、PID、被拒者接下来做什么 */
export declare function formatMergeConflictNotice(input: {
    branch: string | null;
    pid: string | null;
    base: string;
}): string;
