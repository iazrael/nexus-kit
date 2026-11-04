/**
 * CLI 入口的 --help 与参数校验：全部子命令支持 --help/-h 查用法，
 * deploy、docs-audit、check-changelog、install-hooks 拒绝多余参数（误传 --help 不得触发实际动作）。
 *
 * 用例都在没有 nexus.config.json 的临时目录里跑：help 与参数校验在读配置之前生效，
 * 缺配置即可证明没有执行到命令本体。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const emptyDir = mkdtempSync(join(tmpdir(), "devflow-cli-test-"));
afterAll(() => rmSync(emptyDir, { recursive: true, force: true }));

function run(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: emptyDir, encoding: "utf8" });
}

describe("nexus-devflow --help 与参数校验", () => {
  it("deploy --help 打印用法，不执行部署", () => {
    const r = run(["deploy", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("用法");
    expect(r.stdout).toContain("deploy");
  });

  it("deploy -h 打印用法", () => {
    const r = run(["deploy", "-h"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("用法");
  });

  it("docs-audit --help 打印用法", () => {
    const r = run(["docs-audit", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("用法");
  });

  it("check-changelog --help 打印用法", () => {
    const r = run(["check-changelog", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("用法");
  });

  it("install-hooks --help 打印用法，不写钩子", () => {
    const r = run(["install-hooks", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("用法");
    expect(existsSync(join(emptyDir, ".githooks"))).toBe(false);
  });

  it("release --help 打印用法", () => {
    const r = run(["release", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("用法");
    expect(r.stdout).toContain("--ack");
  });

  it("deploy 多余参数拒绝执行", () => {
    const r = run(["deploy", "--oops"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("不接受参数");
    expect(r.stderr).toContain("用法");
  });

  it("根 --help 打印用法", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("用法");
  });

  it("缺子命令提示用法并退出 2", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("用法");
  });

  it("worktree --help 保留原有用法", () => {
    const r = run(["worktree", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("new");
  });

  it("task --help 保留原有用法", () => {
    const r = run(["task", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("用法");
  });
});
