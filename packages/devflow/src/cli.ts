#!/usr/bin/env node
/**
 * nexus-devflow：工程流程命令入口（读宿主仓库根 nexus.config.json）。
 *
 *   docs-audit        活文档审计（基准行/状态行/索引登记/相对链接）
 *   check-changelog   precommit：源码有改动而 CHANGELOG 无新增条目即拒
 *   install-hooks     core.hooksPath → .githooks，写入 pre-commit
 *   deploy            部署 dist 到自有服务器（冒烟 + 自动回滚）
 *   worktree <子命令>  并行开发工作树：new / merge / rm / ls / isolate / hook-create / hook-remove
 *   release           发版一条命令（--ack 执行、--lock 手动放锁、--unlock 清锁）
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { changelogGate } from "./check-changelog.ts";
import { loadNexusConfig } from "./config.ts";
import { auditDocs } from "./docs-audit.ts";
import { installHooks, outdatedHooks } from "./hooks.ts";

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listMarkdown(p));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

const USAGE = "用法：nexus-devflow <docs-audit|check-changelog|install-hooks|deploy|worktree|release|task>";

const WORKTREE_USAGE = `用法：
  nexus-devflow worktree new <分支名> [--from=<起点>] [--isolate=<共享项,共享项>]
  nexus-devflow worktree merge <分支名|工作树目录名|路径>
  nexus-devflow worktree rm <工作树目录名|路径> [--force]
  nexus-devflow worktree ls
  nexus-devflow worktree isolate <共享项,共享项> [--empty]     （在工作树里执行）
  nexus-devflow worktree hook-create | hook-remove           （Claude Code 钩子，读 stdin JSON）

  new      在主仓库同级的 <仓库名>-worktrees/ 下建树：自主干新建分支、共享项软链回主仓库、登记预览端口、
           跑 worktree.postCreate。--isolate 列出的共享项留空目录，由本树自己生成。
  merge    把分支合回主干：分支须先在工作树 git rebase <主干> 并验证，这里只快进；分叉即拒绝；被钩子
           拦下时自动还原主仓库残留；合入后在主仓库跑 worktree.postMerge，失败非零退出。单独执行，
           不与检查、回收串在一条命令里。
  rm       回收：先停该树起的服务与 pm2 应用，再删目录；未提交改动或不可再生的被忽略文件拒绝回收，
           确认都不要了加 --force。分支保留。
  isolate  把共享项改为本树独立：默认复制主仓库现有内容，--empty 留空。`;

/** 子命令输出走 stderr：钩子模式下 stdout 只许输出工作树路径 */
function runToStderr(cmd: string, args: readonly string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: ["ignore", 2, 2] });
}

async function worktreeCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      from: { type: "string" },
      isolate: { type: "string" },
      force: { type: "boolean" },
      empty: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (sub === undefined || values.help === true) {
    console.log(WORKTREE_USAGE);
    return sub === undefined ? 2 : 0;
  }
  const wt = await import("./worktree.ts");
  const { systemProcessProbe } = await import("./worktree-procs.ts");
  const hookMode = sub === "hook-create" || sub === "hook-remove";
  const env = {
    cwd: process.cwd(),
    config: loadNexusConfig().worktree,
    log: (m: string) => (hookMode ? console.error(m) : console.log(m)),
    procs: systemProcessProbe(),
    run: runToStderr,
  };
  const need = (what: string): string => {
    const v = positionals[0];
    if (v === undefined) throw new Error(`[worktree] 缺少${what}\n${WORKTREE_USAGE}`);
    return v;
  };
  const list = (v: string | undefined): string[] => (v === undefined ? [] : v.split(",").filter(Boolean));
  switch (sub) {
    case "new": {
      const branch = need("分支名");
      const { root, port } = wt.worktreeNew(env, {
        branch,
        isolate: list(values.isolate),
        ...(values.from === undefined ? {} : { from: values.from }),
      });
      console.log(`
[worktree] 就绪：${root}
  预览端口 ${port}（已登记到本工作树）：起服务加 --port ${port} --strictPort，端口撞了会静默连到别的检出。
  做完且验证全绿后：在本工作树 git rebase ${env.config.base} 并在变基后的代码上重新验证，
  然后回主仓库单独执行合回：pnpm worktree:merge ${branch}（即 nexus-devflow worktree merge）
  确认合入成功后回收：pnpm worktree:rm ${root.split("/").pop() ?? branch}`);
      return 0;
    }
    case "merge":
      wt.worktreeMerge(env, need("分支名"));
      return 0;
    case "rm":
      wt.worktreeRemove(env, need("工作树名"), { force: values.force === true });
      return 0;
    case "ls":
      for (const line of wt.worktreeList(env)) console.log(line);
      return 0;
    case "isolate":
      wt.worktreeIsolate(env, list(need("共享项")), values.empty === true);
      return 0;
    case "hook-create":
      console.log(wt.hookCreate(env, JSON.parse(readFileSync(0, "utf8")) as unknown));
      return 0;
    case "hook-remove":
      wt.hookRemove(env, JSON.parse(readFileSync(0, "utf8")) as unknown);
      return 0;
    default:
      console.error(WORKTREE_USAGE);
      return 2;
  }
}

