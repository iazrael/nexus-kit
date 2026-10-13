/**
 * 升级检测的版本比对与多版本聚合纯逻辑（docs/架构算法/离线与升级.md §4/§5）。
 *
 * version.json（构建期由 CHANGELOG 解析产出，装最近 30 个已发版本）与本地指纹
 * （构建期注入的 version/build）在此比对：弹窗展示「本地版本 → 最新版本」之间**所有**
 * 已发版本的条目——落后几版的用户一次看全中间过程。网络取数与 SW 状态机在 controller.ts，
 * 本模块只做纯计算，全部可单测。
 *
 * 运行时数据边界（Web 运行时开发规范「运行时数据边界」）：远端 JSON 先作 unknown 校验——顶层非法返回
 * null 调用方按「无更新」处理并记日志；单条目非法剔除降级，不整表作废。
 */

/** 本地构建指纹（构建期注入：package.json 版本 + 构建计数器）。
 *  notesDigest = 本版对外条目指纹（构建期由 CHANGELOG 算出注入）；缺省时同版本
 *  重发一律按内容有更新处理（宁可重列，不说错话） */
export interface LocalFingerprint {
  version: string;
  build: number;
  notesDigest?: string;
}

/** version.json 里的单个已发版本 */
export interface RemoteRelease {
  version: string;
  date: string;
  notes: string[];
}

/** dist/version.json 的合法形态 */
export interface RemoteVersionInfo {
  version: string;
  build: number;
  buildTime: string;
  releases: RemoteRelease[];
}

/**
 * 更新类型：upgrade = 跨版本；hotfix = 同版本重发且对外条目未变（恒无版本组，弹窗给
 * 固定问题修复说明）；revised = 同版本重发但对外条目变了（列出该版现行条目）。
 */
export type PendingKind = "upgrade" | "hotfix" | "revised";

/** 待展示的更新：按文件序（新在前）的版本组 + 折叠数 + 更新类型 */
export interface PendingUpdate {
  releases: RemoteRelease[];
  hiddenCount: number;
  kind: PendingKind;
}

/**
 * 一版对外条目的内容指纹（FNV-1a 32 位，8 位十六进制）：构建期（@nexus-kit/vite 注入本地）
 * 与运行时（远端 version.json 同版本条目）同一函数，比对同版本重发时条目变没变。
 * 非安全用途，只需稳定与区分度。
 */
export function releaseNotesDigest(notes: readonly string[]): string {
  const text = JSON.stringify(notes);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 校验一条远程版本目；非法返回 null（调用方剔除） */
function parseRelease(raw: unknown): RemoteRelease | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== "string" || r.version === "") return null;
  if (typeof r.date !== "string") return null;
  if (!Array.isArray(r.notes) || r.notes.some((note) => typeof note !== "string")) return null;
  return { version: r.version, date: r.date, notes: r.notes };
}

/** 远端 version.json 顶层校验：结构非法返回 null（fail-fast） */
export function parseVersionManifest(raw: unknown): RemoteVersionInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.version !== "string" || m.version === "") return null;
  if (typeof m.build !== "number" || !Number.isInteger(m.build) || m.build < 0) return null;
  if (typeof m.buildTime !== "string") return null;
  if (!Array.isArray(m.releases)) return null;
  const releases = m.releases.map(parseRelease).filter((release): release is RemoteRelease => release !== null);
  return { version: m.version, build: m.build, buildTime: m.buildTime, releases };
}

/** 剥前导 v/V 与首尾空白：本地 APP_VERSION 带 v（"v1.2.0"）、远端不带（"1.2.0"），
 *  同版本判定与核比较前先归一 */
function normalizeVersion(v: string): string {
  return v.trim().replace(/^[vV]/, "");
}

/** candidate 的版本核（忽略前导 v/V 与预发布后缀）是否真比 base 新；任一不可解析为 false */
export function isNewerVersion(candidate: string, base: string): boolean {
  const core = (v: string): [number, number, number] | null => {
    const match = /^[vV]?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = core(candidate);
  const b = core(base);
  if (a === null || b === null) return false;
  return (a[0] ?? 0) !== (b[0] ?? 0)
    ? (a[0] ?? 0) > (b[0] ?? 0)
    : (a[1] ?? 0) !== (b[1] ?? 0)
      ? (a[1] ?? 0) > (b[1] ?? 0)
      : (a[2] ?? 0) > (b[2] ?? 0);
}

/**
 * 汇总本地落后远端的更新：
 * - 版本号不同：取 releases 中比本地新的全部版本（本地较新=回滚场景，返回 null）；
 * - 同版本号但远端 build 更大（重发）：比对该版对外条目指纹——没变 = hotfix、不带条目
 *   （玩家已经有了，重列会让人以为又有新东西）；变了 = revised、列出该版现行条目
 *   （同版本号下改过玩法，不能只说「修复问题」）；远端该版无对外条目 = 玩家无感，null；
 * - 已是最新：null（无弹窗）。
 * maxVisible：弹窗最多展开的版本组数，更早的折叠进 hiddenCount。
 */
export function collectPendingReleases(
  local: LocalFingerprint,
  remote: RemoteVersionInfo | null,
  options: { maxVisible?: number } = {},
): PendingUpdate | null {
  if (remote === null) return null;
  const maxVisible = Math.max(0, options.maxVisible ?? 8);

  if (normalizeVersion(remote.version) === normalizeVersion(local.version)) {
    if (remote.build <= local.build) return null;
    const current = remote.releases.find((release) => normalizeVersion(release.version) === normalizeVersion(remote.version));
    // 该版全是「内部：」条目（不进 releases）：玩家无感，不弹窗打断，下次启动自然更新
    if (current === undefined || current.notes.length === 0) return null;
    if (local.notesDigest === releaseNotesDigest(current.notes)) return { releases: [], hiddenCount: 0, kind: "hotfix" };
    return { releases: [current], hiddenCount: 0, kind: "revised" };
  }
  if (!isNewerVersion(remote.version, local.version)) return null;
  const pending = remote.releases.filter((release) => isNewerVersion(release.version, local.version));
  if (pending.length === 0) return null;
  return {
    releases: pending.slice(0, maxVisible),
    hiddenCount: Math.max(0, pending.length - maxVisible),
    kind: "upgrade",
  };
}
