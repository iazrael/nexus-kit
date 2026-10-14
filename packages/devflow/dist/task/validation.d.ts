export declare function check(ok: unknown, message: string): asserts ok;
export declare function errorMessage(e: unknown): string;
export declare function errorCode(e: unknown): unknown;
export declare function object(value: unknown, label: string): Record<string, unknown>;
export declare function text(value: unknown, label: string): string;
export declare function stringList(value: unknown, label: string): string[];
export declare function command(value: unknown, label: string): string[];
export declare function number(value: unknown, label: string, minimum?: number, maximum?: number): number;
export declare const maxMinutes: number;
export declare const maxSeconds: number;
/** Replaces control characters so recorded text cannot break lines or inject terminal escapes. */
export declare function printable(value: unknown): string;
export declare function inside(root: string, path: string): boolean;
export declare function safePath(root: string, name: string): string;
export declare function json(path: string): unknown;
