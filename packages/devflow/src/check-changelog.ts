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

export function changelogGate(input: ChangelogGateInput): { ok: true } | { ok: false; message: string } {
  const touchesSource = input.staged.some((f) => input.sourceDirs.some((dir) => f.startsWith(dir)));
  if (!touchesSource) return { ok: true };
  const addsEntry = input.changelogDiff.split("\n").some((line) => line.startsWith("+") && !line.startsWith("+++"));
  if (addsEntry) return { ok: true };
  return {
    ok: false,
    message: [
      `✗ 本次提交涉及源码（${input.sourceDirs.join("、")}），但 CHANGELOG 没有新增条目。`,
      "  用户可见的变更请在 ## [Unreleased] 小节补一条大白话说明；",
      "  内部改动记「内部：」开头的条目，未开放功能记「WIP：」开头；",
      "  纯重构/文档/测试可用 git commit --no-verify 跳过本检查。",
    ].join("\n"),
  };
}
