/**
 * git hooks 安装：把宿主仓库的 core.hooksPath 指到 .githooks/，并写入 pre-commit（调
 * nexus-devflow check-changelog）。已存在的同名钩子不覆盖（宿主可能加了自己的检查）。
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HOOKS_DIR = ".githooks";

export const PRE_COMMIT = `#!/bin/sh
# CHANGELOG precommit 门禁（@nexus-kit/devflow）。纯重构/文档/测试可 git commit --no-verify 跳过。
exec npx --no-install nexus-devflow check-changelog
`;

export function installHooks(repoRoot: string, git: (args: string[]) => void): string[] {
  const dir = join(repoRoot, HOOKS_DIR);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const file = join(dir, "pre-commit");
  if (!existsSync(file)) {
    writeFileSync(file, PRE_COMMIT);
    chmodSync(file, 0o755);
    written.push(`${HOOKS_DIR}/pre-commit`);
  }
  git(["config", "core.hooksPath", HOOKS_DIR]);
  return written;
}
