import type { Executor } from "./types.ts";
export declare function executorByName(name: string): Executor;
export declare function parseExecutorSettings(name: string, value: unknown): import("./types.ts").ExecutorSettings;
