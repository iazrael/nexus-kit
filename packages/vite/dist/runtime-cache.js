/**
 * PWA 运行时缓存分区（机制见 docs/架构算法/离线与升级.md §3）：按需下载的资源（文件名
 * 不带哈希）走 workbox CacheFirst，缓存仓名就是「这批内容是哪一代」的唯一标记。
 *
 * 仓名 = `<appId>-runtime-<分区>-<分区内容指纹>`，构建时从 public 实测推出：
 * - 内容不变名字不变 → 发版不洗掉用户已缓存的资源；
 * - 内容一变名字必变 → 新仓从零积累，不可能被同名旧仓钉死旧内容（不存在「漏 bump」）。
 *
 * 分区按**变化频率**切，不按目录一刀切：常改的小东西不连坐体积大、几乎不变的资源。
 * 分区由宿主声明（目录前缀 + 排除前缀 + 淘汰上限），同一份声明既生成 sw.js 路由，也决定
 * 文件归哪个分区算指纹——两边不可能分歧。声明在使用前校验两两不相交。
 *
 * 本文件被 vite 插件（构建期）与 verify-build（构建后对账）共用——分区归属、指纹、仓名与
 * 清理脚本各只有这一份实现。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
/**
 * URL 开头到路径首段（host 可带端口）；只认路径开头，查询串里的同名片段不算。
 * 【假设】资源只走同源部署：workbox RegExpRoute 对跨源请求只要求从串首匹配，任意 host 的
 * 同形路径也会命中这些 CacheFirst 路由。引入跨域资源来源前必须先补 origin 约束。
 */
const ORIGIN = String.raw `^https?://[^/?#]+/`;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const DIR_RE = /^[^/].*\/$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** path 是否落在「prefix 覆盖且未被 exclude 排除」的范围里 */
function covered(prefix, exclude, path) {
    return path.startsWith(prefix) && !exclude.some((ex) => path.startsWith(ex));
}
/** 两个分区相交：任一方的某个前缀落在另一方的覆盖范围内，且未被自己排除 */
function intersects(a, b) {
    const reach = (x, y) => x.dirs.some((d) => y.dirs.some((p) => covered(p, y.exclude ?? [], d)) && covered(d, x.exclude ?? [], d));
    return reach(a, b) || reach(b, a);
}
/** 校验分区声明并生成路由正则：id 合法唯一、前缀格式正确、上限为正整数、两两不相交 */
export function definePartitions(specs) {
    const ids = new Set();
    for (const spec of specs) {
        if (!ID_RE.test(spec.id))
            throw new Error(`[runtime-cache] 分区 id 非法：${spec.id}（只用小写字母、数字、连字符）`);
        if (ids.has(spec.id))
            throw new Error(`[runtime-cache] 分区 id 重复：${spec.id}`);
        ids.add(spec.id);
        if (spec.dirs.length === 0)
            throw new Error(`[runtime-cache] 分区 ${spec.id} 没有目录`);
        for (const dir of [...spec.dirs, ...(spec.exclude ?? [])]) {
            if (!DIR_RE.test(dir))
                throw new Error(`[runtime-cache] 分区 ${spec.id} 的前缀 ${dir} 须相对 public 根且以 / 结尾`);
        }
        if (!Number.isInteger(spec.maxEntries) || spec.maxEntries < 1)
            throw new Error(`[runtime-cache] 分区 ${spec.id} 的 maxEntries 须为正整数`);
    }
    for (let i = 0; i < specs.length; i++) {
        for (let j = i + 1; j < specs.length; j++) {
            if (intersects(specs[i], specs[j])) {
                throw new Error(`[runtime-cache] 分区 ${specs[i].id} 与 ${specs[j].id} 相交——用 exclude 把子目录让给更细的分区`);
            }
        }
    }
    return specs.map((spec) => {
        const dirs = spec.dirs.map(escapeRe).join("|");
        const ex = (spec.exclude ?? []).map(escapeRe).join("|");
        return { ...spec, pattern: new RegExp(`${ORIGIN}${ex === "" ? "" : `(?!(?:${ex}))`}(?:${dirs})`) };
    });
}
/** 站内路径（/data/...）归哪个分区；不是运行时资源返回 null。与 sw.js 路由同一组正则 */
export function partitionOf(partitions, pathname) {
    const url = `https://nexus.local${pathname}`;
    return partitions.find((p) => p.pattern.test(url))?.id ?? null;
}
/** 递归收集相对 root 的文件路径（排序保证遍历序稳定；跳过点文件——.DS_Store 之类本机杂文件） */
function listFiles(dir, root) {
    const out = [];
    for (const name of readdirSync(dir).sort()) {
        if (name.startsWith("."))
            continue;
        const abs = join(dir, name);
        if (statSync(abs).isDirectory())
            out.push(...listFiles(abs, root));
        else
            out.push(relative(root, abs).split("\\").join("/"));
    }
    return out;
}
/**
 * 各分区内容指纹（sha256 前 12 位）：相对路径 + 内容逐个喂入，路径补 NUL 分帧杜绝拼接
 * 歧义；分区内没有文件记 null（资源没生成——交给 runtimeCacheNames 报错，不在这里造名）
 */
