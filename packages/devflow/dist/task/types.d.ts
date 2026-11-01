import type { WorktreeConfig } from "../config/config.ts";
/** Every executor names its binary, an explicit model, and its permission flags. */
export interface ExecutorSettings {
    command: string[];
    model: string;
    permissionArgs: string[];
}
export interface AgySettings extends ExecutorSettings {
    effort: string;
    mode: string;
}
export type OpencodeSettings = ExecutorSettings;
/** CloudCLI 管理执行环境；归一化快照中的 command 和 permissionArgs 保持为空。 */
export interface CloudcliSettings extends ExecutorSettings {
    endpoint: string;
    tokenEnv: string;
    provider: string;
    permissionMode: "default" | "bypassPermissions";
}
export interface ExecutorLaunch {
    exe: string;
    argv: string[];
    /** File the session scanner polls while the executor runs. */
    sessionLog: string;
    requestFile?: string;
}
/** An executor's own error report, e.g. opencode `{"type":"provider.quota","message":"Rate limit exceeded"}`. */
export interface ExecutorFailure {
    type: string;
    message: string;
}
export interface ExecutorReceipt {
    conversationId: string;
    response?: string;
}
/** One executor adapter: how to launch it, track its session, and read its result. */
export interface Executor {
    parseSettings(value: unknown): ExecutorSettings;
    invocation(settings: ExecutorSettings, conversationId: string | null, runDir: string, stdoutPath: string, prompt: string): ExecutorLaunch;
    progress?(launch: ExecutorLaunch): {
        conversationId: string;
        state: string;
        runId: string;
    } | null;
    sessionScanner(launch: ExecutorLaunch, expected: string | null): () => string | null;
    receipt(stdoutPath: string): ExecutorReceipt;
    /** failure is the executor's own last error report, if its output carries one. */
    /** 远端执行器在本地桥接退出后，仍须确认服务端停止。 */
    stop?(launch: ExecutorLaunch): Promise<void>;
    salvage(stdoutPath: string): {
        conversationId?: string;
        response?: string;
        failure?: ExecutorFailure;
    };
}
export interface TaskConfig {
    version: 1;
    tasksDir: string;
    controlDir: string;
    rules: string[];
    executor: string;
    executors: Record<string, ExecutorSettings>;
    /** Environment variables stripped before launching an executor, so coordinator grants are not inherited. */
    executorEnvDeny: string[];
    worktreeDir: string | null;
    postCreate: string[][];
    budgetMinutes: number;
    progressMinutes: number;
    hardTimeoutMinutes: number;
    /** Host checks dispatch runs in the main repo first; only present when configured, so older config hashes hold. */
    preflight?: string[][];
}
export interface TaskSpec {
    version: 1;
    id: string;
    branch: string;
    worktree: string;
    goal: string;
    scope: string;
    inputs: {
        path: string;
        sha256: string;
        source?: string;
    }[];
    dependencies: {
        id: string;
        commit?: string;
    }[];
    /** Legacy scope metadata, not an execution or delivery restriction. */
    writable: string[];
    /** Legacy deletion metadata, not an authorization gate. */
    deletable?: string[];
    verify: {
        name: string;
        argv: string[];
        timeoutSeconds?: number;
    }[];
    productReviewRequired?: boolean;
    execution?: Partial<Pick<TaskConfig, "budgetMinutes" | "progressMinutes" | "hardTimeoutMinutes">> & {
        executor?: string;
        model?: string;
        /** Legacy agy-only knobs; other executors reject them. */
        effort?: string;
        mode?: string;
    };
}
export interface TaskDefinition {
    spec: TaskSpec;
    content: string;
    status: string;
    definition: string;
    effective: TaskConfig;
}
export interface TaskContext {
    root: string;
    mainRoot: string;
    cfg: TaskConfig;
    backend: WorktreeConfig;
}
export interface Snapshot {
    version: 2;
    base: string;
    sourceRoot: string;
    spec: TaskSpec;
    definition: string;
    config: TaskConfig;
    configHash: string;
    nexusHash: string;
    rules: {
        path: string;
        sha256: string;
    }[];
}
export interface RunInfo {
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
    executionState?: string;
    executionRunId?: string;
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
}
export interface LaunchResult {
    id: string;
    state: string;
    supervisorPid: number;
    executor: string;
    conversationId: string | null;
    runDir: string;
    resume: boolean;
    baseWarning?: string;
    preflight?: {
        argv: string[];
        exitCode: number;
        stdout: string;
        stderr: string;
    }[];
}
export interface RunOptions {
    dryRun?: boolean | undefined;
    detach?: boolean | undefined;
    refreshDefinition?: boolean | undefined;
    conversation?: string | undefined;
    model?: string | undefined;
}
export interface CommandExit {
    exitCode: number | null;
    signal: string | null;
    error?: string;
}
export interface CommandReceipt extends Omit<CommandExit, "error"> {
    name: string;
    argv: string[];
    timedOut: boolean;
    stdout: string;
    stderr: string;
    stdoutSha256: string;
    stderrSha256: string;
    error: string | null;
}
export interface Verification {
    id: string;
    passed: boolean;
    startedAt: string;
    definition: string;
    commands: CommandReceipt[];
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
}
export interface ReviewItem {
    passed: boolean;
    reviewer: string;
    record: string;
}
export interface Review {
    commit: string;
    code: ReviewItem;
    product?: ReviewItem;
}
export interface Accepted {
    id: string;
    status: string;
    verifiedCommit: string;
    acceptanceCommit: string;
    receipt: string;
    receiptSha256: string;
    review: Review;
    reviewSha256: string;
    acceptedAt: string;
    baseWarning?: string;
}
export interface VerificationStatus {
    passed?: boolean;
    commit?: string | undefined;
    matchesHead?: boolean;
    endedAt?: string | null;
    error?: string;
}
export interface AcceptanceStatus {
    verifiedCommit: string;
    acceptanceCommit: string;
    acceptedAt: string;
    passed: boolean;
    integrated: boolean;
    matchesHead: boolean;
    error?: string;
}
export interface TaskStatus {
    task: string;
    legacy: boolean;
    status: string;
    note?: string;
    error?: string;
    id?: string;
    worktree?: string;
    treeExists?: boolean;
    head?: string | null;
    run?: RunInfo | null;
    verification?: VerificationStatus | null;
    acceptance?: AcceptanceStatus | null;
}
