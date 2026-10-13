/**
 * nexusPwa：宿主 vite.config 的唯一 PWA 入口（机制见 docs/架构算法/离线与升级.md）。
 *
 * 一次调用装齐：
 * - **构建指纹注入**（define）：__APP_VERSION__（package.json，带 v 前缀）、__APP_BUILD__
 *   （构建计数器，build 每次 +1、dev 只读）、__BUILD_TIME__、__APP_NOTES_DIGEST__（本版
 *   对外条目指纹，同版本重发判「修复 / 内容有更新」用）。
 * - **version.json**：closeBundle 写进 dist，携带最近 releasesMax 个已发版本条目。
 * - **VitePWA（generateSW）**：红线写死——prompt 制、不注入注册脚本（宿主经控制器注册）、
 *   dev 关闭、version.json 与清理脚本不进预缓存、运行时目录不进预缓存。
 * - **运行时缓存分区**：仓名挂分区内容指纹，旧仓清理脚本随构建生成并经 importScripts 引入。
 * - **未开放功能泄漏门禁**（可选）：对外条目提到登记的关键词即构建失败。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseNotesDigest } from "@nexus-kit/pwa/version-check";
import type { Plugin, PluginOption } from "vite";
import { VitePWA, type ManifestOptions, type VitePWAOptions } from "vite-plugin-pwa";
import { bumpBuildCounter, ensureBuildCounter, readBuildCounter } from "./build-counter.ts";
import { findWipLeaks, parseChangelogHistory, UNRELEASED, type ChangelogOptions } from "./changelog.ts";
import {
  cleanupScriptFileName,
  cleanupScriptSource,
  computePartitionFingerprints,
  definePartitions,
  runtimeCacheNames,
  runtimeCachePrefix,
  type RuntimePartitionSpec,
} from "./runtime-cache.ts";

const THIRTY_DAYS = 30 * 24 * 60 * 60;
const PURE_SEMVER = /^\d+\.\d+\.\d+$/;

/** 壳预缓存默认收录：构建产物 + 图标。字体等按项目经 precache.globPatterns 追加——默认值不放
 *  可能不存在的目录：glob 不匹配只报 warning，噪音警告会让真正的漏配（换后缀忘改）被忽略 */
export const DEFAULT_GLOB_PATTERNS: readonly string[] = ["**/*.{js,css,html}", "icons/*.{png,webp,svg}"];

export interface NexusPwaOptions {
  /** vite 命令（defineConfig(({ command }) => …) 传入）：build 才递增构建号、实测分区指纹 */
  command: "build" | "serve";
  /** 应用 id：运行时缓存仓名前缀（小写字母、数字、连字符） */
  appId: string;
  /** 应用根（package.json、CHANGELOG.md、public/ 所在目录），通常传 import.meta.dirname */
  root: string;
  /** Web App Manifest；display/start_url/lang 有默认值 */
  manifest: Partial<ManifestOptions> & { name: string };
  /** CHANGELOG 路径（相对 root），默认 CHANGELOG.md */
  changelog?: string;
  /** version.json 携带的已发版本数，默认 30 */
  releasesMax?: number;
  changelogOptions?: ChangelogOptions;
  /** 运行时缓存分区（按需资源）；为空则不生成运行时路由与清理脚本 */
  runtimePartitions?: readonly RuntimePartitionSpec[];
  /** 预缓存补充收录/排除（追加在默认值后）与根目录零散小件 */
  precache?: {
    globPatterns?: readonly string[];
    globIgnores?: readonly string[];
    includeAssets?: readonly string[];
    /** globIgnores 优先于 globPatterns：被忽略目录里的单条例外只能走这里（url + 内容哈希 revision） */
    additionalManifestEntries?: ReadonlyArray<{ url: string; revision: string }>;
  };
  /** 未开放功能泄漏门禁：Unreleased 与当前版本的对外条目提到关键词即构建失败 */
  wipGuard?: { keywords: readonly string[]; allow?: readonly string[] };
  /** 构建计数器路径，默认 <root>/.build-number */
  buildCounterPath?: string;
}

/** 读 package.json 产品版本（纯 X.Y.Z，构建脚本不替用户决定版本） */
export function readPkgVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !PURE_SEMVER.test(pkg.version)) {
    throw new Error(`[nexus-pwa] package.json 的 version 必须是纯 X.Y.Z（不带预发布后缀）：${JSON.stringify(pkg.version)}`);
  }
  return pkg.version;
}