export function computePartitionFingerprints(publicDir, partitions) {
    const roots = [...new Set(partitions.flatMap((p) => p.dirs.map((d) => d.split("/")[0])))].sort();
    const hashes = new Map();
    for (const top of roots) {
        const dir = join(publicDir, top);
        if (!existsSync(dir))
            continue;
        for (const rel of listFiles(dir, publicDir)) {
            const id = partitionOf(partitions, `/${rel}`);
            if (id === null)
                continue;
            let h = hashes.get(id);
            if (h === undefined)
                hashes.set(id, (h = createHash("sha256")));
            h.update(`${rel}\0`);
            h.update(readFileSync(join(publicDir, rel)));
        }
    }
    const out = {};
    for (const p of partitions)
        out[p.id] = hashes.get(p.id)?.digest("hex").slice(0, 12) ?? null;
    return out;
}
/** 运行时仓名公共前缀 */
export const runtimeCachePrefix = (appId) => `${appId}-runtime-`;
/** 各分区运行时仓名；有分区没指纹（空分区）直接抛错——sw.js 不得写出 -null 仓名 */
export function runtimeCacheNames(partitions, fingerprints, appId) {
    const empty = partitions.filter((p) => (fingerprints[p.id] ?? null) === null).map((p) => p.id);
    if (empty.length > 0) {
        throw new Error(`[runtime-cache] 运行时资源分区没有文件：${empty.join(", ")}——资源没生成，或分区声明的目录写错了`);
    }
    const out = {};
    for (const p of partitions)
        out[p.id] = `${runtimeCachePrefix(appId)}${p.id}-${fingerprints[p.id]}`;
    return out;
}
/**
 * 旧运行时仓清理脚本（sw.js 经 importScripts 引入，activate 时执行）：workbox 自带的
 * cleanupOutdatedCaches 只清预缓存仓，运行时仓归这里——凡前缀开头而不在本版名单的仓
 * 一律删除。名单直接写进脚本：删错的唯一后果是重下资源，不会拿错内容；清理失败只记
 * 日志不阻断激活。
 */
export function cleanupScriptSource(currentNames, appId) {
    const keep = JSON.stringify([...currentNames].sort());
    const prefix = JSON.stringify(runtimeCachePrefix(appId));
    return `// 生成文件（@nexus-kit/vite runtime-cache cleanupScriptSource），勿手改
self.addEventListener("activate", (event) => {
  const KEEP = ${keep};
  event.waitUntil((async () => {
    try {
      const names = await self.caches.keys();
      const stale = names.filter((name) => name.startsWith(${prefix}) && !KEEP.includes(name));
      await Promise.all(stale.map((name) => self.caches.delete(name)));
      if (stale.length > 0) console.log("[pwa] 已清理旧运行时缓存仓:", stale);
    } catch (err) {
      console.warn("[pwa] 旧运行时缓存仓清理失败(不阻断激活):", err);
    }
  })());
});
`;
}
/** 清理脚本文件名带内容指纹：每代名单一个新 URL，CDN/浏览器缓存不可能把旧名单递给新 SW */
export function cleanupScriptFileName(currentNames, appId) {
    const digest = createHash("sha256").update(cleanupScriptSource(currentNames, appId)).digest("hex").slice(0, 8);
    return `pwa-runtime-cleanup-${digest}.js`;
}
