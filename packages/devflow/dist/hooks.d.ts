export declare const HOOKS_DIR = ".githooks";
export declare const PRE_COMMIT = "#!/bin/sh\n# CHANGELOG precommit \u95E8\u7981\uFF08@nexus-kit/devflow\uFF09\u3002\u7EAF\u91CD\u6784/\u6587\u6863/\u6D4B\u8BD5\u53EF git commit --no-verify \u8DF3\u8FC7\u3002\nexec npx --no-install nexus-devflow check-changelog\n";
export declare function installHooks(repoRoot: string, git: (args: string[]) => void): string[];
