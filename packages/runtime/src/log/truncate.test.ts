import { describe, expect, it } from "vitest";
import { truncateExport } from "./truncate.ts";

const head = "# 诊断日志\n本次会话：S\n\n## 上次退出\n判词：疑似异常退出\n\n## 日志\n";
const lines = Array.from({ length: 100 }, (_, i) => `2026-10-14 10:00:${String(i).padStart(2, "0")}.000 INFO  [app] 第 ${i} 行`);
const full = `${head}--- 会话 S（本次），首条 x ---\n${lines.join("\n")}\n`;

describe("truncateExport", () => {
  it("不超限原样返回", () => {
    expect(truncateExport(full, full.length)).toBe(full);
  });

  it("超限：头部摘要完整保留，日志只取最近的整行；保留部分前补上所属会话的分隔行；注明省略了多少行", () => {
    const out = truncateExport(full, 1200);
    expect(out.length).toBeLessThanOrEqual(1200);
    expect(out.startsWith(head)).toBe(true);
    expect(out).toMatch(/（已截取：省略了较早的 \d+ 行日志）/);
    expect(out.trimEnd().endsWith("第 99 行")).toBe(true);
    expect(out).toContain("--- 会话 S（本次），首条 x ---");
    const kept = out.split("\n").filter((l) => l.includes("[app]"));
    const omitted = Number(/省略了较早的 (\d+) 行/.exec(out)![1]);
    expect(kept.length + omitted).toBe(100);
  });

  it("省略说明可由宿主定（按钮名等文案归宿主）", () => {
    const out = truncateExport(full, 1200, { note: (n) => `省略 ${n} 行，完整的请点「下载诊断文件」` });
    expect(out).toMatch(/省略 \d+ 行，完整的请点「下载诊断文件」/);
  });

  it("最后一行就超出预算（长堆栈）：截前半段保留，不整行丢掉", () => {
    const long = `${head}--- 会话 S（本次），首条 x ---\n${"y".repeat(5000)}\n`;
    const out = truncateExport(long, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).toMatch(/y{100,}…/);
  });

  it("恰好等于上限原样返回；空日志节原样返回", () => {
    expect(truncateExport(full, full.length)).toBe(full);
    expect(truncateExport(head, 10)).toContain("已截取");
  });

  it("连头部都放不下：硬截到上限并注明", () => {
    const out = truncateExport(full, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain("已截取");
  });

  it("没有日志节的文本：从末尾保留", () => {
    const out = truncateExport("x".repeat(500), 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain("已截取");
  });
});
