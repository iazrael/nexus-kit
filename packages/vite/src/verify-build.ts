/**
 * 构建后门禁（宿主 build 脚本 `vite build && node scripts/verify-build.ts` 调用）：PWA 壳
 * 完整性 + 升级链合同 + 可选字节预算。全部对着 dist 真实产物算，任何一条不过即抛错。
 *
 * 断言清单（每条对应一种「构建照绿、线上翻车」）：
 * - 壳文件齐全、manifest display=standalone、sw.js 预缓存了 index.html；
 * - version.json：版本与 package.json 一致、纯 X.Y.Z、releases 非空且结构合法、CHANGELOG
 *   有当前版本落款、**不在预缓存清单里**（进了就被钉死在旧内容，升级探测失明）；
 * - bundle 里有本版条目指纹与构建号字面量（同一次构建写出的两处互证，dist 不是半新半旧）；
 * - 运行时分区：sw.js 含每个分区的仓名（按 public 实测重算）、清理脚本在 dist 根且被引入；
 * - index.html 的 preload 图都在预缓存里（换后缀忘改 globPatterns 时 glob 只报 warning）；
 * - 预算（可选）：单张预载图、预缓存总量、首屏关键路径（brotli 后字节）。
 *
 * 预算不是性能目标，是**回归闸**：超了先解释清楚再调数，调数和交付说明一起走。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { releaseNotesDigest } from "@nexus-kit/pwa/version-check";
import { assertInjectedBuild, readBundleCodes } from "./dist-fingerprint.ts";
import { parseChangelogHistory, type ChangelogOptions } from "./changelog.ts";
import {
  cleanupScriptFileName,
  computePartitionFingerprints,
  definePartitions,
  runtimeCacheNames,
  type RuntimePartitionSpec,
} from "./runtime-cache.ts";

export interface BuildBudgets {
  /** 单张首屏预载图上限（KB） */
  preloadImageKB?: number;
  /** 预缓存总量上限（KB） */
  precacheKB?: number;
  /** 首屏关键路径合计上限（brotli 压缩后 KB）：index.html + 预载图 + 入口 JS/CSS/modulepreload + extraCriticalUrls */
  criticalKB?: number;
  /** 计入首屏关键路径的额外站内地址（如首屏必取的数据 JSON） */
  extraCriticalUrls?: readonly string[];
}

export interface VerifyBuildOptions {
  /** 应用根（package.json、CHANGELOG.md、public/、dist/ 所在） */
  root: string;
  /** 与 nexusPwa 同值 */
  appId: string;
  /** dist 目录（相对 root），默认 dist */
  distDir?: string;
  /** manifest.name 期望值（不传不校验） */
  manifestName?: string;
  changelog?: string;
  changelogOptions?: ChangelogOptions;
  /** 与 nexusPwa 同一份声明 */
  runtimePartitions?: readonly RuntimePartitionSpec[];
  budgets?: BuildBudgets;
}

export interface VerifyReport {
  version: string;
  build: number;
  precacheEntries: number;
  precacheKB: number;
  criticalKB: number | null;
}

const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;

function fail(message: string): never {
  throw new Error(`[verify-build] ${message}`);
}

/** sw.js 里 workbox precacheAndRoute 的条目 url */
export function parsePrecacheUrls(sw: string): string[] {
  return [...sw.matchAll(/\{url:"([^"]+)",revision:/g)].map((m) => m[1]!);
}

/** index.html 里的站内预载图与入口 JS/CSS（含 modulepreload） */
export function parseHtmlRefs(html: string): { preloadImages: string[]; entryAssets: string[] } {
  const preloadImages = [...html.matchAll(/<link[^>]+rel="preload"[^>]*>/g)]
    .filter((m) => /as="image"/.test(m[0]))
    .map((m) => /href="([^"]+)"/.exec(m[0])?.[1])
    .filter((href): href is string => typeof href === "string" && href.startsWith("/"));
  const entryAssets = [
    ...[...html.matchAll(/<script[^>]+src="(\/[^"]+)"/g)].map((m) => m[1]!),
    ...[...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="(\/[^"]+)"/g)].map((m) => m[1]!),
    ...[...html.matchAll(/<link[^>]+rel="modulepreload"[^>]*href="(\/[^"]+)"/g)].map((m) => m[1]!),
  ];
  return { preloadImages, entryAssets };
}

