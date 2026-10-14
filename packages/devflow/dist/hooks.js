/**
 * git hooks 安装：把宿主仓库的 core.hooksPath 指到 .githooks/（工作树共享同一配置），写入
 * pre-commit（调 nexus-devflow check-changelog）与 reference-transaction（发版锁硬闸）。
 * 已存在的同名钩子不覆盖（宿主可能加了自己的检查）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_LOCK, TOKEN_ENV } from "./release.js";
export const HOOKS_DIR = ".githooks";
export const PRE_COMMIT = `#!/bin/sh
# CHANGELOG precommit 门禁（@nexus-kit/devflow）。纯重构/文档/测试可 git commit --no-verify 跳过。
exec npx --no-install nexus-devflow check-changelog
`;
/**
 * 发版锁硬闸（锁的格式与生命周期见 release.ts）：锁在、未过期、事务要改锁内 ref、
 * NEXUS_RELEASE_TOKEN 与锁内 token 不符 → 在 prepared 阶段拒绝。锁读不到、解析不出一律放行
 * （fail-open）。只用 sh + sed，钩子在每次引用变更时都跑，不起 node。
 */
export const REFERENCE_TRANSACTION = String.raw `#!/bin/sh
# 发版锁硬闸（@nexus-kit/devflow）：nexus-devflow release 链中或 release --lock 之后冻结主干，
# 发版执行人凭 ${TOKEN_ENV} 放行。确认是残留锁可 nexus-devflow release --unlock。
[ "$1" = "prepared" ] || exit 0
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
lock="$common_dir/${RELEASE_LOCK}"
[ -f "$lock" ] || exit 0
# 锁是 JSON.stringify 缩进输出，一个字段一行：取 "名": 值 的值（去掉引号与行尾逗号）
field() { sed -n 's/^[[:space:]]*"'"$1"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",]*\)"\{0,1\},\{0,1\}[[:space:]]*$/\1/p' "$lock" | head -n 1; }
expires=$(field expires)
locked_ref=$(field ref)
case "$expires" in ''|*[!0-9]*) exit 0 ;; esac
[ -n "$locked_ref" ] || exit 0
[ "$(date +%s)" -lt "$expires" ] || exit 0
hit=0
while read -r _old _new ref; do
  [ "$ref" = "$locked_ref" ] && hit=1
done
[ "$hit" = 1 ] || exit 0
token=$(field token)
if [ -n "$token" ] && [ "$${TOKEN_ENV}" = "$token" ]; then
  exit 0
fi
version=$(field version)
[ "$version" = pending ] && version="（版本待定）" || version="v$version"
echo "发版锁生效中：$version 正在发布，$locked_ref 已冻结（约 $(( (expires - $(date +%s)) / 60 )) 分钟后自动失效）。发版执行人凭 ${TOKEN_ENV} 放行，其余等发版完成再合入；确认是残留锁可 nexus-devflow release --unlock" >&2
exit 1
`;
const HOOKS = [
    ["pre-commit", PRE_COMMIT],
    ["reference-transaction", REFERENCE_TRANSACTION],
];
export function installHooks(repoRoot, git) {
    const dir = join(repoRoot, HOOKS_DIR);
    mkdirSync(dir, { recursive: true });
    const written = [];
    for (const [name, body] of HOOKS) {
        const file = join(dir, name);
        if (existsSync(file))
            continue;
        writeFileSync(file, body);
        chmodSync(file, 0o755);
        written.push(`${HOOKS_DIR}/${name}`);
    }
    git(["config", "core.hooksPath", HOOKS_DIR]);
    return written;
}
/**
 * 已存在但与 kit 当前版本内容不同的钩子（宿主改过，或装的是旧版 kit 的）：installHooks 不覆盖它们，
 * 升级 kit 后的新逻辑（如发版锁）就进不去——调用方据此提示宿主手动对比合并。
 */
export function outdatedHooks(repoRoot) {
    return HOOKS.flatMap(([name, body]) => {
        const file = join(repoRoot, HOOKS_DIR, name);
        return existsSync(file) && readFileSync(file, "utf8") !== body ? [`${HOOKS_DIR}/${name}`] : [];
    });
}
