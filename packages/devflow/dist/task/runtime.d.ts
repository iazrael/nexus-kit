import type { TaskContext, LaunchResult, RunOptions, RunInfo, TaskStatus } from "./types.ts";
export { git } from "./io.ts";
export declare function context(cwd?: string): TaskContext;
export declare function start(ctx: TaskContext, id: string, owner: string): {
    id: string;
    worktree: string;
    base: string;
    head: string;
    restored: boolean;
};
export declare function status(ctx: TaskContext, id?: string): {
    tasks: TaskStatus[];
};
export declare function shortStatus(result: {
    tasks: TaskStatus[];
}): string;
/** A record still marked running whose supervisor is gone reads as interrupted; the file itself is left untouched. */
export declare function settleRun(info: RunInfo): RunInfo;
export declare function dispatch(ctx: TaskContext, id: string, options?: RunOptions): Promise<LaunchResult | {
    baseWarning?: string;
    preflight?: {
        argv: string[];
        exitCode: number;
        stdout: string;
        stderr: string;
    }[];
    id: string;
    base: string;
    prompt: string;
    dryRun: boolean;
    executor: string;
    model: string;
} | {
    preflight?: {
        argv: string[];
        exitCode: number;
        stdout: string;
        stderr: string;
    }[];
    runDir: string;
    waitingCancelled: boolean;
    commandExitCode: number;
    endReason?: "delivered" | "blocked" | "interrupted" | "needs_approval" | "failed" | null;
    endMessage?: string;
    notificationError?: string;
    classificationError?: string;
    id: string;
    state: string;
    startedAt: string;
    supervisorPid: number | null;
    executorPid: number | null;
    executor?: string;
    conversationId: string | null;
    resume: boolean;
    sourceRoot: string;
    stdout: string;
    stderr: string;
    budgetReached: boolean;
    hardTimeout: boolean;
    sessionSource?: string;
    sessionWarning?: string;
    progressAt?: string;
    budgetMessage?: string;
    lastHead?: string;
    exitCode?: number | null;
    signal?: string | null;
    error?: string;
    outputError?: string;
    recordError?: string;
    reportedConversationId?: string;
    stopRequested?: boolean;
    endedAt?: string;
    taskStatus?: string;
    mainWarning?: string;
    baseWarning?: string;
} | {
    preflight?: {
        argv: string[];
        exitCode: number;
        stdout: string;
        stderr: string;
    }[];
    result?: import("./types.ts").ExecutorReceipt;
    runDir: string;
    commandExitCode: number;
    endReason?: "delivered" | "blocked" | "interrupted" | "needs_approval" | "failed" | null;
    endMessage?: string;
    notificationError?: string;
    classificationError?: string;
    id: string;
    state: string;
    startedAt: string;
    supervisorPid: number | null;
    executorPid: number | null;
    executor?: string;
    conversationId: string | null;
    resume: boolean;
    sourceRoot: string;
    stdout: string;
    stderr: string;
    budgetReached: boolean;
    hardTimeout: boolean;
    sessionSource?: string;
    sessionWarning?: string;
    progressAt?: string;
    budgetMessage?: string;
    lastHead?: string;
    exitCode?: number | null;
    signal?: string | null;
    error?: string;
    outputError?: string;
    recordError?: string;
    reportedConversationId?: string;
    stopRequested?: boolean;
    endedAt?: string;
    taskStatus?: string;
    mainWarning?: string;
    baseWarning?: string;
}>;
export declare function resume(ctx: TaskContext, id: string, options?: RunOptions): Promise<LaunchResult | {
    runDir: string;
    waitingCancelled: boolean;
    commandExitCode: number;
    endReason?: "delivered" | "blocked" | "interrupted" | "needs_approval" | "failed" | null;
    endMessage?: string;
    notificationError?: string;
    classificationError?: string;
    id: string;
    state: string;
    startedAt: string;
    supervisorPid: number | null;
    executorPid: number | null;
    executor?: string;
    conversationId: string | null;
    resume: boolean;
    sourceRoot: string;
    stdout: string;
    stderr: string;
    budgetReached: boolean;
    hardTimeout: boolean;
    sessionSource?: string;
    sessionWarning?: string;
    progressAt?: string;
    budgetMessage?: string;
    lastHead?: string;
    exitCode?: number | null;
    signal?: string | null;
    error?: string;
    outputError?: string;
    recordError?: string;
    reportedConversationId?: string;
    stopRequested?: boolean;
    endedAt?: string;
    taskStatus?: string;
    mainWarning?: string;
    baseWarning?: string;
} | {
    result?: import("./types.ts").ExecutorReceipt;
    runDir: string;
    commandExitCode: number;
    endReason?: "delivered" | "blocked" | "interrupted" | "needs_approval" | "failed" | null;
    endMessage?: string;
    notificationError?: string;
    classificationError?: string;
    id: string;
    state: string;
    startedAt: string;
    supervisorPid: number | null;
    executorPid: number | null;
    executor?: string;
    conversationId: string | null;
    resume: boolean;
    sourceRoot: string;
    stdout: string;
    stderr: string;
    budgetReached: boolean;
    hardTimeout: boolean;
    sessionSource?: string;
    sessionWarning?: string;
    progressAt?: string;
    budgetMessage?: string;
    lastHead?: string;
    exitCode?: number | null;
    signal?: string | null;
    error?: string;
    outputError?: string;
    recordError?: string;
    reportedConversationId?: string;
    stopRequested?: boolean;
    endedAt?: string;
    taskStatus?: string;
    mainWarning?: string;
    baseWarning?: string;
}>;
export declare function supervise(ctx: TaskContext, id: string, directory: string): Promise<RunInfo>;
export declare function verify(ctx: TaskContext, id: string, mainReview?: string): Promise<{
    receipt: string;
    id: string;
    passed: boolean;
    startedAt: string;
    definition: string;
    commands: import("./types.ts").CommandReceipt[];
    output: string;
    commit?: string;
    changed?: string[];
    outputs?: Record<string, string>;
    mainAudits?: {
        file: string;
        sha256: string;
    }[];
    baseWarning?: string;
    error?: string;
    endedAt?: string;
}>;
/**
 * Executor-side delivery gate: committed work inside the whitelist, every
 * acceptance row self-checked, the registered verify commands passing in a
 * fresh directory. Only then the summary is appended and the task marked 待验收.
 */
export declare function deliver(ctx: TaskContext, id: string, summaryPath: string): Promise<{
    id: string;
    status: string;
    commit: string;
    verifiedCommit: string;
    selfCheck: string;
    summary: string;
}>;
/**
 * Executor-side block: records the reason and status 受阻, committing only the
 * task file. It runs exactly when work cannot be finished, so it does not
 * demand a clean tree or a whitelist-clean diff; uncommitted paths are listed.
 */
export declare function block(ctx: TaskContext, id: string, reasonPath: string): {
    id: string;
    status: string;
    commit: string;
    uncommitted: string[];
};
export declare function rework(ctx: TaskContext, id: string, messagePath: string): {
    id: string;
    status: string;
    commit: string;
    worktree: string;
};
export declare function accept(ctx: TaskContext, id: string, reviewPath: string): {
    mainWarnings: string[];
    id: string;
    status: string;
    verifiedCommit: string;
    acceptanceCommit: string;
    receipt: string;
    receiptSha256: string;
    review: import("./types.ts").Review;
    reviewSha256: string;
    acceptedAt: string;
    baseWarning?: string;
};
