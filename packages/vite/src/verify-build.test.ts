/**
 * 构建后门禁单测：mkdtemp 拼一份最小合格产物，再逐条破坏，确认每种翻车都被拦下。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { releaseNotesDigest } from "@nexus-kit/pwa/version-check";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupScriptFileName, computePartitionFingerprints, definePartitions, runtimeCacheNames } from "./runtime-cache.ts";
import { parseHtmlRefs, parsePrecacheUrls, verifyPwaBuild, type VerifyBuildOptions } from "./verify-build.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOTES = ["新增：首个版本"];
const CHANGELOG = `# 更新日志\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-13\n\n- ${NOTES[0]}\n- 内部：脚手架\n`;
const SPECS = [{ id: "data", dirs: ["data/"], maxEntries: 50 }];

interface Fixture {
  files: Record<string, string>;
  opts: VerifyBuildOptions;
}

function fixture(): Fixture {
  const partitions = definePartitions(SPECS);
  const pub = { "public/data/a.json": "{}" };
  const tmpPub = mkdtempSync(join(tmpdir(), "nexus-vb-pub-"));
  dirs.push(tmpPub);
  mkdirSync(join(tmpPub, "data"), { recursive: true });
  writeFileSync(join(tmpPub, "data/a.json"), "{}");
  const names = Object.values(runtimeCacheNames(partitions, computePartitionFingerprints(tmpPub, partitions), "demo"));
  const cleanup = cleanupScriptFileName(names, "demo");
  const digest = releaseNotesDigest(NOTES);
  const files: Record<string, string> = {
    ...pub,
    "package.json": JSON.stringify({ version: "1.0.0" }),
    "CHANGELOG.md": CHANGELOG,
    "dist/index.html":
      '<html><head><link rel="preload" as="image" href="/icons/logo.webp"><script type="module" src="/assets/index-a.js"></script>' +
      '<link rel="stylesheet" href="/assets/index-a.css"></head></html>',
    "dist/manifest.webmanifest": JSON.stringify({ name: "Demo", display: "standalone" }),
    "dist/sw.js":
      `importScripts("/${cleanup}");precacheAndRoute([{url:"index.html",revision:"1"},{url:"assets/index-a.js",revision:null},` +
      `{url:"icons/logo.webp",revision:"2"}]);${names.map((n) => `"${n}"`).join(",")}`,
    "dist/version.json": JSON.stringify({
      version: "1.0.0",
      build: 42,
      buildTime: "x",
      releases: [{ version: "1.0.0", date: "2026-10-13", notes: NOTES }],
    }),
    "dist/assets/index-a.js": `const d="${digest}";const b=42;`,
    "dist/assets/index-a.css": "body{}",
    "dist/icons/logo.webp": "x".repeat(100),
    [`dist/${cleanup}`]: "//",
  };
  return { files, opts: { root: "", appId: "demo", manifestName: "Demo", runtimePartitions: SPECS } };
}

function materialize(fx: Fixture): VerifyBuildOptions {
  const root = mkdtempSync(join(tmpdir(), "nexus-vb-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(fx.files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return { ...fx.opts, root };
}

describe("verifyPwaBuild", () => {
  it("合格产物通过并给出报告", () => {
    const report = verifyPwaBuild({ ...materialize(fixture()), budgets: { preloadImageKB: 10, precacheKB: 100, criticalKB: 100 } });
    expect(report).toMatchObject({ version: "1.0.0", build: 42, precacheEntries: 3 });
    expect(report.criticalKB).toBeGreaterThan(0);
  });

  const breakers: Array<[string, (fx: Fixture) => void, RegExp]> = [
    ["缺 sw.js", (fx) => delete fx.files["dist/sw.js"], /缺失：sw\.js/],
    [
      "display 不是 standalone",
      (fx) => (fx.files["dist/manifest.webmanifest"] = JSON.stringify({ name: "Demo", display: "browser" })),
      /standalone/,
    ],
    [
      "manifest.name 不符",
      (fx) => (fx.files["dist/manifest.webmanifest"] = JSON.stringify({ name: "X", display: "standalone" })),
      /manifest\.name/,
    ],
    ["预缓存清单解析不出", (fx) => (fx.files["dist/sw.js"] = "nothing"), /解析不出/],
    [
      "index.html 未预缓存",
      (fx) => (fx.files["dist/sw.js"] = fx.files["dist/sw.js"]!.replace('{url:"index.html",revision:"1"},', "")),
      /index\.html/,
    ],
    ["version 带预发布后缀", (fx) => (fx.files["package.json"] = JSON.stringify({ version: "1.0.0-beta" })), /纯 X\.Y\.Z/],
    ["version.json 版本不符", (fx) => (fx.files["package.json"] = JSON.stringify({ version: "1.0.1" })), /≠ package\.json/],
    [
      "releases 为空",
      (fx) => (fx.files["dist/version.json"] = JSON.stringify({ version: "1.0.0", build: 42, releases: [] })),
      /releases 为空/,
    ],
    [
      "releases 条目非法",
      (fx) => (fx.files["dist/version.json"] = JSON.stringify({ version: "1.0.0", build: 42, releases: [{ version: "1.0.0" }] })),
      /结构非法/,
    ],
    ["version.json 进了预缓存", (fx) => (fx.files["dist/sw.js"] += '{url:"version.json",revision:"9"}'), /进了 sw\.js 预缓存/],
    ["CHANGELOG 缺落款", (fx) => (fx.files["CHANGELOG.md"] = "## [Unreleased]\n\n- x\n"), /落款小节/],
    ["bundle 缺条目指纹", (fx) => (fx.files["dist/assets/index-a.js"] = "const b=42;"), /条目指纹/],
    [
      "build 不是数字",
      (fx) =>
        (fx.files["dist/version.json"] = JSON.stringify({
          version: "1.0.0",
          build: "42",
          releases: [{ version: "1.0.0", date: "", notes: [] }],
        })),
      /build 不是数字/,
    ],
    [
      "bundle 缺构建号",
      (fx) => (fx.files["dist/assets/index-a.js"] = fx.files["dist/assets/index-a.js"]!.replace("42", "43")),
      /构建号 42/,
    ],
    ["运行时仓名对不上", (fx) => (fx.files["public/data/a.json"] = '{"changed":1}'), /缺运行时缓存仓/],
    [
      "清理脚本未引入",
      (fx) => (fx.files["dist/sw.js"] = fx.files["dist/sw.js"]!.replace(/importScripts\([^)]*\);/, "")),
      /未 importScripts/,
    ],
    [
      "预载图不在预缓存",
      (fx) => (fx.files["dist/sw.js"] = fx.files["dist/sw.js"]!.replace(',{url:"icons/logo.webp",revision:"2"}', "")),
      /不在预缓存清单/,
    ],
    ["预载图不存在", (fx) => delete fx.files["dist/icons/logo.webp"], /不存在的产物/],
  ];
  it.each(breakers)("拦下：%s", (_name, breakIt, err) => {
    const fx = fixture();
    breakIt(fx);
    expect(() => verifyPwaBuild(materialize(fx))).toThrow(err);
  });

  it("清理脚本文件缺失被拦下", () => {
    const fx = fixture();
    const cleanupKey = Object.keys(fx.files).find((k) => k.includes("pwa-runtime-cleanup-"))!;
    delete fx.files[cleanupKey];
    expect(() => verifyPwaBuild(materialize(fx))).toThrow(/缺旧仓清理脚本/);
  });

  it.each([
    [{ preloadImageKB: 0.01 }, /超单图预算/],
    [{ precacheKB: 0.01 }, /预缓存总量/],
    [{ criticalKB: 0.01 }, /首屏关键路径/],
  ])("预算超限被拦下 %#", (budgets, err) => {
    expect(() => verifyPwaBuild({ ...materialize(fixture()), budgets })).toThrow(err);
  });

  it("无运行时分区时跳过分区对账", () => {
    const fx = fixture();
    fx.opts = { ...fx.opts, runtimePartitions: [] };
    expect(() => verifyPwaBuild(materialize(fx))).not.toThrow();
  });
});

describe("解析辅助", () => {
  it("parsePrecacheUrls / parseHtmlRefs", () => {
    expect(parsePrecacheUrls('[{url:"a.js",revision:null},{url:"b.css",revision:"1"}]')).toEqual(["a.js", "b.css"]);
    const refs = parseHtmlRefs(
      '<link rel="preload" as="image" href="/a.webp"><link rel="preload" as="font" href="/f.woff2"><link rel="preload" as="image" href="https://x/b.png">' +
        '<script src="/m.js"></script><link rel="stylesheet" href="/s.css"><link rel="modulepreload" href="/v.js">',
    );
    expect(refs).toEqual({ preloadImages: ["/a.webp"], entryAssets: ["/m.js", "/s.css", "/v.js"] });
  });
});
