import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kitGitSpec, kitPackageNames, rewriteKitDeps } from "./init-app-lib.ts";

const KIT_NAMES = new Set(["@nexus-kit/pwa", "@nexus-kit/vite"]);

describe("kitPackageNames", () => {
  it("从 packages/ 读出全部 kit 包，含新增的 runtime", () => {
    expect([...kitPackageNames(join(import.meta.dirname, "../packages"))].sort()).toEqual([
      "@nexus-kit/devflow",
      "@nexus-kit/pwa",
      "@nexus-kit/pwa-react",
      "@nexus-kit/runtime",
      "@nexus-kit/vite",
    ]);
  });
});

describe("rewriteKitDeps", () => {
  it("kit 包改写为钉 tag 的 git 子目录依赖，其余原样", () => {
    const out = rewriteKitDeps(
      { name: "x", dependencies: { "@nexus-kit/pwa": "workspace:*", react: "^19" }, devDependencies: { "@nexus-kit/vite": "workspace:*" } },
      "0.1.0",
      KIT_NAMES,
    );
    expect(out.dependencies).toEqual({ "@nexus-kit/pwa": kitGitSpec("@nexus-kit/pwa", "0.1.0"), react: "^19" });
    expect(kitGitSpec("@nexus-kit/vite", "0.1.0")).toBe("git+https://github.com/iazrael/nexus-kit.git#v0.1.0&path:/packages/vite");
    expect(out.devDependencies).toEqual({ "@nexus-kit/vite": kitGitSpec("@nexus-kit/vite", "0.1.0") });
  });

  it("未知 workspace 依赖直接报错，不静默保留", () => {
    expect(() => rewriteKitDeps({ dependencies: { other: "workspace:*" } }, "0.1.0", KIT_NAMES)).toThrow(/未知的 workspace 依赖/);
  });
});
