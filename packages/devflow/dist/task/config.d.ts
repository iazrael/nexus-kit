import type { TaskConfig } from "./types.ts";
export declare const efforts: string[];
export declare const modes: string[];
/** hardTimeoutMinutes 0 means no hard limit; the other durations must be positive. */
export declare function minutes(value: unknown, label: "budgetMinutes" | "progressMinutes" | "hardTimeoutMinutes"): number;
export declare function parseTaskConfig(value: unknown): TaskConfig;
export declare function validateTaskPaths(root: string, cfg: TaskConfig): void;
export declare function mainRootOf(root: string): string;
export declare function taskWorktree(mainRoot: string, cfg: TaskConfig, id: string): string;
export declare function taskWorktreeName(root: string, cfg: TaskConfig, id: string): string;
