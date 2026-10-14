export declare const HOOKS_DIR = ".githooks";
export declare const PRE_COMMIT = "#!/bin/sh\n# CHANGELOG precommit \u95E8\u7981\uFF08@nexus-kit/devflow\uFF09\u3002\u7EAF\u91CD\u6784/\u6587\u6863/\u6D4B\u8BD5\u53EF git commit --no-verify \u8DF3\u8FC7\u3002\nexec npx --no-install nexus-devflow check-changelog\n";
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
