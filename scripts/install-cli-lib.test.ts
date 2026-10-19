import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOnPath, installLink, mainRepoRoot, pathAdvice, planLink } from "./install-cli-lib.ts";

const roots: string[] = [];
function temp() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-cli-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("planLink", () => {
  it("不存在就新建，已指向目标就保持，指向别处的软链替换，其他一律拒绝", () => {
    expect(planLink({ kind: "missing" }, "/kit/cli.js")).toEqual({ action: "create" });
    expect(planLink({ kind: "symlink", target: "/kit/cli.js" }, "/kit/cli.js")).toEqual({ action: "keep" });
    expect(planLink({ kind: "symlink", target: "/old/cli.js" }, "/kit/cli.js")).toEqual({ action: "replace" });
    expect(planLink({ kind: "other" }, "/kit/cli.js")).toEqual({ action: "refuse" });
  });
});

describe("pathAdvice", () => {
  const link = "/home/u/.local/bin/nexus-devflow";
  it("目录在 PATH 里且第一个命中就是本软链时通过", () => {
    expect(pathAdvice("/usr/bin:/home/u/.local/bin", "/home/u/.local/bin", link, link)).toEqual({ ok: true });
  });
  it("目录不在 PATH 里时给出要加进 shell 配置的那一行", () => {
    const advice = pathAdvice("/usr/bin:/bin", "/home/u/.local/bin", null, link);
    expect(advice.ok).toBe(false);
    expect(advice.ok ? "" : advice.message).toContain('export PATH="/home/u/.local/bin:$PATH"');
  });
  it("PATH 前面另有同名命令遮住本软链时报出它的位置", () => {
    const advice = pathAdvice("/opt/bin:/home/u/.local/bin", "/home/u/.local/bin", "/opt/bin/nexus-devflow", link);
    expect(advice.ok).toBe(false);
    expect(advice.ok ? "" : advice.message).toContain("/opt/bin/nexus-devflow");
  });
  it("bin 目录本身是软链时，PATH 写真实目录或软链名都能认出", () => {
    const root = temp();
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    const link = join(root, "alias/nexus-devflow");
    expect(pathAdvice(join(root, "real"), join(root, "alias"), join(root, "real/nexus-devflow"), link)).toEqual({ ok: true });
  });
  it("PATH 里的目录写法带尾斜杠也能认出", () => {
    expect(pathAdvice("/home/u/.local/bin/", "/home/u/.local/bin", link, link)).toEqual({ ok: true });
  });
});

describe("findOnPath", () => {
  it("按 PATH 顺序返回第一个存在的同名项，没有就返回 null", () => {
    const root = temp();
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "b/nexus-devflow"), "", { mode: 0o755 });
    expect(findOnPath(`${join(root, "a")}:${join(root, "b")}`, "nexus-devflow")).toBe(join(root, "b/nexus-devflow"));
    // shell 会跳过同名目录、无执行位文件和悬空软链
    mkdirSync(join(root, "a/nexus-devflow"));
    mkdirSync(join(root, "c"));
    writeFileSync(join(root, "c/nexus-devflow"), "", { mode: 0o644 });
    mkdirSync(join(root, "d"));
    symlinkSync(join(root, "gone"), join(root, "d/nexus-devflow"));
    const dirs = ["a", "c", "d", "b"].map((d) => join(root, d)).join(":");
    expect(findOnPath(dirs, "nexus-devflow")).toBe(join(root, "b/nexus-devflow"));
    expect(findOnPath(join(root, "a"), "nexus-devflow")).toBeNull();
  });
});

describe("installLink", () => {
  it("目录不存在时建目录并建软链；重复执行保持不动", () => {
    const root = temp(),
      link = join(root, "bin/nexus-devflow");
    expect(installLink(link, "/kit/cli.js")).toEqual({ action: "create", previous: null });
    expect(readlinkSync(link)).toBe("/kit/cli.js");
    expect(installLink(link, "/kit/cli.js")).toEqual({ action: "keep", previous: "/kit/cli.js" });
  });
  it("替换指向别处或悬空的软链", () => {
    const root = temp(),
      link = join(root, "nexus-devflow");
    symlinkSync(join(root, "gone/cli.js"), link);
    expect(installLink(link, "/kit/cli.js")).toEqual({ action: "replace", previous: join(root, "gone/cli.js") });
    expect(readlinkSync(link)).toBe("/kit/cli.js");
    expect(readdirSync(root)).toEqual(["nexus-devflow"]);
  });
  it("同名普通文件或目录拒绝覆盖，报错带路径", () => {
    const root = temp(),
      file = join(root, "nexus-devflow");
    writeFileSync(file, "keep me");
    expect(() => installLink(file, "/kit/cli.js")).toThrow(file);
    const dir = join(root, "dir/nexus-devflow");
    mkdirSync(dir, { recursive: true });
    expect(() => installLink(dir, "/kit/cli.js")).toThrow(dir);
  });
});

describe("mainRepoRoot", () => {
  it("在主仓库和工作树里都返回主仓库根", () => {
    const root = temp(),
      main = join(root, "kit");
    mkdirSync(main);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git(main, "init", "-q", "-b", "main");
    git(main, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", join(root, "tree"), "-b", "tree");
    mkdirSync(join(root, "tree/sub"));
    expect(mainRepoRoot(main)).toBe(main);
    expect(mainRepoRoot(join(root, "tree/sub"))).toBe(main);
  });
});
