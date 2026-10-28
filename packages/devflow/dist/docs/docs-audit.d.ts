export interface DocsAuditFs {
    /** 递归列出目录下全部 .md 绝对路径；目录不存在返回空 */
    listMarkdown(dir: string): string[];
    read(path: string): string;
    exists(path: string): boolean;
}
export interface DocsAuditOptions {
    repoRoot: string;
    docsRoot: string;
    archiveDir: string;
    designDir: string;
    index: string;
}
export declare function auditDocs(opts: DocsAuditOptions, fs: DocsAuditFs): {
    errors: string[];
    checked: number;
};
