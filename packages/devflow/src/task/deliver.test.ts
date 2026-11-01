import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSelfChecks, readNote } from "./deliver.ts";

const head = "| 编号 | 操作 | 预期 | 自验结果 |\n| --- | --- | --- | --- |\n";

describe("clearSelfChecks", () => {
  it("清空验收表的自验结果列，其他列、其他表和无该列的旧表不动", () => {
    const content = `## 验收清单\n\n${head}| A1 | 跑 | 过 | 通过：x |\n| A2 | a \\| b | 过 | 不适用：y |\n\n| 说明 | 自验结果 |\n| --- | --- |\n| k | v |\n\n## 下一节\n| q | 通过：z |\n`;
    const cleared = clearSelfChecks(content);
    expect(cleared).toContain("| A1 | 跑 | 过 |  |");
    expect(cleared).toContain("| A2 | a \\| b | 过 |  |");
    expect(cleared).toContain("| k | v |");
    expect(cleared).toContain("| q | 通过：z |");
    const legacy = "## 验收清单\n| 编号 | 操作 |\n| --- | --- |\n| A1 | x |\n";
    expect(clearSelfChecks(legacy)).toBe(legacy);
  });
});

describe("readNote", () => {
  const setup = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "task-note-")));
    const wt = join(base, "wt");
    mkdirSync(wt);
    return { base, wt };
  };
  it("树外普通文件读出去掉首尾空白的内容", () => {
    const { base, wt } = setup();
    writeFileSync(join(base, "s.md"), "\n内容\n");
    expect(readNote(join(base, "s.md"), wt, "交付摘要")).toBe("内容");
  });
  it("经软链目录指进工作树的路径也判为树内", () => {
    const { base, wt } = setup();
    writeFileSync(join(wt, "s.md"), "x");
    symlinkSync(wt, join(base, "link"));
    expect(() => readNote(join(base, "link/s.md"), wt, "交付摘要")).toThrow(/工作树外/);
    expect(() => readNote(join(base, "link/missing.md"), wt, "交付摘要")).toThrow(/工作树外/);
  });
  it("软链文件、缺文件、空文件拒绝", () => {
    const { base, wt } = setup();
    writeFileSync(join(base, "real.md"), "x");
    symlinkSync(join(base, "real.md"), join(base, "alias.md"));
    expect(() => readNote(join(base, "alias.md"), wt, "交付摘要")).toThrow(/软链/);
    expect(() => readNote(join(base, "none.md"), wt, "交付摘要")).toThrow(/不存在/);
    writeFileSync(join(base, "empty.md"), "  \n");
    expect(() => readNote(join(base, "empty.md"), wt, "受阻原因")).toThrow(/受阻原因不能为空/);
  });
});
