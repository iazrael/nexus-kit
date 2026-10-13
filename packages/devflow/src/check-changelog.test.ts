import { describe, expect, it } from "vitest";
import { changelogGate } from "./check-changelog.ts";

const DIRS = ["src/", "packages/core/src/"];

describe("changelogGate", () => {
  it("未动源码：放行", () => {
    expect(changelogGate({ staged: ["docs/a.md", "README.md"], changelogDiff: "", sourceDirs: DIRS }).ok).toBe(true);
  });
  it("动了源码且 CHANGELOG 有新增行：放行", () => {
    const diff = "--- a/CHANGELOG.md\n+++ b/CHANGELOG.md\n@@ -3 +3,2 @@\n+- 修复：x\n";
    expect(changelogGate({ staged: ["src/a.ts", "CHANGELOG.md"], changelogDiff: diff, sourceDirs: DIRS }).ok).toBe(true);
  });
  it("动了源码但 CHANGELOG 只有删除或没改：拒绝并说明", () => {
    const r = changelogGate({ staged: ["packages/core/src/x.ts"], changelogDiff: "+++ b/CHANGELOG.md\n-- 旧条目\n", sourceDirs: DIRS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/no-verify/);
  });
});
