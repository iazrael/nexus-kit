import type { TaskConfig } from "./types.ts";
import { efforts, modes } from "./executor-agy.ts";
export { efforts, modes };
/** hardTimeoutMinutes 0 means no hard limit; the other durations must be positive. */
export declare function minutes(value: unknown, label: "budgetMinutes" | "progressMinutes" | "hardTimeoutMinutes"): number;
export declare function parseTaskConfig(value: unknown): TaskConfig;
/**
 * The config exactly as 0.7.0 parsed and hashed it, or null when the config
 * uses anything 0.7.0 could not express (another executor, env deny list, preflight).
 * Lets snapshots frozen before executors existed pass the config check.
 */
export declare function legacyTaskConfig(cfg: TaskConfig): Record<string, unknown> | null;
export declare function validateTaskPaths(root: string, cfg: TaskConfig): void;
export declare function mainRootOf(root: string): string;
export declare function taskWorktree(mainRoot: string, cfg: TaskConfig, id: string): string;
export declare function taskWorktreeName(root: string, cfg: TaskConfig, id: string): string;
