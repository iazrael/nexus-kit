import type { AgySettings, Executor } from "./types.ts";
export declare const efforts: string[];
export declare const modes: string[];
export declare function parseAgySettings(value: unknown): AgySettings;
export declare const agyExecutor: Executor;
