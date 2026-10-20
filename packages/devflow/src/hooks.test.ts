import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installHooks, outdatedHooks, PRE_COMMIT, REFERENCE_TRANSACTION } from "./hooks.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("installHooks", () => {
  it("写入可执行 pre-commit 与 reference-transaction 并设置 core.hooksPath；已存在不覆盖", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-hooks-"));
    dirs.push(root);
    const git = vi.fn();
    expect(installHooks(root, git)).toEqual([".githooks/pre-commit", ".githooks/reference-transaction"]);
    const file = join(root, ".githooks/pre-commit");
    expect(readFileSync(file, "utf8")).toBe(PRE_COMMIT);
    expect(readFileSync(join(root, ".githooks/reference-transaction"), "utf8")).toBe(REFERENCE_TRANSACTION);
    expect(statSync(file).mode & 0o111).not.toBe(0);
    expect(git).toHaveBeenCalledWith(["config", "core.hooksPath", ".githooks"]);
    expect(outdatedHooks(root)).toEqual([]);
    writeFileSync(file, "custom");
    expect(installHooks(root, git)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("custom");
    expect(outdatedHooks(root)).toEqual([".githooks/pre-commit"]);
  });
});

describe("PRE_COMMIT 找命令的顺序", () => {
  /** 在 cwd 下用 sh 执行钩子；PATH 只含 extra 与系统目录，隔离本机的全局 nexus-devflow */
  function runHook(cwd: string, extraPath: string | null) {
    const hook = join(cwd, "pre-commit");
    writeFileSync(hook, PRE_COMMIT, { mode: 0o755 });
    return spawnSync("/bin/sh", [hook], {
      cwd,
      encoding: "utf8",
      env: { PATH: [extraPath, "/usr/bin", "/bin"].filter(Boolean).join(":") },
    });
  }
  function fakeCli(dir: string, label: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nexus-devflow"), `#!/bin/sh\necho "${label} $*"\n`, { mode: 0o755 });
  }

  it("项目依赖里有就用依赖里钉住的版本，不看 PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-precommit-"));
    dirs.push(root);
    fakeCli(join(root, "node_modules/.bin"), "local");
    fakeCli(join(root, "global"), "global");
    const r = runHook(root, join(root, "global"));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("local check-changelog");
  });
  it("依赖里没有就用 PATH 上的全局命令", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-precommit-"));
    dirs.push(root);
    fakeCli(join(root, "global"), "global");
    const r = runHook(root, join(root, "global"));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("global check-changelog");
  });
  it("两处都没有：非零退出并提示 install-cli，不静默放行", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-precommit-"));
    dirs.push(root);
    const r = runHook(root, null);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("pnpm install-cli");
  });
});
