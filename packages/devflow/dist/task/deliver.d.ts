/**
 * Reads an executor note (summary or block reason). It must live outside the
 * task tree, so the tree stays clean; relative paths resolve from the caller's cwd.
 */
export declare function readNote(path: string, wt: string, label: string): string;
/** Indents each line under a record bullet, stripping control characters so a note cannot break the record. */
export declare function indentNote(value: string): string;
/**
 * Normalises a delivery summary to "1. 改了什么：… / 2. 验证如何：… / 3. 还有什么：…".
 * A section's content may continue on the following lines.
 */
export declare function formatSummary(value: string): string;
/**
 * Checks the task's acceptance table: every row needs a self-check cell that
 * reads "通过：<证据>" or "不适用：<理由>". Returns the number of rows checked.
 */
export declare function checkAcceptance(content: string): number;
/** Empties the acceptance table's self-check column so a rework round cannot reuse last round's passes. */
export declare function clearSelfChecks(content: string): string;
