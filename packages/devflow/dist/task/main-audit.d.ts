interface MainState {
    head: string;
    branch: string;
    files: Record<string, string>;
    dirty: string;
    hidden: string[];
}
export declare function assertMainClean(root: string): MainState;
export declare function beginMainAudit(root: string, control: string, operation: string): string;
export declare function finishMainAudit(root: string, file: string): void;
export declare function reviewMainAudits(control: string, reviewFile: string): void;
export declare function assertMainAuditsReviewed(control: string): void;
export declare function mainAuditManifest(control: string): {
    file: string;
    sha256: string;
}[];
export {};
