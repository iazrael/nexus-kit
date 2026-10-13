/**
 * nexus.config.json（宿主仓库根）的读取与校验：devflow 各命令（docs-audit、
 * check-changelog、deploy）共用这一份配置。外部文件先作 unknown 校验，字段非法即抛错
 * 指明哪一项——不静默套默认值掩盖写错的配置。
 *
 * 部署参数允许环境变量覆盖（NEXUS_DEPLOY_TARGET / _ROOT / _PUBLIC_URL / _KEEP），便于临时
 * 换目标机；主机地址不是密钥，但 ssh 凭据一律走本机 ssh 配置，不进任何文件。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DeployConfig {
  /** ssh 目标，如 root@1.2.3.4 */
  target: string;
  /** 服务器部署根（其下 releases/ 与 current 软链） */
  remoteRoot: string;
  /** 公网地址（边缘 TTL 探针用；空串 = 不探） */
  publicUrl: string;
  /** 服务器回环端口（nginx 只监听 127.0.0.1 的端口，冒烟走它） */
  localPort: number;
  /** 保留最近几版 */
  keep: number;
  /** 只允许从哪个分支部署 */
  branch: string;
  /** 必须带 Cache-Control: private 的路径（更新链关键文件） */
  privateRequired: string[];
  /** 必须 gzip 下发的路径 */
  gzipRequired: string[];
  /** 公网边缘 TTL 探针：不带哈希、每版都在的常驻文件 */
  edgeTtlProbes: string[];
}

export interface NexusConfig {
  /** 仓库根（配置文件所在目录） */
  repoRoot: string;
  /** 应用根（package.json、CHANGELOG.md、dist/ 所在），相对仓库根，默认 "." */
  appRoot: string;
  /** CHANGELOG 门禁：源码目录前缀（相对仓库根）与 CHANGELOG 路径 */
  changelog: { path: string; sourceDirs: string[] };
  /** 文档审计：文档根、存档目录、设计稿目录、索引文件（活文档必须登记在这里） */
  docs: { root: string; archiveDir: string; designDir: string; index: string };
  deploy: DeployConfig | null;
}

export const CONFIG_FILE = "nexus.config.json";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(o: Obj, key: string, where: string, fallback?: string): string {
  const v = o[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string" || v === "") throw new Error(`[nexus.config] ${where}.${key} 必须是非空字符串`);
  return v;
}
function strList(o: Obj, key: string, where: string, fallback: string[]): string[] {
  const v = o[key];
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`[nexus.config] ${where}.${key} 必须是字符串数组`);
  return v as string[];
}
function posInt(o: Obj, key: string, where: string, fallback: number): number {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`[nexus.config] ${where}.${key} 必须是正整数`);
  return v;
}

export const DEFAULT_PRIVATE_REQUIRED = ["/", "/sw.js", "/version.json", "/manifest.webmanifest"];

export function parseNexusConfig(raw: unknown, repoRoot: string, env: NodeJS.ProcessEnv = {}): NexusConfig {
  if (!isObj(raw)) throw new Error("[nexus.config] 顶层必须是对象");
  const cl = raw.changelog === undefined ? {} : raw.changelog;
  const docs = raw.docs === undefined ? {} : raw.docs;
  if (!isObj(cl)) throw new Error("[nexus.config] changelog 必须是对象");
  if (!isObj(docs)) throw new Error("[nexus.config] docs 必须是对象");
  const appRoot = str(raw, "appRoot", "", ".");

  let deploy: DeployConfig | null = null;
  if (raw.deploy !== undefined) {
    if (!isObj(raw.deploy)) throw new Error("[nexus.config] deploy 必须是对象");
    const d: Obj = { ...raw.deploy };
    if (env.NEXUS_DEPLOY_TARGET) d.target = env.NEXUS_DEPLOY_TARGET;
    if (env.NEXUS_DEPLOY_ROOT) d.remoteRoot = env.NEXUS_DEPLOY_ROOT;
    if (env.NEXUS_DEPLOY_PUBLIC_URL !== undefined) d.publicUrl = env.NEXUS_DEPLOY_PUBLIC_URL;
    if (env.NEXUS_DEPLOY_KEEP) d.keep = Number(env.NEXUS_DEPLOY_KEEP);
    const publicUrl = d.publicUrl === undefined ? "" : d.publicUrl;
    if (typeof publicUrl !== "string") throw new Error("[nexus.config] deploy.publicUrl 必须是字符串");
    deploy = {
      target: str(d, "target", "deploy"),
      remoteRoot: str(d, "remoteRoot", "deploy"),
      publicUrl: publicUrl.replace(/\/$/, ""),
      localPort: posInt(d, "localPort", "deploy", 8888),
      keep: posInt(d, "keep", "deploy", 5),
      branch: str(d, "branch", "deploy", "main"),
      privateRequired: strList(d, "privateRequired", "deploy", DEFAULT_PRIVATE_REQUIRED),
      gzipRequired: strList(d, "gzipRequired", "deploy", []),
      edgeTtlProbes: strList(d, "edgeTtlProbes", "deploy", []),
    };
    // 远端路径会拼进 ssh 命令：只允许安全字符，杜绝引号注入
    if (!/^\/[\w./-]+$/.test(deploy.remoteRoot))
      throw new Error("[nexus.config] deploy.remoteRoot 只能含字母、数字与 _ . / -，且以 / 开头");
    if (!/^[\w.@-]+$/.test(deploy.target)) throw new Error("[nexus.config] deploy.target 只能含字母、数字与 _ . @ -");
    for (const p of [...deploy.privateRequired, ...deploy.gzipRequired, ...deploy.edgeTtlProbes]) {
      if (!/^\/[\w./-]*$/.test(p)) throw new Error(`[nexus.config] deploy 路径 ${p} 只能含字母、数字与 _ . / -，且以 / 开头`);
    }
  }

  return {
    repoRoot,
    appRoot,
    changelog: {
      path: str(cl, "path", "changelog", join(appRoot, "CHANGELOG.md")),
      sourceDirs: strList(cl, "sourceDirs", "changelog", [join(appRoot, "src") + "/"]),
    },
    docs: {
      root: str(docs, "root", "docs", "docs"),
      archiveDir: str(docs, "archiveDir", "docs", "docs/存档"),
      designDir: str(docs, "designDir", "docs", "docs/设计"),
      index: str(docs, "index", "docs", "CLAUDE.md"),
    },
    deploy,
  };
}

/** 从 cwd 向上找 nexus.config.json；找不到抛错 */
export function loadNexusConfig(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): NexusConfig {
  let dir = resolve(cwd);
  for (;;) {
    const file = join(dir, CONFIG_FILE);
    if (existsSync(file)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(`[nexus.config] ${file} 不是合法 JSON：${String(error).slice(0, 120)}`, { cause: error });
      }
      return parseNexusConfig(raw, dir, env);
    }
    const parent = resolve(dir, "..");
    if (parent === dir) throw new Error(`[nexus.config] 从 ${cwd} 向上找不到 ${CONFIG_FILE}`);
    dir = parent;
  }
}