export function verifyPwaBuild(opts: VerifyBuildOptions): VerifyReport {
  const root = opts.root;
  const dist = resolve(root, opts.distDir ?? "dist");
  const distPath = (url: string): string => join(dist, url.replace(/^\//, "").split("?")[0]!);

  for (const f of ["index.html", "manifest.webmanifest", "sw.js", "version.json"]) {
    if (!existsSync(join(dist, f))) fail(`构建产物缺失：${f}`);
  }

  const manifest = JSON.parse(readFileSync(join(dist, "manifest.webmanifest"), "utf8")) as { name?: unknown; display?: unknown };
  if (manifest.display !== "standalone") fail(`manifest.display 应为 standalone，实际 ${String(manifest.display)}`);
  if (opts.manifestName !== undefined && manifest.name !== opts.manifestName) {
    fail(`manifest.name 应为 ${opts.manifestName}，实际 ${String(manifest.name)}`);
  }

  const sw = readFileSync(join(dist, "sw.js"), "utf8");
  const precacheUrls = parsePrecacheUrls(sw);
  if (precacheUrls.length === 0) fail("解析不出 sw.js 的预缓存清单（workbox 产物格式变了？）");
  if (!precacheUrls.includes("index.html")) fail("sw.js 未预缓存 index.html");

  // ── version.json 合同 ──
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    fail(`package.json 的 version 必须是纯 X.Y.Z：${String(pkg.version)}`);
  }
  const version = pkg.version;
  const vj = JSON.parse(readFileSync(join(dist, "version.json"), "utf8")) as {
    version?: unknown;
    build?: unknown;
    releases?: unknown;
  };
  if (vj.version !== version) fail(`version.json 版本 ${String(vj.version)} ≠ package.json ${version}`);
  if (!Array.isArray(vj.releases) || vj.releases.length === 0) fail("version.json releases 为空——CHANGELOG 没有可解析的已发版小节");
  for (const r of vj.releases as unknown[]) {
    const rel = r as { version?: unknown; date?: unknown; notes?: unknown };
    if (
      typeof rel?.version !== "string" ||
      typeof rel?.date !== "string" ||
      !Array.isArray(rel?.notes) ||
      rel.notes.some((n) => typeof n !== "string")
    ) {
      fail("version.json releases 条目结构非法（应为 {version, date, notes[]}）");
    }
  }
  if (precacheUrls.includes("version.json")) fail("version.json 进了 sw.js 预缓存清单——升级探测会被钉死在旧内容");

  const changelog = readFileSync(resolve(root, opts.changelog ?? "CHANGELOG.md"), "utf8");
  const escaped = version.replace(/\./g, "\\.");
  if (!new RegExp(`^##\\s+\\[${escaped}\\]`, "m").test(changelog))
    fail(`CHANGELOG 没有 [${version}] 落款小节——发版前先整合 Unreleased 落款`);

  const notes = parseChangelogHistory(changelog, opts.changelogOptions ?? {}).find((r) => r.version === version)?.notes ?? [];
  const digest = releaseNotesDigest(notes);
  const bundle = readBundleCodes(join(dist, "assets"));
  if (!bundle.some((code) => code.includes(`"${digest}"`))) {
    fail(`产物里找不到本版条目指纹 ${digest}——宿主代码未引用 __APP_NOTES_DIGEST__，或注入口径跑偏`);
  }
  if (typeof vj.build !== "number") fail("version.json 的 build 不是数字");
  assertInjectedBuild(bundle, vj.build);

  // ── 运行时分区 ──
  const partitions = definePartitions(opts.runtimePartitions ?? []);
  if (partitions.length > 0) {
    const names = Object.values(runtimeCacheNames(partitions, computePartitionFingerprints(join(root, "public"), partitions), opts.appId));
    for (const name of names) {
      if (!sw.includes(`"${name}"`)) fail(`sw.js 缺运行时缓存仓 ${name}——构建期间 public 被改过？重新构建`);
    }
    const cleanup = cleanupScriptFileName(names, opts.appId);
    if (!existsSync(join(dist, cleanup))) fail(`dist 缺旧仓清理脚本 ${cleanup}`);
    if (!sw.includes(`importScripts("/${cleanup}")`)) fail(`sw.js 未 importScripts 本版清理脚本 ${cleanup}`);
  }

  // ── 预载图与预算 ──
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const { preloadImages, entryAssets } = parseHtmlRefs(html);
  const sizeOf = (url: string): number => {
    const abs = distPath(url);
    if (!existsSync(abs)) fail(`index.html 引用了 dist 里不存在的产物：${url}`);
    return statSync(abs).size;
  };
  const budgets = opts.budgets ?? {};
  for (const url of preloadImages) {
    const bytes = sizeOf(url);
    if (budgets.preloadImageKB !== undefined && bytes > budgets.preloadImageKB * 1024) {
      fail(`首屏预载图 ${url} = ${kb(bytes)}KB，超单图预算 ${budgets.preloadImageKB}KB`);
    }
    if (!precacheUrls.includes(url.replace(/^\//, ""))) fail(`首屏预载图 ${url} 不在预缓存清单里——检查 globPatterns 是否覆盖它的后缀`);
  }

  const uniquePrecache = [...new Set(precacheUrls)];
  const precacheBytes = uniquePrecache.filter((u) => existsSync(join(dist, u))).reduce((sum, u) => sum + statSync(join(dist, u)).size, 0);
  if (budgets.precacheKB !== undefined && precacheBytes > budgets.precacheKB * 1024) {
    fail(`预缓存总量 ${kb(precacheBytes)}KB 超预算 ${budgets.precacheKB}KB（${uniquePrecache.length} 条）`);
  }

  let criticalKB: number | null = null;
  if (budgets.criticalKB !== undefined) {
    const wire = (url: string): number => {
      sizeOf(url);
      return brotliCompressSync(readFileSync(distPath(url)), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length;
    };
    const urls = ["/index.html", ...preloadImages, ...entryAssets, ...(budgets.extraCriticalUrls ?? [])];
    const bytes = urls.reduce((sum, u) => sum + wire(u), 0);
    criticalKB = kb(bytes);
    if (bytes > budgets.criticalKB * 1024) fail(`首屏关键路径（压缩后）${criticalKB}KB 超预算 ${budgets.criticalKB}KB`);
  }

  return { version, build: vj.build, precacheEntries: uniquePrecache.length, precacheKB: kb(precacheBytes), criticalKB };
}
