import type { Snapshot, RunInfo, Verification, Accepted, Review } from "./types.ts";
export declare function readSnapshot(file: string, root: string): Snapshot;
export declare function readRun(file: string): RunInfo;
export declare function readVerification(file: string): Verification;
export declare function readReview(file: string): Review;
export declare function readAccepted(file: string): Accepted;
export declare function readPointer(file: string): {
    file: string;
    sha256?: string;
};
export declare function readRunPointer(file: string): string;
export declare function readRework(file: string): {
    defects: string;
    reproduce: string;
    criteria: string;
};
