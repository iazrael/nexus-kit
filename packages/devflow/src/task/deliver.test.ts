import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAcceptance, clearSelfChecks, formatSummary, readNote } from "./deliver.ts";

const head = "| 编号 | 操作 | 预期 | 自验结果 |\n| --- | --- | --- | --- |\n";

describe("checkAcceptance", () => {
  it("每行写通过或不适用时返回条数", () => {
    expect(
      checkAcceptance(`## 验收清单\n\n${head}| A1 | 跑 | 过 | 通过：out.json |\n| A2 | 并发 | 不重复 | 不适用：无入口 |\n\n## 下一节\n`),
    ).toBe(2);
  });
  it("CRLF 文件与标题紧跟文件结尾都能解析", () => {
    expect(checkAcceptance(`## 验收清单\r\n\r\n${head.replaceAll("\n", "\r\n")}| A1 | 跑 | 过 | 通过：x |\r\n`)).toBe(1);
    expect(() => checkAcceptance("## 验收清单")).toThrow(/没有条目/);
  });
  it("只认标题后的第一张表，后面的说明表和代码块里的表不算条目", () => {
    const content = `## 验收清单\n\n${head}| A1 | 跑 | 过 | 通过：x |\n\n| 说明 | 值 |\n| --- | --- |\n| a | b |\n\n\`\`\`\n| X | y |\n## 示例\n\`\`\`\n\n## 下一节\n| B9 | 不 | 算 | |\n`;
    expect(checkAcceptance(content)).toBe(1);
  });
  it("代码块里的表格不能冒充验收表，围栏里的标题不提前结束本节", () => {
    const fenced = `## 验收清单\n\n\`\`\`\n${head}| Z | 例 | 子 | 通过：假 |\n## 示例\n\`\`\`\n\n${head}| A1 | 跑 | 过 | |\n`;
    expect(() => checkAcceptance(fenced)).toThrow(/A1/);
  });
  it("转义竖线不切列，空格和未完成都报编号", () => {
    expect(checkAcceptance(`## 验收清单\n${head}| A1 | a \\| b | 过 | 通过：x |\n`)).toBe(1);
    expect(() => checkAcceptance(`## 验收清单\n${head}| A1 | 跑 | 过 | 未完成 |\n| A2 | 跑 | 过 | 通过： |\n`)).toThrow(/A1、A2/);
  });
  it("缺节、缺列给出明确提示", () => {
    expect(() => checkAcceptance("## 别的\n")).toThrow(/缺少「## 验收清单」/);
    expect(() => checkAcceptance("## 验收清单\n| 编号 | 操作 |\n| --- | --- |\n| A1 | x |\n")).toThrow(/自验结果.*列/);
  });
});

describe("clearSelfChecks", () => {
  it("清空验收表的自验结果列，其他列、其他表和无该列的旧表不动", () => {
    const content = `## 验收清单\n\n${head}| A1 | 跑 | 过 | 通过：x |\n| A2 | a \\| b | 过 | 不适用：y |\n\n| 说明 | 自验结果 |\n| --- | --- |\n| k | v |\n\n## 下一节\n| q | 通过：z |\n`;
    const cleared = clearSelfChecks(content);
    expect(cleared).toContain("| A1 | 跑 | 过 |  |");
    expect(cleared).toContain("| A2 | a \\| b | 过 |  |");
    expect(cleared).toContain("| k | v |");
    expect(cleared).toContain("| q | 通过：z |");
    expect(() => checkAcceptance(cleared)).toThrow(/A1、A2/);
    const legacy = "## 验收清单\n| 编号 | 操作 |\n| --- | --- |\n| A1 | x |\n";
    expect(clearSelfChecks(legacy)).toBe(legacy);
  });
});

describe("formatSummary", () => {
  it("编号补齐、乱序自动按三段顺序重排，内容可以换行写，CRLF 也认", () => {
    expect(formatSummary("改了什么：a\r\n2. 验证如何：b\r\n还有什么：无")).toBe("1. 改了什么：a\n2. 验证如何：b\n3. 还有什么：无");
    expect(formatSummary("改了什么：a\n还有什么：无\n验证如何：b")).toBe("1. 改了什么：a\n2. 验证如何：b\n3. 还有什么：无");
    expect(formatSummary("改了什么：\n- 取消不扣款\n验证如何：b\n还有什么：无")).toBe(
      "1. 改了什么：\n   - 取消不扣款\n2. 验证如何：b\n3. 还有什么：无",
    );
  });
  it("缺段、空段、重复段和首段前多余内容拒绝", () => {
    expect(() => formatSummary("改了什么：a\n验证如何：b")).toThrow(/缺少：还有什么/);
    expect(() => formatSummary("改了什么：\n验证如何：b\n还有什么：无")).toThrow(/改了什么.*没有内容/);
    expect(() => formatSummary("改了什么：a\n改了什么：b\n验证如何：b\n还有什么：无")).toThrow(/重复/);
    expect(() => formatSummary("前言说明\n改了什么：a\n验证如何：b\n还有什么：无")).toThrow(/开头/);
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
