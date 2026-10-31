import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const dirs: string[] = [];
function fixture(git = true): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-changelog-"));
  dirs.push(dir);
  if (git) execFileSync("git", ["init", "-q", dir]);
  writeFileSync(
    join(dir, "nexus.config.json"),
    JSON.stringify({
      changelog: { path: "CHANGELOG.md", sourceDirs: ["src/"] },
      task: { executor: "future-executor" },
      deploy: { invalid: true },
    }),
  );
  return dir;
}
function stage(dir: string, file: string, text: string): void {
  const path = join(dir, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  execFileSync("git", ["add", "--", file], { cwd: dir });
}
function run(dir: string) {
  return spawnSync(process.execPath, [cli, "check-changelog"], { cwd: dir, encoding: "utf8" });
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("check-changelog CLI", () => {
  it("只改文档时忽略无关执行器和部署配置", () => {
    const dir = fixture();
    stage(dir, "docs/a.md", "文档");
    const result = run(dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("跳过");
  });
  it("源码缺少 CHANGELOG 时仍然阻断，不受无关配置影响", () => {
    const dir = fixture();
    stage(dir, "src/a.ts", "export const x = 1;");
    const result = run(dir);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("CHANGELOG 没有新增条目");
  });
  it("源码和 CHANGELOG 一起暂存时通过", () => {
    const dir = fixture();
    stage(dir, "src/a.ts", "export const x = 1;");
    stage(dir, "CHANGELOG.md", "- 修复检查");
    const result = run(dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("跳过");
  });
  it.each(["{", JSON.stringify({ changelog: { sourceDirs: 42 } })])("配置不可读或字段非法时拒绝：%s", (config) => {
    const dir = fixture();
    writeFileSync(join(dir, "nexus.config.json"), config);
    const result = run(dir);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).not.toContain("跳过");
  });
  it("Git 读取失败时拒绝", () => {
    const result = run(fixture(false));
    expect(result.stderr).toContain("git");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).not.toContain("跳过");
  });
  it("缺配置时拒绝", () => {
    const dir = fixture();
    rmSync(join(dir, "nexus.config.json"));
    const result = run(dir);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).not.toContain("跳过");
  });
});
