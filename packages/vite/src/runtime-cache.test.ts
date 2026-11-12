/**
 * 运行时缓存分区单测（纯逻辑，mkdtemp 假树）。夹具用旧项目A的七分区声明——它是本机制
 * 的出处，能用声明式写出来即证明通用化没有丢能力。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupScriptFileName,
  cleanupScriptSource,
  computePartitionFingerprints,
  definePartitions,
  partitionOf,
  runtimeCacheNames,
  type RuntimePartitionSpec,
} from "./runtime-cache.ts";

const TERRAIN = ["atlas/map-official/", "atlas/minimap-maps/"];
const ENTITY = ["atlas/bundle/", "atlas/monster/", "atlas/npc/"];
const SPECS: RuntimePartitionSpec[] = [
  { id: "atlas-terrain", dirs: TERRAIN, maxEntries: 400 },
  { id: "atlas-entity", dirs: ENTITY, maxEntries: 400 },
  { id: "atlas", dirs: ["atlas/"], exclude: [...TERRAIN, ...ENTITY], maxEntries: 600 },
  { id: "data-map", dirs: ["data/maps-official/"], maxEntries: 300 },
  { id: "data", dirs: ["data/"], exclude: ["data/maps-official/"], maxEntries: 400 },
  { id: "sound", dirs: ["sound/"], maxEntries: 800 },
  { id: "splash", dirs: ["splash/"], maxEntries: 8 },
];
const PARTITIONS = definePartitions(SPECS);
const APP = "demo";

const dirs: string[] = [];
function makePublicTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nexus-rc-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE_TREE: Record<string, string> = {
  "atlas/map-official/0/sheet-0.webp": "terrain",
  "atlas/minimap-maps/0.webp": "mini",
  "atlas/bundle/0/sheet-0.webp": "bundle",
  "atlas/monster/m-1-0.webp": "mon",
  "atlas/npc/n-1-0.webp": "npc",
  "atlas/hero/h-0.webp": "hero",
  "data/maps-official/0.mbin": "mbin",
  "data/drops/0.json": "{}",
  "data/shops.json": "[]",
  "sound/100.m4a": "door",
  "splash/a.png": "splash",
};

describe("definePartitions：声明校验", () => {
  it.each([
    [[{ id: "Bad", dirs: ["a/"], maxEntries: 1 }], /id 非法/],
    [
      [
        { id: "a", dirs: ["a/"], maxEntries: 1 },
        { id: "a", dirs: ["b/"], maxEntries: 1 },
      ],
      /id 重复/,
    ],
    [[{ id: "a", dirs: [], maxEntries: 1 }], /没有目录/],
    [[{ id: "a", dirs: ["/a/"], maxEntries: 1 }], /以 \/ 结尾/],
    [[{ id: "a", dirs: ["a"], maxEntries: 1 }], /以 \/ 结尾/],
    [[{ id: "a", dirs: ["a/"], maxEntries: 0 }], /正整数/],
    [
      [
        { id: "a", dirs: ["data/"], maxEntries: 1 },
        { id: "b", dirs: ["data/maps/"], maxEntries: 1 },
      ],
      /相交/,
    ],
    [
      [
        { id: "a", dirs: ["data/maps/"], maxEntries: 1 },
        { id: "b", dirs: ["data/"], maxEntries: 1 },
      ],
      /相交/,
    ],
  ] as Array<[RuntimePartitionSpec[], RegExp]>)("非法声明被拒 %#", (specs, err) => {
    expect(() => definePartitions(specs)).toThrow(err);
  });

  it("用 exclude 让出子目录即合法", () => {
    expect(() =>
      definePartitions([
        { id: "a", dirs: ["data/"], exclude: ["data/maps/"], maxEntries: 1 },
        { id: "b", dirs: ["data/maps/"], maxEntries: 1 },
      ]),
    ).not.toThrow();
  });
});

describe("partitionOf：每个运行时资源路径恰好归一个分区", () => {
  it.each([
    ["/atlas/map-official/0140/sheet-0.webp", "atlas-terrain"],
    ["/atlas/minimap-maps/0.webp", "atlas-terrain"],
    ["/atlas/bundle/0/manifest.json", "atlas-entity"],
    ["/atlas/npc/npc-manifest.json", "atlas-entity"],
    ["/atlas/hero/hero-0-0.webp", "atlas"],
    ["/atlas/minimap/minimap-0.webp", "atlas"], // minimap ≠ minimap-maps：前缀不得误吞
    ["/data/maps-official/0.mbin", "data-map"],
    ["/data/drops/0.json", "data"],
    ["/sound/100.m4a", "sound"],
    ["/splash/apple-splash-1170-2532.png", "splash"],
  ])("%s → %s", (path, id) => {
    expect(partitionOf(PARTITIONS, path)).toBe(id);
    const hits = PARTITIONS.filter((p) => p.pattern.test(`https://app.example${path}`));
    expect(hits.map((p) => p.id)).toEqual([id]);
  });

  it("壳资源与非运行时路径不归任何分区；查询串里出现前缀不算", () => {
    for (const path of ["/index.html", "/assets/index-abc.js", "/version.json", "/atlasx/a.webp"]) {
      expect(partitionOf(PARTITIONS, path)).toBeNull();
    }
    expect(PARTITIONS.some((p) => p.pattern.test("https://app.example/index.html?x=/atlas/hero/a"))).toBe(false);
  });

  it("前缀里的正则元字符按字面匹配", () => {
    const [p] = definePartitions([{ id: "x", dirs: ["a.b/"], maxEntries: 1 }]);
    expect(p!.pattern.test("https://h/a.b/x")).toBe(true);
    expect(p!.pattern.test("https://h/aXb/x")).toBe(false);
  });
});

describe("computePartitionFingerprints：按分区独立指纹", () => {
  it("同一棵树两次计算一致；每个分区都有文件即都有指纹", () => {
    const root = makePublicTree(BASE_TREE);
    const a = computePartitionFingerprints(root, PARTITIONS);
    expect(computePartitionFingerprints(root, PARTITIONS)).toEqual(a);
    for (const p of PARTITIONS) expect(a[p.id]).toMatch(/^[0-9a-f]{12}$/);
  });

  it("改一个数据文件只换所在分区的指纹", () => {
    const before = computePartitionFingerprints(makePublicTree(BASE_TREE), PARTITIONS);
    const after = computePartitionFingerprints(makePublicTree({ ...BASE_TREE, "data/shops.json": "[1]" }), PARTITIONS);
    expect(PARTITIONS.map((p) => p.id).filter((id) => before[id] !== after[id])).toEqual(["data"]);
  });

  it("同内容换路径也算变化；点文件不参与", () => {
    const base = computePartitionFingerprints(makePublicTree(BASE_TREE), PARTITIONS);
    const { "atlas/hero/h-0.webp": hero, ...rest } = BASE_TREE;
    const moved = computePartitionFingerprints(makePublicTree({ ...rest, "atlas/hero/h-1.webp": hero! }), PARTITIONS);
    expect(moved.atlas).not.toBe(base.atlas);
    const withDot = computePartitionFingerprints(makePublicTree({ ...BASE_TREE, "atlas/hero/.DS_Store": "junk" }), PARTITIONS);
    expect(withDot).toEqual(base);
  });

  it("分区为空记 null；顶层目录不存在不报错", () => {
    const { "splash/a.png": _s, ...noSplash } = BASE_TREE;
    expect(computePartitionFingerprints(makePublicTree(noSplash), PARTITIONS).splash).toBeNull();
  });
});

describe("runtimeCacheNames / 清理脚本", () => {
  const fps = computePartitionFingerprints(makePublicTree(BASE_TREE), PARTITIONS);

  it("仓名 = <appId>-runtime-<分区>-<指纹>", () => {
    const names = runtimeCacheNames(PARTITIONS, fps, APP);
    expect(names["atlas-terrain"]).toBe(`demo-runtime-atlas-terrain-${fps["atlas-terrain"]}`);
    expect(Object.keys(names).sort()).toEqual(PARTITIONS.map((p) => p.id).sort());
  });

  it("空分区拒绝出名", () => {
    expect(() => runtimeCacheNames(PARTITIONS, { ...fps, splash: null }, APP)).toThrow(/splash/);
  });

  async function runCleanup(source: string, existing: string[]): Promise<string[]> {
    const deleted: string[] = [];
    let activate: ((ev: { waitUntil: (p: Promise<unknown>) => void }) => void) | undefined;
    let pending: Promise<unknown> = Promise.resolve();
    const self = {
      addEventListener: (type: string, fn: typeof activate) => {
        if (type === "activate") activate = fn;
      },
      caches: { keys: async () => existing, delete: async (name: string) => (deleted.push(name), true) },
    };
    runInNewContext(source, { self, console: { log: () => {}, warn: () => {} } });
    activate!({ waitUntil: (p) => (pending = p) });
    await pending;
    return deleted.sort();
  }

  it("激活时删掉本应用不在名单的运行时仓，留下当前仓、预缓存仓与别的应用的仓", async () => {
    const current = Object.values(runtimeCacheNames(PARTITIONS, fps, APP));
    const deleted = await runCleanup(cleanupScriptSource(current, APP), [
      ...current,
      "demo-runtime-atlas-terrain-000000000000",
      "demo-runtime-data-v35",
      "other-runtime-data-111111111111",
      "workbox-precache-v2-https://app.example/",
    ]);
    expect(deleted).toEqual(["demo-runtime-atlas-terrain-000000000000", "demo-runtime-data-v35"]);
  });

  it("清理失败只告警不抛（不阻断激活）", async () => {
    let activate: ((ev: { waitUntil: (p: Promise<unknown>) => void }) => void) | undefined;
    let pending: Promise<unknown> = Promise.resolve();
    const warned: unknown[] = [];
    const self = {
      addEventListener: (_t: string, fn: typeof activate) => (activate = fn),
      caches: { keys: async () => Promise.reject(new Error("x")), delete: async () => true },
    };
    runInNewContext(cleanupScriptSource([], APP), { self, console: { log: () => {}, warn: (...a: unknown[]) => warned.push(a) } });
    activate!({ waitUntil: (p) => (pending = p) });
    await pending;
    expect(warned).toHaveLength(1);
  });

  it("清理脚本文件名随名单变", () => {
    const a = Object.values(runtimeCacheNames(PARTITIONS, fps, APP));
    const b = [...a.slice(1), "demo-runtime-data-ffffffffffff"];
    expect(cleanupScriptFileName(a, APP)).toMatch(/^pwa-runtime-cleanup-[0-9a-f]{8}\.js$/);
    expect(cleanupScriptFileName(a, APP)).toBe(cleanupScriptFileName([...a], APP));
    expect(cleanupScriptFileName(a, APP)).not.toBe(cleanupScriptFileName(b, APP));
  });
});