async function releaseCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { ack: { type: "boolean" }, lock: { type: "boolean" }, unlock: { type: "boolean" }, "ttl-min": { type: "string" } },
  });
  const cfg = loadNexusConfig();
  const rel = await import("./release.ts");
  const commonDir = resolve(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
  if (values.unlock === true) {
    console.log(
      rel.clearReleaseLock(commonDir) ? `[release] 已清锁：${join(commonDir, rel.RELEASE_LOCK)}` : "[release] 没有发版锁，无需清理",
    );
    return 0;
  }
  if (values.lock === true) {
    const ttl = values["ttl-min"] === undefined ? cfg.release.holdTtlMin : Number(values["ttl-min"]);
    if (!Number.isInteger(ttl) || ttl < 1) throw new Error("[release] --ttl-min 必须是正整数");
    const lock = rel.holdReleaseLock(commonDir, {
      ref: `refs/heads/${cfg.worktree.base}`,
      ttlMin: ttl,
      now: new Date(),
      token: randomBytes(16).toString("hex"),
      pid: process.pid,
    });
    console.log(
      `[release] 发版锁已放：${cfg.worktree.base} 冻结 ${ttl} 分钟（至 ${new Date(lock.expires * 1000).toLocaleTimeString()}）。`,
    );
    console.log(
      `[release] 发版执行人在自己的会话 export ${rel.TOKEN_ENV}=${lock.token}（落款与评审修复的合入凭此放行），随后 release --ack 认领此锁续跑。`,
    );
    return 0;
  }
  const { parseChangelogHistory, INTERNAL_PREFIX, WIP_PREFIX } = await import("@nexus-kit/vite");
  rel.runRelease(
    {
      repoRoot: process.cwd(),
      appRoot: resolve(cfg.repoRoot, cfg.appRoot),
      changelogPath: resolve(cfg.repoRoot, cfg.changelog.path),
      base: cfg.worktree.base,
      config: cfg.release,
      ack: values.ack === true,
    },
    {
      git: (args) => git([...args]).trim(),
      run: (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" }),
      log: (m) => console.log(m),
      now: () => new Date(),
      token: () => randomBytes(16).toString("hex"),
      pid: process.pid,
      changelogSection: (md, version) => {
        const hit = parseChangelogHistory(md, { hiddenPrefixes: [] }).find((r) => r.version === version);
        return hit === undefined ? null : { date: hit.date, entries: hit.notes };
      },
      internalPrefix: INTERNAL_PREFIX,
      wipPrefix: WIP_PREFIX,
    },
  );
  return 0;
}

async function main(cmd: string | undefined): Promise<number> {
  switch (cmd) {
    case "docs-audit": {
      const cfg = loadNexusConfig();
      const { errors, checked } = auditDocs(
        {
          repoRoot: cfg.repoRoot,
          docsRoot: cfg.docs.root,
          archiveDir: cfg.docs.archiveDir,
          designDir: cfg.docs.designDir,
          index: cfg.docs.index,
        },
        { listMarkdown, read: (p) => readFileSync(p, "utf8"), exists: existsSync },
      );
      if (errors.length > 0) {
        console.error(`[docs] 审计失败（${errors.length} 项）：`);
        for (const e of errors) console.error(`- ${e}`);
        return 1;
      }
      console.log(`[docs] 活文档索引、头部元数据与相对链接校验通过（${checked} 篇）`);
      return 0;
    }
    case "check-changelog": {
      let staged: string[];
      let diff: string;
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
      } catch (error) {
        // git 不可用 / 非提交场景放行，但如实说明（不静默）
        console.warn(`[check-changelog] 跳过：${String(error).slice(0, 200)}`);
        return 0;
      }
    }
    case "install-hooks": {
      const cfg = loadNexusConfig();
      const written = installHooks(cfg.repoRoot, (args) => void git(args, cfg.repoRoot));
      console.log(`[hooks] core.hooksPath=.githooks${written.length > 0 ? `，已写入 ${written.join("、")}` : "（钩子已存在，未覆盖）"}`);
      const outdated = outdatedHooks(cfg.repoRoot);
      if (outdated.length > 0) {
        console.warn(
          `[hooks] ⚠ ${outdated.join("、")} 与当前 kit 版本的内容不同，未覆盖（可能是宿主改过或旧版 kit 装的）——` +
            "手动对比 @nexus-kit/devflow 的 hooks 导出（PRE_COMMIT / REFERENCE_TRANSACTION）合并进去，否则新逻辑（如发版锁）不生效",
        );
      }
      return 0;
    }
    case "deploy": {
      const cfg = loadNexusConfig();
      if (cfg.deploy === null) throw new Error("[deploy] nexus.config.json 没有 deploy 段");
      const { runDeploy } = await import("./deploy.ts");
      const { assertInjectedBuild, readBundleCodes } = await import("@nexus-kit/vite");
      runDeploy(
        { config: cfg.deploy, appRoot: resolve(cfg.repoRoot, cfg.appRoot) },
        {
          run: (c, args) => execFileSync(c, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
          ssh: (remote) =>
            execFileSync("ssh", ["-o", "ConnectTimeout=10", cfg.deploy!.target, remote], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "inherit"],
            }),
          log: (m) => console.log(m),
          readFile: (p) => readFileSync(p, "utf8"),
          exists: existsSync,
          readBundleCodes,
          assertInjectedBuild,
        },
      );
      return 0;
    }
    case "task": {
      const { taskCommand } = await import("./task/cli.ts");
      try {
        return await taskCommand(process.argv.slice(3));
      } catch (e) {
        throw new Error(`[task] ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    }
    case "worktree":
      return worktreeCmd(process.argv.slice(3));
    case "release":
      return releaseCmd(process.argv.slice(3));
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

main(process.argv[2]).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
