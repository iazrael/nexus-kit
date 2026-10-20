export declare const HOOKS_DIR = ".githooks";
/**
 * 先用项目依赖里钉住的版本（模板生成的项目），没有再用 PATH 上的全局命令（走 PATH 的存量项目）。
 * git 在工作树根目录执行 pre-commit，所以相对路径 node_modules/.bin 指的是本树的依赖。
 */
export declare const PRE_COMMIT = "#!/bin/sh\n# CHANGELOG precommit \u95E8\u7981\uFF08@nexus-kit/devflow\uFF09\u3002\u7EAF\u91CD\u6784/\u6587\u6863/\u6D4B\u8BD5\u53EF git commit --no-verify \u8DF3\u8FC7\u3002\n# \u5148\u7528\u9879\u76EE\u4F9D\u8D56\u91CC\u7684 nexus-devflow\uFF0C\u6CA1\u6709\u518D\u7528 PATH \u4E0A\u7684\u5168\u5C40\u547D\u4EE4\u3002\nif [ -x node_modules/.bin/nexus-devflow ]; then exec node_modules/.bin/nexus-devflow check-changelog; fi\nif command -v nexus-devflow >/dev/null 2>&1; then exec nexus-devflow check-changelog; fi\necho \"[pre-commit] \u627E\u4E0D\u5230 nexus-devflow\uFF1A\u9879\u76EE\u4F9D\u8D56\u91CC\u6CA1\u6709\uFF0CPATH \u4E0A\u4E5F\u6CA1\u6709\u3002\u5728 nexus-kit \u6267\u884C pnpm install-cli \u5B89\u88C5\u5168\u5C40\u547D\u4EE4\" >&2\nexit 1\n";
/**
 * 发版锁硬闸（锁的格式与生命周期见 release.ts）：锁在、未过期、事务要改锁内 ref、
 * NEXUS_RELEASE_TOKEN 与锁内 token 不符 → 在 prepared 阶段拒绝。锁读不到、解析不出一律放行
 * （fail-open）。只用 sh + sed，钩子在每次引用变更时都跑，不起 node。
 */
export declare const REFERENCE_TRANSACTION: string;
export declare function installHooks(repoRoot: string, git: (args: string[]) => void): string[];
/**
 * 已存在但与 kit 当前版本内容不同的钩子（宿主改过，或装的是旧版 kit 的）：installHooks 不覆盖它们，
 * 升级 kit 后的新逻辑（如发版锁）就进不去——调用方据此提示宿主手动对比合并。
 */
export declare function outdatedHooks(repoRoot: string): string[];
