/**
 * 发版验收：临时目录建真 git 仓库 + 本地裸仓库当 origin，装真 reference-transaction 钩子。
 * 发版链步骤与 gh 走记录型假件（不真跑 check/deploy），git 的 tag、推送、引用拦截全部真跑。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTERNAL_PREFIX, parseChangelogHistory, WIP_PREFIX } from "@nexus-kit/vite";
import { afterEach, describe, expect, it } from "vitest";
import { parseNexusConfig, type ReleaseConfig } from "../config/config.ts";
import { installHooks } from "../hooks/hooks.ts";
import { clearReleaseLock, holdReleaseLock, readReleaseLock, RELEASE_LOCK, runRelease, TOKEN_ENV, type ReleaseDeps } from "./release.ts";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date(2026, 9, 14, 10, 0, 0);
const TODAY = "2026-10-14";

function git(cwd: string, argv: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();
}

function changelog(version: string, date: string, entries: string[]): string {
  return `# 更新日志\n\n## [Unreleased]\n\n## [${version}] - ${date}\n\n${entries.map((e) => `- ${e}`).join("\n")}\n\n## [0.9.0] - 2026-10-01\n\n- 旧条目\n`;
}

/** 主仓库（已装 devflow 钩子、有 v0.9.0 tag、origin 指向本地裸仓库）+ 待发 1.0.0 */
function newRepo(entries: string[] = ["新增：首页", "内部：重构"], date = TODAY) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "nexus-rel-")));
  temps.push(base);
  const root = join(base, "app");
  const origin = join(base, "origin.git");
  mkdirSync(root);
  git(base, ["init", "-q", "--bare", origin]);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@nexus.local"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["remote", "add", "origin", origin]);
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.9.0" }));
  writeFileSync(join(root, "CHANGELOG.md"), changelog("0.9.0", "2026-10-01", ["旧条目"]));
  installHooks(root, (args) => void git(root, args));
  // pre-commit 门禁调 nexus-devflow，临时仓库里没有：建历史一律 --no-verify（reference-transaction 不受影响）
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-verify", "-m", "v0.9.0"]);
  git(root, ["tag", "v0.9.0"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(root, "CHANGELOG.md"), changelog("1.0.0", date, entries));
  git(root, ["commit", "-q", "--no-verify", "-am", "落款 1.0.0"]);
  return { root, origin, commonDir: join(root, ".git") };
}

function harness(opts: { config?: Partial<ReleaseConfig>; entries?: string[]; date?: string; onRun?: (line: string) => void } = {}) {
  const repo = newRepo(opts.entries, opts.date);
  const logs: string[] = [];
  const runs: string[] = [];
  const config: ReleaseConfig = {
    ...parseNexusConfig({ release: { steps: [["check"], ["deploy"]], githubRelease: true } }, repo.root).release,
    ...opts.config,
  };
  const deps: ReleaseDeps = {
    git: (args) => git(repo.root, [...args]),
    run: (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      runs.push(line);
      opts.onRun?.(line);
    },
    log: (m) => void logs.push(m),
    now: () => NOW,
    token: () => "tok123",
    pid: 4242,
    changelogSection: (md, version) => {
      const hit = parseChangelogHistory(md, { hiddenPrefixes: [] }).find((r) => r.version === version);
      return hit === undefined ? null : { date: hit.date, entries: hit.notes };
    },
    internalPrefix: INTERNAL_PREFIX,
    wipPrefix: WIP_PREFIX,
  };
  const input = { repoRoot: repo.root, appRoot: repo.root, changelogPath: join(repo.root, "CHANGELOG.md"), base: "main", config };
  return { ...repo, logs, runs, deps, input };
}

const lockFile = (commonDir: string): string => join(commonDir, RELEASE_LOCK);

