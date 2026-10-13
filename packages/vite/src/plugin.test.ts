/**
 * nexusPwa 单测：版本读取与校验、条目指纹、WIP 门禁、define 注入、version.json 写出、
 * 运行时分区与清理脚本接线、VitePWA 红线配置。真实 vite build 集成由模板构建覆盖。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { releaseNotesDigest } from "@nexus-kit/pwa/version-check";
import type { Plugin } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

/** VitePWA 替身：捕获传入选项，断言红线配置 */
const pwaCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("vite-plugin-pwa", () => ({
  VitePWA: (opts: Record<string, unknown>) => {
    pwaCalls.push(opts);
    return [{ name: "vite-plugin-pwa" }];
  },
}));

import { assertNoWipLeaks, currentNotesDigest, nexusPwa, readPkgVersion, type NexusPwaOptions } from "./plugin.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CHANGELOG =
  "## [Unreleased]\n\n- 魔法师职业\n\n## [1.2.0] - 2026-10-13\n\n- 新增：首页\n- 内部：x\n\n## [1.1.0] - 2026-10-01\n\n- 修复：y\n";

function appRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "nexus-plugin-"));
  dirs.push(root);
  const all = { "package.json": JSON.stringify({ version: "1.2.0" }), "CHANGELOG.md": CHANGELOG, ...files };
  for (const [rel, content] of Object.entries(all)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function plugins(over: Partial<NexusPwaOptions> & { root: string }): Plugin[] {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return nexusPwa({ command: "build", appId: "demo", manifest: { name: "Demo" }, ...over }).flat(5) as Plugin[];
}
const byName = (list: Plugin[], name: string): Plugin => {
  const p = list.find((x) => x.name === name);
  if (p === undefined) throw new Error(`缺插件 ${name}`);
  return p;
};
const hookOf = (h: unknown): ((...args: unknown[]) => unknown) =>
  (typeof h === "function" ? h : (h as { handler: (...args: unknown[]) => unknown }).handler) as (...args: unknown[]) => unknown;

describe("readPkgVersion / currentNotesDigest / assertNoWipLeaks", () => {
  it("纯 X.Y.Z 通过；预发布后缀与缺失被拒", () => {
    expect(readPkgVersion(appRoot())).toBe("1.2.0");
    expect(() => readPkgVersion(appRoot({ "package.json": JSON.stringify({ version: "1.2.0-rc.1" }) }))).toThrow(/纯 X\.Y\.Z/);
    expect(() => readPkgVersion(appRoot({ "package.json": "{}" }))).toThrow(/纯 X\.Y\.Z/);
  });

  it("条目指纹 = 当前版本对外条目（剔除内部）的指纹；CHANGELOG 缺失按空条目", () => {
    expect(currentNotesDigest(CHANGELOG, "1.2.0")).toBe(releaseNotesDigest(["新增：首页"]));
    expect(currentNotesDigest(null, "1.2.0")).toBe(releaseNotesDigest([]));
    expect(currentNotesDigest(CHANGELOG, "9.9.9")).toBe(releaseNotesDigest([]));
  });

  it("WIP 门禁：Unreleased/当前版本提到关键词即抛；放行词剔除；CHANGELOG 缺失放行", () => {
    expect(() => assertNoWipLeaks(CHANGELOG, "1.2.0", { keywords: ["魔法师"] })).toThrow(/魔法师/);
    expect(() => assertNoWipLeaks(CHANGELOG, "1.2.0", { keywords: ["魔法"], allow: ["魔法师职业"] })).not.toThrow();
    expect(() => assertNoWipLeaks(null, "1.2.0", { keywords: ["魔法师"] })).not.toThrow();
  });
});

describe("nexusPwa", () => {
  it("build：构建号递增并经 define 注入四个常量", () => {
    const root = appRoot({ ".build-number": "41\n" });
    const list = plugins({ root });
    const cfg = hookOf(byName(list, "nexus-version").config)() as { define: Record<string, string> };
    expect(cfg.define.__APP_VERSION__).toBe('"v1.2.0"');
    expect(cfg.define.__APP_BUILD__).toBe("42");
    expect(cfg.define.__APP_NOTES_DIGEST__).toBe(JSON.stringify(releaseNotesDigest(["新增：首页"])));
    expect(readFileSync(join(root, ".build-number"), "utf8").trim()).toBe("42");
  });

  it("serve：只读不递增；计数器缺失从 0 建档", () => {
    const root = appRoot();
    const list = nexusPwaServe(root);
    const cfg = hookOf(byName(list, "nexus-version").config)() as { define: Record<string, string> };
    expect(cfg.define.__APP_BUILD__).toBe("0");
    expect(readFileSync(join(root, ".build-number"), "utf8").trim()).toBe("0");
  });

  it("closeBundle 按 outDir 写出 version.json（最近 N 版、剔除内部条目）", () => {
    const root = appRoot({ ".build-number": "7\n" });
    const list = plugins({ root, releasesMax: 1 });
    const vp = byName(list, "nexus-version");
    mkdirSync(join(root, "out"));
    hookOf(vp.configResolved)({ root, build: { outDir: "out" } });
    hookOf(vp.closeBundle)();
    const vj = JSON.parse(readFileSync(join(root, "out/version.json"), "utf8"));
    expect(vj).toMatchObject({ version: "1.2.0", build: 8, releases: [{ version: "1.2.0", date: "2026-10-13", notes: ["新增：首页"] }] });
  });

  it("outDir 不存在时不写；serve 不写", () => {
    const root = appRoot();
    const vp = byName(plugins({ root }), "nexus-version");
    hookOf(vp.closeBundle)();
    expect(existsSync(join(root, "dist/version.json"))).toBe(false);
  });

  it("WIP 门禁在 build 时生效", () => {
    expect(() => plugins({ root: appRoot(), wipGuard: { keywords: ["魔法师"] } })).toThrow(/魔法师/);
  });

  it("运行时分区：清理脚本发射、VitePWA 拿到 importScripts 与 CacheFirst 路由、运行时目录不进预缓存", () => {
    const root = appRoot({ "public/data/a.json": "{}" });
    const list = plugins({ root, runtimePartitions: [{ id: "data", dirs: ["data/"], maxEntries: 9 }] });
    const emitted: Array<{ fileName: string; source: string }> = [];
    hookOf(byName(list, "nexus-runtime-cleanup").generateBundle).call({
      emitFile: (f: { fileName: string; source: string }) => emitted.push(f),
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.fileName).toMatch(/^pwa-runtime-cleanup-[0-9a-f]{8}\.js$/);
    expect(emitted[0]!.source).toContain('"demo-runtime-data-');
    const opts = pwaCalls.at(-1) as {
      registerType: string;
      injectRegister: unknown;
      devOptions: { enabled: boolean };
      manifest: Record<string, unknown>;
      workbox: {
        importScripts: string[];
        globIgnores: string[];
        clientsClaim: boolean;
        runtimeCaching: Array<{ handler: string; urlPattern: RegExp; options: { cacheName: string; expiration: { maxEntries: number } } }>;
      };
    };
    expect(opts.registerType).toBe("prompt");
    expect(opts.injectRegister).toBeNull();
    expect(opts.devOptions.enabled).toBe(false);
    expect(opts.manifest).toMatchObject({ name: "Demo", display: "standalone", start_url: "/" });
    expect(opts.workbox.importScripts).toEqual([`/${emitted[0]!.fileName}`]);
    expect(opts.workbox.globIgnores).toEqual(expect.arrayContaining(["version.json", "pwa-runtime-cleanup-*.js", "**/data/**"]));
    expect(opts.workbox.clientsClaim).toBe(true);
    const route = opts.workbox.runtimeCaching[0]!;
    expect(route.handler).toBe("CacheFirst");
    expect(route.options.cacheName).toMatch(/^demo-runtime-data-[0-9a-f]{12}$/);
    expect(route.options.expiration.maxEntries).toBe(9);
    expect(route.urlPattern.test("https://h/data/a.json")).toBe(true);
  });

  it("无运行时分区：不发射清理脚本", () => {
    const list = plugins({ root: appRoot() });
    const emitted: unknown[] = [];
    hookOf(byName(list, "nexus-runtime-cleanup").generateBundle).call({ emitFile: (f: unknown) => emitted.push(f) });
    expect(emitted).toEqual([]);
  });

  it("serve 下运行时仓名用 dev 占位（不扫 public）", () => {
    const root = appRoot();
    expect(() =>
      nexusPwa({
        command: "serve",
        appId: "demo",
        root,
        manifest: { name: "Demo" },
        runtimePartitions: [{ id: "data", dirs: ["data/"], maxEntries: 9 }],
      }),
    ).not.toThrow();
  });

  it("build 下分区为空（资源没生成）直接失败", () => {
    expect(() => plugins({ root: appRoot(), runtimePartitions: [{ id: "data", dirs: ["data/"], maxEntries: 9 }] })).toThrow(/没有文件/);
  });
});

function nexusPwaServe(root: string): Plugin[] {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return nexusPwa({ command: "serve", appId: "demo", root, manifest: { name: "Demo" } }).flat(5) as Plugin[];
}
