import type { WorktreeConfig } from "../config.ts";

export interface AgyConfig {
  command: string[];
  model: string;
  effort: string;
  mode: string;
  permissionArgs: string[];
}
export interface TaskConfig {
  version: 1;
  tasksDir: string;
  controlDir: string;
  rules: string[];
  agy: AgyConfig;
  worktreeDir: string | null;
  postCreate: string[][];
  budgetMinutes: number;
  progressMinutes: number;
  hardTimeoutMinutes: number;
}
export interface TaskSpec {
  version: 1;
  id: string;
  branch: string;
  worktree: string;
  goal: string;
  scope: string;
  inputs: { path: string; sha256: string; source?: string }[];
  dependencies: { id: string; commit?: string }[];
  writable: string[];
  verify: { name: string; argv: string[]; timeoutSeconds?: number }[];
  productReviewRequired?: boolean;
  execution?: Partial<Pick<TaskConfig, "budgetMinutes" | "progressMinutes" | "hardTimeoutMinutes">> &
    Partial<Pick<AgyConfig, "model" | "effort" | "mode">>;
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
  rules: { path: string; sha256: string }[];
}
export interface RunInfo {
  id: string;
  state: string;
  startedAt: string;
  supervisorPid: number | null;
  executorPid: number | null;
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
}
export interface LaunchResult {
  id: string;
  state: string;
  supervisorPid: number;
  conversationId: string | null;
  runDir: string;
  resume: boolean;
}
export interface RunOptions {
  dryRun?: boolean | undefined;
  detach?: boolean | undefined;
  refreshDefinition?: boolean | undefined;
  conversation?: string | undefined;
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
  mainAudits?: { file: string; sha256: string }[];
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
