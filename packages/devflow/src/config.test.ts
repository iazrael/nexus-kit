import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PRIVATE_REQUIRED, DEFAULT_RELEASE_STEPS, loadNexusConfig, parseNexusConfig } from "./config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DEPLOY = { target: "root@1.2.3.4", remoteRoot: "/var/www/app" };

describe("parseNexusConfig", () => {
  it("缺省值：appRoot=.、CHANGELOG 在应用根、源码目录 src/、文档索引 CLAUDE.md、无部署段", () => {
    const cfg = parseNexusConfig({}, "/repo");
    expect(cfg).toMatchObject({
      appRoot: ".",
      changelog: { path: "CHANGELOG.md", sourceDirs: ["src/"] },
      docs: { root: "docs", archiveDir: "docs/存档", designDir: "docs/设计", index: "CLAUDE.md" },
      deploy: null,
    });
  });

  it("appRoot 子目录时 CHANGELOG 与源码目录随之", () => {
    const cfg = parseNexusConfig({ appRoot: "apps/web" }, "/repo");
    expect(cfg.changelog).toEqual({ path: "apps/web/CHANGELOG.md", sourceDirs: ["apps/web/src/"] });
  });

  it("部署段缺省值与环境变量覆盖", () => {
    const cfg = parseNexusConfig({ deploy: { ...DEPLOY, publicUrl: "https://a.b/" } }, "/repo");
    expect(cfg.deploy).toEqual({
      ...DEPLOY,
      publicUrl: "https://a.b",
      localPort: 8888,
      keep: 5,
      branch: "main",
      privateRequired: DEFAULT_PRIVATE_REQUIRED,
      gzipRequired: [],
      edgeTtlProbes: [],
    });
    const env = { NEXUS_DEPLOY_TARGET: "deploy@5.6.7.8", NEXUS_DEPLOY_ROOT: "/srv/x", NEXUS_DEPLOY_KEEP: "3", NEXUS_DEPLOY_PUBLIC_URL: "" };
    expect(parseNexusConfig({ deploy: DEPLOY }, "/repo", env).deploy).toMatchObject({
      target: "deploy@5.6.7.8",
      remoteRoot: "/srv/x",
      keep: 3,
      publicUrl: "",
    });
  });

  it("工作树段缺省值：主干随部署分支、端口 4173 起步、共享应用根构建计数器、建树装依赖、合入后构建", () => {
    expect(parseNexusConfig({ appRoot: "apps/web", deploy: { ...DEPLOY, branch: "trunk" } }, "/repo").worktree).toEqual({
      dir: null,
      base: "trunk",
      portBase: 4173,
      portStep: 10,
      share: ["apps/web/.build-number"],
      disposable: [],
      postCreate: [["pnpm", "install", "--frozen-lockfile"]],
      postMerge: [["pnpm", "build"]],
    });
    expect(parseNexusConfig({}, "/repo").worktree).toMatchObject({ base: "main", share: [".build-number"] });
  });

  it("工作树段显式值原样采纳，路径尾斜杠规整", () => {
    const wt = parseNexusConfig(
      {
        worktree: {
          dir: "../wt",
          base: "dev",
          portBase: 5000,
          portStep: 2,
          share: ["research/", ".build-number"],
          disposable: ["public/sound"],
          postCreate: [],
          postMerge: [
            ["pnpm", "assets:refresh"],
            ["pnpm", "build"],
          ],
        },
      },
      "/repo",
    ).worktree;
    expect(wt).toEqual({
      dir: "../wt",
      base: "dev",
      portBase: 5000,
      portStep: 2,
      share: ["research", ".build-number"],
      disposable: ["public/sound"],
      postCreate: [],
      postMerge: [
        ["pnpm", "assets:refresh"],
        ["pnpm", "build"],
      ],
    });
  });

  it("发版段缺省值与显式值", () => {
    expect(parseNexusConfig({}, "/repo").release).toEqual({
      steps: DEFAULT_RELEASE_STEPS,
      lockTtlMin: 30,
      holdTtlMin: 120,
      push: true,
      githubRelease: false,
    });
    expect(
      parseNexusConfig({ release: { steps: [["pnpm", "check:release"]], lockTtlMin: 45, push: false, githubRelease: true } }, "/repo")
        .release,
    ).toEqual({ steps: [["pnpm", "check:release"]], lockTtlMin: 45, holdTtlMin: 120, push: false, githubRelease: true });
  });

  it.each([
    [null, /顶层/],
    [{ worktree: 1 }, /worktree 必须是对象/],
    [{ worktree: { share: ["/abs"] } }, /worktree\.share/],
    [{ worktree: { share: ["../up"] } }, /worktree\.share/],
    [{ worktree: { disposable: ["a/../../b"] } }, /worktree\.disposable/],
    [{ worktree: { postMerge: [[]] } }, /worktree\.postMerge/],
    [{ worktree: { postCreate: ["pnpm install"] } }, /worktree\.postCreate/],
    [{ worktree: { portBase: 70000 } }, /portBase/],
    [{ worktree: { base: "-x" } }, /worktree\.base/],
    [{ release: [] }, /release 必须是对象/],
    [{ release: { steps: [] } }, /release\.steps/],
    [{ release: { push: "yes" } }, /release\.push/],
    [{ changelog: [] }, /changelog 必须是对象/],
    [{ docs: 1 }, /docs 必须是对象/],
    [{ appRoot: "" }, /appRoot/],
    [{ changelog: { sourceDirs: [1] } }, /字符串数组/],
    [{ deploy: 1 }, /deploy 必须是对象/],
    [{ deploy: { remoteRoot: "/x" } }, /deploy\.target/],
    [{ deploy: { ...DEPLOY, keep: 0 } }, /keep/],
    [{ deploy: { ...DEPLOY, publicUrl: 1 } }, /publicUrl/],
    [{ deploy: { ...DEPLOY, remoteRoot: "/var/www/a'; rm -rf /" } }, /remoteRoot/],
    [{ deploy: { ...DEPLOY, target: "a b" } }, /target/],
    [{ deploy: { ...DEPLOY, privateRequired: ["/x'y"] } }, /路径/],
  ])("非法配置被拒 %#", (raw, err) => {
    expect(() => parseNexusConfig(raw, "/repo")).toThrow(err);
  });
});

describe("loadNexusConfig", () => {
  it("从子目录向上找到配置；仓库根为配置所在目录", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-cfg-"));
    dirs.push(root);
    writeFileSync(join(root, "nexus.config.json"), JSON.stringify({ appRoot: "app" }));
    mkdirSync(join(root, "app/src"), { recursive: true });
    const cfg = loadNexusConfig(join(root, "app/src"), {});
    expect(cfg.repoRoot).toBe(root);
    expect(cfg.appRoot).toBe("app");
  });

  it("找不到 / 非法 JSON：抛错说明", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-cfg-"));
    dirs.push(root);
    expect(() => loadNexusConfig("/", {})).toThrow(/找不到/);
    writeFileSync(join(root, "nexus.config.json"), "{bad");
    expect(() => loadNexusConfig(root, {})).toThrow(/不是合法 JSON/);
  });
});
