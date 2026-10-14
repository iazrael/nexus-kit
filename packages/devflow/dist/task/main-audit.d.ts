interface MainState {
    head: string;
    branch: string;
    files: Record<string, string>;
    dirty: string;
    hidden: string[];
}
export declare function assertMainClean(root: string): MainState;
export declare function beginMainAudit(root: string, control: string, operation: string): string;
/**
 * allowAdvance: the execution window may last hours while the coordinator integrates other tasks.
 * A clean main that only fast-forwarded passes with a warning listing the new commits;
 * uncommitted changes, hidden index entries, branch switches and rewritten history still fail.
 */
export declare function finishMainAudit(root: string, file: string, allowAdvance?: boolean): string | undefined;
export declare function reviewMainAudits(control: string, reviewFile: string): void;
export declare function assertMainAuditsReviewed(control: string): void;
export declare function mainAuditWarnings(control: string): string[];
export declare function mainAuditManifest(control: string): {
    file: string;
    sha256: string;
}[];
export {};