describe("runRelease", () => {
  it("不带 --ack：只校验与报范围，打印两道门禁后拒绝，不放锁不跑链", () => {
    const h = harness();
    expect(() => runRelease({ ...h.input, ack: false }, h.deps)).toThrow(/未带 --ack/);
    expect(h.logs.join("\n")).toMatch(/v0\.9\.0\.\.HEAD 共 1 个提交/);
    expect(h.runs).toEqual([]);
    expect(existsSync(lockFile(h.commonDir))).toBe(false);
  });

  it("全链：放锁 → 步骤 → 打 tag → 推送主干与 tag → GitHub Release（正文为落款小节全量条目）→ 收锁", () => {
    let lockedDuringSteps = false;
    const h = harness({ onRun: (line) => line === "check" && (lockedDuringSteps = existsSync(lockFile(h.commonDir))) });
    runRelease({ ...h.input, ack: true }, h.deps);
    expect(lockedDuringSteps).toBe(true);
    expect(h.runs.slice(0, 2)).toEqual(["check", "deploy"]);
    expect(h.runs[2]).toMatch(/^gh release create v1\.0\.0 --title v1\.0\.0 --notes-file /);
    expect(git(h.root, ["tag", "--list", "v1.0.0"])).toBe("v1.0.0");
    expect(git(h.origin, ["rev-parse", "main"])).toBe(git(h.root, ["rev-parse", "HEAD"]));
    expect(git(h.origin, ["tag", "--list", "v1.0.0"])).toBe("v1.0.0");
    expect(existsSync(lockFile(h.commonDir))).toBe(false);
  });

  it("GitHub Release 正文含全量条目（含内部）与构建落款", () => {
    let notes = "";
    const h = harness({
      onRun: (line) => {
        const file = /--notes-file (\S+)/.exec(line)?.[1];
        if (file !== undefined) notes = readFileSync(file, "utf8");
      },
    });
    mkdirSync(join(h.root, "dist"));
    writeFileSync(join(h.root, "dist/version.json"), JSON.stringify({ version: "1.0.0", build: 37 }));
    runRelease({ ...h.input, ack: true }, h.deps);
    expect(notes).toBe(`- 新增：首页\n- 内部：重构\n\n---\n构建 1.0.0+b37 · ${TODAY}\n`);
  });

  it("关掉推送与 GitHub Release 时只打本地 tag", () => {
    const h = harness({ config: { push: false, githubRelease: false } });
    runRelease({ ...h.input, ack: true }, h.deps);
    expect(h.runs).toEqual(["check", "deploy"]);
    expect(git(h.origin, ["tag", "--list"])).toBe("");
  });

  it("链中 HEAD 变化：中止、不打 tag、锁照收", () => {
    const h = harness({
      onRun: (line) => {
        if (line === "check") git(h.root, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "插队"], { [TOKEN_ENV]: "tok123" });
      },
    });
    expect(() => runRelease({ ...h.input, ack: true }, h.deps)).toThrow(/HEAD 在链中变化/);
    expect(h.runs).toEqual(["check"]);
    expect(git(h.root, ["tag", "--list", "v1.0.0"])).toBe("");
    expect(existsSync(lockFile(h.commonDir))).toBe(false);
  });

  it("每步开始前续期：链跑得比锁有效期长时主干也不会中途解冻", () => {
    const expires: number[] = [];
    let t = NOW.getTime();
    const h = harness({ onRun: () => void expires.push(readReleaseLock(lockFile(h.commonDir))!.expires) });
    h.deps.now = () => new Date((t += 20 * 60_000)); // 每次取时钟过 20 分钟，锁有效期 30 分钟
    runRelease({ ...h.input, ack: true }, h.deps);
    // check、deploy、gh 三次执行时各自看到的锁失效时刻：每步前续期，逐次后移 20 分钟
    expect(expires.map((e, i) => e - expires[0]! - i * 20 * 60)).toEqual([0, 0, 0]);
  });

  it("链中锁被清除或换成别人的：中止，不删别人的锁", () => {
    const h = harness({
      onRun: (line) => {
        if (line === "check") {
          clearReleaseLock(h.commonDir);
          holdReleaseLock(h.commonDir, { ref: "refs/heads/main", ttlMin: 10, now: NOW, token: "someone-else", pid: 1 });
        }
      },
    });
    expect(() => runRelease({ ...h.input, ack: true }, h.deps)).toThrow(/发版锁在链中被清除或替换/);
    expect(h.runs).toEqual(["check"]);
    expect(readReleaseLock(lockFile(h.commonDir))?.token).toBe("someone-else");
  });

  it("步骤失败：锁照收，错误原样抛出", () => {
    const h = harness({
      onRun: (line) => {
        if (line === "deploy") throw new Error("冒烟失败");
      },
    });
    expect(() => runRelease({ ...h.input, ack: true }, h.deps)).toThrow(/冒烟失败/);
    expect(existsSync(lockFile(h.commonDir))).toBe(false);
  });

  it.each([
    [{ entries: ["内部：只有内部"] }, /没有对外条目/],
    [{ entries: ["新增：A", "WIP：半成品"] }, /WIP/],
    [{ date: "2026-10-13" }, /日期不是今天/],
  ])("落款小节不合格拒绝 %#", (opts, err) => {
    const h = harness(opts);
    expect(() => runRelease({ ...h.input, ack: true }, h.deps)).toThrow(err);
    expect(h.runs).toEqual([]);
  });

  it("缺落款小节、tag 已存在、不在主干、工作区不干净、在工作树里执行：拒绝", () => {
    const h = harness();
    writeFileSync(join(h.root, "CHANGELOG.md"), changelog("0.9.0", "2026-10-01", ["旧条目"]));
    git(h.root, ["commit", "-q", "--no-verify", "-am", "撤落款"]);
    expect(() => runRelease({ ...h.input, ack: true }, h.deps)).toThrow(/缺 \[1\.0\.0\] 落款小节/);
    git(h.root, ["checkout", "HEAD~1", "--", "CHANGELOG.md"]);
    git(h.root, ["commit", "-q", "--no-verify", "-m", "恢复落款"]);
    git(h.root, ["tag", "v1.0.0"]);
    expect(() => runRelease({ ...h.input, ack: true }, h.deps)).toThrow(/tag v1\.0\.0 已存在/);
    git(h.root, ["tag", "-d", "v1.0.0"]);
    writeFileSync(join(h.root, "x.txt"), "x");
    expect(() => runRelease({ ...h.input, ack: true }, h.deps)).toThrow(/不干净/);
    rmSync(join(h.root, "x.txt"));
    git(h.root, ["switch", "-qc", "other"]);
    expect(() => runRelease({ ...h.input, ack: true }, h.deps)).toThrow(/不是 main/);
    git(h.root, ["switch", "-q", "main"]);
    const wt = join(h.root, "..", "wt");
    git(h.root, ["worktree", "add", "-q", wt, "-b", "wt"]);
    expect(() => runRelease({ ...h.input, repoRoot: wt, ack: true }, { ...h.deps, git: (args) => git(wt, [...args]) })).toThrow(/工作树/);
  });

  it("认领 --lock 放的锁：续期并写入实际版本号，链末收锁；过期残锁拒绝认领", () => {
    const h = harness();
    holdReleaseLock(h.commonDir, { ref: "refs/heads/main", ttlMin: 120, now: NOW, token: "held", pid: 1 });
    let during: ReturnType<typeof readReleaseLock> = null;
    h.deps.run = (cmd) => void (cmd === "check" && (during = readReleaseLock(lockFile(h.commonDir))));
    runRelease({ ...h.input, ack: true }, h.deps);
    expect(during).toMatchObject({ version: "1.0.0", token: "held", expires: Math.floor(NOW.getTime() / 1000) + 30 * 60 });
    expect(existsSync(lockFile(h.commonDir))).toBe(false);

    const h2 = harness();
    holdReleaseLock(h2.commonDir, { ref: "refs/heads/main", ttlMin: 1, now: new Date(NOW.getTime() - 5 * 60_000), token: "old", pid: 1 });
    expect(() => runRelease({ ...h2.input, ack: true }, h2.deps)).toThrow(/已过期或损坏/);
  });
});

