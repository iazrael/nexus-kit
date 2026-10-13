import { describe, expect, it } from "vitest";
import { auditDocs, type DocsAuditFs } from "./docs-audit.ts";

function memFs(files: Record<string, string>): DocsAuditFs {
  const abs = (p: string) => `/repo/${p}`;
  const map = new Map(Object.entries(files).map(([k, v]) => [abs(k), v]));
  return {
    listMarkdown: (dir) => [...map.keys()].filter((p) => p.startsWith(`${dir}/`) && p.endsWith(".md")),
    read: (p) => map.get(p) ?? "",
    exists: (p) => map.has(p) || [...map.keys()].some((k) => k.startsWith(`${p}/`)),
  };
}

const OPTS = { repoRoot: "/repo", docsRoot: "docs", archiveDir: "docs/存档", designDir: "docs/设计", index: "CLAUDE.md" };

describe("auditDocs", () => {
  it("合格文档树通过；存档不查", () => {
    const fs = memFs({
      "CLAUDE.md": "docs/需求/需求.md docs/设计/方案.md",
      "docs/需求/需求.md": "# 需求\n\n> 基准：0.1.0 / 2026-10-13\n\n见[方案](../设计/方案.md#a)与[外链](https://x)与[根](/abs)",
      "docs/设计/方案.md": "# 方案\n\n> 状态：讨论中\n> 基准：2026-10-13\n",
      "docs/存档/旧_2026-01-01.md": "随便写",
    });
    expect(auditDocs(OPTS, fs)).toEqual({ errors: [], checked: 2 });
  });

  it("缺基准、设计稿缺状态、未登记、断链都报出", () => {
    const fs = memFs({
      "CLAUDE.md": "docs/设计/方案.md",
      "docs/需求/需求.md": "# 需求\n\n[坏链](./不存在.md)",
      "docs/设计/方案.md": "# 方案\n\n> 基准：x\n",
    });
    const { errors } = auditDocs(OPTS, fs);
    expect(errors).toEqual([
      "docs/需求/需求.md: 头部前 20 行缺少「基准」",
      "docs/需求/需求.md: 未登记到 CLAUDE.md 文档索引",
      "docs/需求/需求.md: 相对链接不存在：./不存在.md",
      "docs/设计/方案.md: 设计稿头部前 20 行缺少「状态」",
    ]);
  });

  it("索引文件缺失单独报出", () => {
    expect(auditDocs(OPTS, memFs({})).errors).toEqual(["CLAUDE.md: 索引文件不存在或为空"]);
  });

  it("百分号编码与非法编码的链接都能解析", () => {
    const fs = memFs({
      "CLAUDE.md": "docs/a.md",
      "docs/a.md": "> 基准：x\n[b](%E4%B8%AD.md) [c](%E4%ZZ.md)",
      "docs/中.md": "",
    });
    expect(auditDocs(OPTS, fs).errors.sort()).toEqual(
      ["docs/a.md: 相对链接不存在：%E4%ZZ.md", "docs/中.md: 头部前 20 行缺少「基准」", "docs/中.md: 未登记到 CLAUDE.md 文档索引"].sort(),
    );
  });
});
