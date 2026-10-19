/**
 * Incrementally scans an appending log for the session created or resumed by
 * the current invocation. The returned closure is polled while the executor
 * runs; thrown errors carry the ids already identified for failure recovery.
 */
export declare function sessionLineScanner(path: string, matchLine: (line: string) => string | null, expected: string | null): () => string | null;