describe("发版锁与 reference-transaction 钩子（真 git）", () => {
  const nowSec = (): Date => new Date();

  it("锁在：对主干的提交被拒；持令放行；其他分支照常；--unlock 后放行", () => {
    const { root, commonDir } = newRepo();
    holdReleaseLock(commonDir, { ref: "refs/heads/main", ttlMin: 10, now: nowSec(), token: "tk", pid: 1 });
    const commit = (env: NodeJS.ProcessEnv = {}): string => git(root, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "x"], env);
    expect(() => commit()).toThrow(/发版锁生效中：（版本待定） 正在发布/);
    expect(() => commit({ [TOKEN_ENV]: "wrong" })).toThrow(/发版锁生效中/);
    commit({ [TOKEN_ENV]: "tk" });
    git(root, ["switch", "-qc", "side"]);
    commit();
    git(root, ["switch", "-q", "main"]);
    expect(clearReleaseLock(commonDir)).toBe(true);
    expect(clearReleaseLock(commonDir)).toBe(false);
    commit();
  });

  it("锁过期或损坏一律放行（fail-open）", () => {
    const { root, commonDir } = newRepo();
    holdReleaseLock(commonDir, { ref: "refs/heads/main", ttlMin: 1, now: new Date(Date.now() - 5 * 60_000), token: "tk", pid: 1 });
    git(root, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "expired"]);
    writeFileSync(lockFile(commonDir), "{坏");
    git(root, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "corrupt"]);
  });

  it("holdReleaseLock：已有未过期锁拒绝重放，过期锁替换", () => {
    const { commonDir } = newRepo();
    const lock = holdReleaseLock(commonDir, { ref: "refs/heads/main", ttlMin: 10, now: NOW, token: "a", pid: 1 });
    expect(lock).toMatchObject({ version: "pending", token: "a", ref: "refs/heads/main" });
    expect(() => holdReleaseLock(commonDir, { ref: "refs/heads/main", ttlMin: 10, now: NOW, token: "b", pid: 1 })).toThrow(/已在放/);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    expect(holdReleaseLock(commonDir, { ref: "refs/heads/main", ttlMin: 10, now: later, token: "c", pid: 1 }).token).toBe("c");
  });
});