function readChangelog(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** 本版对外条目指纹：与 version.json 同一解析口径、与运行时同一指纹函数 */
export function currentNotesDigest(changelog: string | null, version: string, opts: ChangelogOptions = {}): string {
  const notes = changelog === null ? [] : (parseChangelogHistory(changelog, opts).find((r) => r.version === version)?.notes ?? []);
  return releaseNotesDigest(notes);
}

export function assertNoWipLeaks(
  changelog: string | null,
  version: string,
  guard: NonNullable<NexusPwaOptions["wipGuard"]>,
  opts: ChangelogOptions = {},
): void {
  if (changelog === null) return;
  const leaks = findWipLeaks(changelog, [UNRELEASED, version], guard.keywords, guard.allow ?? [], opts);
  if (leaks.length === 0) return;
  throw new Error(
    "[changelog] 对外条目提到了未开放功能（改记「WIP：」前缀；误拦的无关专有名词加进放行词；功能已开放则移出关键词）：\n" +
      leaks.map((l) => `  [${l.section}] 「${l.keyword}」 ${l.entry}`).join("\n"),
  );
}

export function nexusPwa(options: NexusPwaOptions): PluginOption[] {
  const { command, appId, root } = options;
  const changelogPath = resolve(root, options.changelog ?? "CHANGELOG.md");
  const releasesMax = options.releasesMax ?? 30;
  const clOpts = options.changelogOptions ?? {};
  const counterPath = options.buildCounterPath ?? join(root, ".build-number");

  const version = readPkgVersion(root);
  ensureBuildCounter(counterPath);
  const build = command === "build" ? bumpBuildCounter(counterPath) : readBuildCounter(counterPath);
  const changelog = readChangelog(changelogPath);
  if (command === "build" && options.wipGuard) assertNoWipLeaks(changelog, version, options.wipGuard, clOpts);
  const buildTime = new Date().toISOString();
  console.log(`[version] v${version} build ${build}${command === "build" ? "（已递增）" : "（dev 只读）"}`);

  // 运行时分区：build 实测指纹；dev 不出 SW，给占位名免得每次起 dev 都扫一遍 public
  const partitions = definePartitions(options.runtimePartitions ?? []);
  const names =
    partitions.length === 0
      ? {}
      : command === "build"
        ? runtimeCacheNames(partitions, computePartitionFingerprints(join(root, "public"), partitions), appId)
        : Object.fromEntries(partitions.map((p) => [p.id, `${runtimeCachePrefix(appId)}${p.id}-dev`]));
  const nameList = Object.values(names);
  const cleanupFile = nameList.length > 0 ? cleanupScriptFileName(nameList, appId) : null;

  let outDir = resolve(root, "dist");

  const versionPlugin: Plugin = {
    name: "nexus-version",
    config: () => ({
      define: {
        __APP_VERSION__: JSON.stringify(`v${version}`),
        __APP_BUILD__: JSON.stringify(build),
        __BUILD_TIME__: JSON.stringify(buildTime),
        __APP_NOTES_DIGEST__: JSON.stringify(currentNotesDigest(changelog, version, clOpts)),
      },
    }),
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      handler() {
        if (command !== "build" || !existsSync(outDir)) return;
        // CHANGELOG 缺失/不可读：空表放行，verify-build 拦空表上线
        const releases = changelog === null ? [] : parseChangelogHistory(changelog, clOpts).slice(0, releasesMax);
        writeFileSync(join(outDir, "version.json"), JSON.stringify({ version, build, buildTime, releases }), "utf-8");
      },
    },
  };

  const cleanupPlugin: Plugin = {
    name: "nexus-runtime-cleanup",
    apply: "build",
    generateBundle() {
      if (cleanupFile !== null) this.emitFile({ type: "asset", fileName: cleanupFile, source: cleanupScriptSource(nameList, appId) });
    },
  };

  const runtimeIgnores = partitions.flatMap((p) => p.dirs.map((d) => `**/${d}**`));
  const workbox: VitePWAOptions["workbox"] = {
    cleanupOutdatedCaches: true,
    // 激活即接管同源页面（离线首用）：版本更新仍是 prompt 制，用户确认后才 skipWaiting
    clientsClaim: true,
    globPatterns: [...DEFAULT_GLOB_PATTERNS, ...(options.precache?.globPatterns ?? [])],
    // version.json 进了预缓存会被钉死在安装时的旧内容，升级探测永远失明（verify-build 断言）
    globIgnores: ["version.json", "pwa-runtime-cleanup-*.js", ...runtimeIgnores, ...(options.precache?.globIgnores ?? [])],
    additionalManifestEntries: [...(options.precache?.additionalManifestEntries ?? [])],
    ...(cleanupFile !== null ? { importScripts: [`/${cleanupFile}`] } : {}),
    runtimeCaching: partitions.map((p) => ({
      urlPattern: p.pattern,
      handler: "CacheFirst" as const,
      options: {
        cacheName: names[p.id]!,
        expiration: { maxEntries: p.maxEntries, maxAgeSeconds: THIRTY_DAYS, purgeOnQuotaError: true },
        cacheableResponse: { statuses: [200] },
      },
    })),
  };

  return [
    versionPlugin,
    VitePWA({
      registerType: "prompt",
      injectRegister: null,
      includeAssets: [...(options.precache?.includeAssets ?? [])],
      manifest: { display: "standalone", start_url: "/", lang: "zh-CN", ...options.manifest },
      workbox,
      devOptions: { enabled: false },
    }),
    cleanupPlugin,
  ];
}
