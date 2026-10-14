import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
