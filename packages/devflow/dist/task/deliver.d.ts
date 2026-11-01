/**
 * Reads an executor note (summary or block reason). It must live outside the
 * task tree, so the tree stays clean; relative paths resolve from the caller's cwd.
 */
export declare function readNote(path: string, wt: string, label: string): string;
/** Indents each line under a record bullet, stripping control characters so a note cannot break the record. */
export declare function indentNote(value: string): string;
/** Empties the acceptance table's self-check column so a rework round cannot reuse last round's passes. */
export declare function clearSelfChecks(content: string): string;
