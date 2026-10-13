import { describe, expect, it } from "vitest";
import { INTERNAL_PREFIX, WIP_PREFIX, findWipLeaks, parseChangelogHistory, parseUnreleased, UNRELEASED } from "./changelog.ts";

const FIXTURE = `# 更新日志

日常条目先记入 Unreleased 小节；发版时整合落款。

## [Unreleased]

- 修复：还没发版的修复一条
- 内部：只留档的内部条目
- WIP：未开放功能的开发记录

## [1.2.0] - 2026-09-23

- 新增：命运之刃五步链
- 内部：构建管线内部调整
- 修复：药包打不开

## [1.1.0] - 2026-09-23

* 星号条目也要能解析
- 内部：纯内部的小节

## [1.0.0] - 2026-09-23

- 内部：全是内部条目的小节

`;

describe("parseChangelogHistory", () => {
  it("按文件顺序返回已发版小节，解析日期并剔除内部条目", () => {
    expect(parseChangelogHistory(FIXTURE)).toEqual([
      { version: "1.2.0", date: "2026-09-23", notes: ["新增：命运之刃五步链", "修复：药包打不开"] },
      { version: "1.1.0", date: "2026-09-23", notes: ["星号条目也要能解析"] },
    ]);
  });

  it("全是内部条目的小节不出现", () => {
    const versions = parseChangelogHistory(FIXTURE).map((release) => release.version);
    expect(versions).not.toContain("1.0.0");
  });

  it("没有日期的小节 date 为空串；空输入返回空数组", () => {
    expect(parseChangelogHistory("## [0.1.0]\n\n- 早期条目\n")).toEqual([{ version: "0.1.0", date: "", notes: ["早期条目"] }]);
    expect(parseChangelogHistory("")).toEqual([]);
  });

  it("Unreleased 小节不进历史", () => {
    const versions = parseChangelogHistory(FIXTURE).map((release) => release.version);
    expect(versions).not.toContain(UNRELEASED);
  });
});

describe("parseUnreleased", () => {
  it("返回未落款条目并剔除内部条目", () => {
    expect(parseUnreleased(FIXTURE)).toEqual(["修复：还没发版的修复一条"]);
  });

  it("小节不存在时返回空数组", () => {
    expect(parseUnreleased("## [1.0.0] - 2026-01-01\n\n- 旧条目\n")).toEqual([]);
  });
});

describe("常量合同", () => {
  it("内部前缀与未发版小节名是稳定约定", () => {
    expect(UNRELEASED).toBe("Unreleased");
    expect(INTERNAL_PREFIX).toBe("内部：");
    expect(WIP_PREFIX).toBe("WIP：");
  });
});

describe("findWipLeaks（未开放功能不许出现在对外条目里）", () => {
  const md = `## [Unreleased]

- 新增：学会技能自动配快捷键
- 优化：精神力战法回归被动
- WIP：道士召唤神兽消耗 5 张护身符
- 内部：法师施法模块重构

## [1.6.0] - 2026-10-01

- 修复：道士宝宝读档丢失

## [1.5.0] - 2026-09-25

- 新增：法师初版
`;

  it("只查指定小节的对外条目；WIP/内部条目放行；命中返回 小节+条目+关键词", () => {
    expect(findWipLeaks(md, [UNRELEASED, "1.6.0"], ["精神力战法", "道士", "法师"])).toEqual([
      { section: UNRELEASED, entry: "优化：精神力战法回归被动", keyword: "精神力战法" },
      { section: "1.6.0", entry: "修复：道士宝宝读档丢失", keyword: "道士" },
    ]);
  });

  it("放行词先剔除再匹配：NPC 名「大道士」不算提到道士，同条目另有「道士」照拦", () => {
    const text = `## [Unreleased]

- 新增：圣剑任务经大道士一路打到赤月
- 修复：大道士旁的道士宝宝不再卡住
`;
    expect(findWipLeaks(text, [UNRELEASED], ["道士"], ["大道士"])).toEqual([
      { section: UNRELEASED, entry: "修复：大道士旁的道士宝宝不再卡住", keyword: "道士" },
    ]);
  });

  it("没有关键词（功能已开放）恒无泄漏", () => {
    expect(findWipLeaks(md, [UNRELEASED, "1.6.0"], [])).toEqual([]);
  });
});

describe("留档前缀可配置", () => {
  const md = "## [Unreleased]\n\n- 草稿：x\n- 对外\n\n## [1.0.0] - 2026-10-13\n\n- 草稿：y\n- 内部：z\n- 对外条目\n";
  it("hiddenPrefixes 覆盖默认前缀", () => {
    expect(parseChangelogHistory(md, { hiddenPrefixes: ["草稿："] })[0]?.notes).toEqual(["内部：z", "对外条目"]);
    expect(parseUnreleased(md, { hiddenPrefixes: ["草稿："] })).toEqual(["对外"]);
    expect(findWipLeaks(md, ["1.0.0"], ["草稿"], [], { hiddenPrefixes: [] }).map((l) => l.entry)).toEqual(["草稿：y"]);
  });
});
