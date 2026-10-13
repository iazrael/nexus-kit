import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertInjectedBuild, readBundleCodes } from "./dist-fingerprint.ts";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("assertInjectedBuild", () => {
  it("压缩产物含构建号字面量（=650;）时通过", () => {
    expect(() => assertInjectedBuild(['var e=650,t="x";'], 650)).not.toThrow();
  });

  it("任一 chunk 命中即可（manualChunks 多分包）", () => {
    expect(() => assertInjectedBuild(["a=1;", "APP_BUILD=650"], 650)).not.toThrow();
  });

  it("嵌在其他数字里（10650/6500/0x650）不算命中——词边界防误配", () => {
    expect(() => assertInjectedBuild(["e=10650,f=6500,g=0x650;"], 650)).toThrow(/650/);
  });

  it("找不到注入字面量：报错点名 __APP_BUILD__ 与排查方向", () => {
    expect(() => assertInjectedBuild(["e=649;"], 650)).toThrow(/__APP_BUILD__/);
    expect(() => assertInjectedBuild([], 650)).toThrow(/重新构建/);
  });

  it("构建号非非负整数（version.json 被手改）：先报非法", () => {
    expect(() => assertInjectedBuild(["e=650;"], Number.NaN)).toThrow(/正整数/);
    expect(() => assertInjectedBuild(["e=650;"], -1)).toThrow(/正整数/);
    // 0 在任何 bundle 里都能误命中，必须拒收
    expect(() => assertInjectedBuild(["a[0]=0;"], 0)).toThrow(/正整数/);
  });
});

describe("readBundleCodes", () => {
  it("读 assets 目录下全部 JS 文本，忽略其他后缀", () => {
    dir = mkdtempSync(join(tmpdir(), "nexus-dist-fp-"));
    const assets = join(dir, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "index-a1b2.js"), "e=650;", "utf8");
    writeFileSync(join(assets, "vendor-pixi-c3d4.js"), "pixi", "utf8");
    writeFileSync(join(assets, "index-e5f6.css"), "body{}", "utf8");
    const codes = readBundleCodes(assets);
    expect(codes).toHaveLength(2);
    expect(codes.some((code) => code.includes("650"))).toBe(true);
  });

  it("目录不存在时返回空表（调用方断言给出「找不到构建号」而非 ENOENT）", () => {
    dir = mkdtempSync(join(tmpdir(), "nexus-dist-fp-"));
    expect(readBundleCodes(join(dir, "nope"))).toEqual([]);
  });
});
