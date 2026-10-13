#!/usr/bin/env node
/**
 * nexus-devflow：工程流程命令入口（读宿主仓库根 nexus.config.json）。
 *
 *   docs-audit        活文档审计（基准行/状态行/索引登记/相对链接）
 *   check-changelog   precommit：源码有改动而 CHANGELOG 无新增条目即拒
 *   install-hooks     core.hooksPath → .githooks，写入 pre-commit
 *   deploy            部署 dist 到自有服务器（冒烟 + 自动回滚）
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { changelogGate } from "./check-changelog.js";
import { loadNexusConfig } from "./config.js";
import { auditDocs } from "./docs-audit.js";
import { installHooks } from "./hooks.js";
function git(args, cwd) {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
}
function listMarkdown(dir) {
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory())
            out.push(...listMarkdown(p));
        else if (e.isFile() && e.name.endsWith(".md"))
            out.push(p);
    }
    return out;
}
const USAGE = "用法：nexus-devflow <docs-audit|check-changelog|install-hooks|deploy>";
async function main(cmd) {
    switch (cmd) {
        case "docs-audit": {
            const cfg = loadNexusConfig();
            const { errors, checked } = auditDocs({
                repoRoot: cfg.repoRoot,
                docsRoot: cfg.docs.root,
                archiveDir: cfg.docs.archiveDir,
                designDir: cfg.docs.designDir,
                index: cfg.docs.index,
            }, { listMarkdown, read: (p) => readFileSync(p, "utf8"), exists: existsSync });
            if (errors.length > 0) {
                console.error(`[docs] 审计失败（${errors.length} 项）：`);
                for (const e of errors)
                    console.error(`- ${e}`);
                return 1;
            }
            console.log(`[docs] 活文档索引、头部元数据与相对链接校验通过（${checked} 篇）`);
            return 0;
        }
        case "check-changelog": {
            let staged;
            let diff;
            try {
                const cfg = loadNexusConfig();
                staged = git(["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
                diff = git(["-c", "core.quotepath=false", "diff", "--cached", "-U0", "--", resolve(cfg.repoRoot, cfg.changelog.path)]);
                const verdict = changelogGate({ staged, changelogDiff: diff, sourceDirs: cfg.changelog.sourceDirs });
                if (!verdict.ok) {
                    console.error(verdict.message);
                    return 1;
                }
                return 0;
            }
            catch (error) {
                // git 不可用 / 非提交场景放行，但如实说明（不静默）
                console.warn(`[check-changelog] 跳过：${String(error).slice(0, 200)}`);
                return 0;
            }
        }
        case "install-hooks": {
            const cfg = loadNexusConfig();
            const written = installHooks(cfg.repoRoot, (args) => void git(args, cfg.repoRoot));
            console.log(`[hooks] core.hooksPath=.githooks${written.length > 0 ? `，已写入 ${written.join("、")}` : "（钩子已存在，未覆盖）"}`);
            return 0;
        }
        case "deploy": {
            const cfg = loadNexusConfig();
            if (cfg.deploy === null)
                throw new Error("[deploy] nexus.config.json 没有 deploy 段");
            const { runDeploy } = await import("./deploy.js");
            const { assertInjectedBuild, readBundleCodes } = await import("@nexus-kit/vite");
            runDeploy({ config: cfg.deploy, appRoot: resolve(cfg.repoRoot, cfg.appRoot) }, {
                run: (c, args) => execFileSync(c, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
                ssh: (remote) => execFileSync("ssh", ["-o", "ConnectTimeout=10", cfg.deploy.target, remote], {
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "inherit"],
                }),
                log: (m) => console.log(m),
                readFile: (p) => readFileSync(p, "utf8"),
                exists: existsSync,
                readBundleCodes,
                assertInjectedBuild,
            });
            return 0;
        }
        default:
            console.error(USAGE);
            return 2;
    }
}
main(process.argv[2]).then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
