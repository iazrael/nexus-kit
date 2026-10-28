/**
 * precommit 门禁：源码目录有暂存变更而 CHANGELOG 无新增行时阻断提交——升级弹窗的更新说明
 * 来自 CHANGELOG，缺条目就是用户看不到这次改了什么。内部改动记「内部：」条目；纯重构/
 * 文档/测试改动可 `git commit --no-verify` 跳过。判定是纯函数，git 读取在 cli。
 */
export interface ChangelogGateInput {
    /** 暂存区文件（相对仓库根，/ 分隔） */
    staged: readonly string[];
    /** CHANGELOG 暂存 diff（git diff --cached -U0） */
    changelogDiff: string;
    sourceDirs: readonly string[];
}
export declare function changelogGate(input: ChangelogGateInput): {
    ok: true;
} | {
    ok: false;
    message: string;
};
