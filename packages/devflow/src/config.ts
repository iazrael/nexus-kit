import { parseTaskConfig } from "./task/config.ts";
import type { TaskConfig } from "./task/types.ts";
/**
 * nexus.config.json（宿主仓库根）的读取与校验：devflow 各命令（docs-audit、
 * check-changelog、deploy、worktree、release）共用这一份配置。外部文件先作 unknown 校验，字段非法即抛错
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

export interface WorktreeConfig {
  /** 工作树父目录（相对主仓库根）；null = 主仓库同级的「<仓库目录名>-worktrees」 */
  dir: string | null;
  /** 主干分支：合入目标，也是新工作树的默认起点 */
  base: string;
  /** 主仓库的预览端口；工作树从 portBase + portStep 起按 portStep 分配 */
  portBase: number;
  portStep: number;
  /** 不入 git、建树时软链回主仓库共享的路径（相对仓库根） */
  share: string[];
  /** share 里允许隔离成本树副本的项（isolate 与建树 --isolate 的可选名字），缺省等于 share；只读原料不列进来 */
  isolatable: string[];
  /** 回收时视为可再生的额外被忽略路径（相对仓库根，按路径段前缀） */
  disposable: string[];
  /** 建树后在新工作树里依次执行的命令（argv 数组） */
  postCreate: string[][];
  /** 合入后在主仓库依次执行的命令；失败即非零退出 */
  postMerge: string[][];
}

export interface ReleaseConfig {
  /** 发版链里部署前后的固定步骤（argv 数组，主仓库执行），每步之后核对 HEAD 未变 */
  steps: string[][];
  /** 发版链放锁的有效分钟数（进程被强杀留残锁时到期自动失效） */
  lockTtlMin: number;
  /** release --lock 手动放锁的默认有效分钟数（落款与门禁期间冻结主干） */
  holdTtlMin: number;
  /** 打 tag 后推送主干与 tag 到 origin */
  push: boolean;
  /** 推送后用 gh 创建 GitHub Release（正文 = 落款小节全量条目） */
  githubRelease: boolean;
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
  worktree: WorktreeConfig;
  release: ReleaseConfig;
  task: TaskConfig | null;
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

function bool(o: Obj, key: string, where: string, fallback: boolean): boolean {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error(`[nexus.config] ${where}.${key} 必须是布尔值`);
  return v;
}
function section(raw: Obj, key: string): Obj {
  const v = raw[key];
  if (v === undefined) return {};
  if (!isObj(v)) throw new Error(`[nexus.config] ${key} 必须是对象`);
  return v;
}
/** 仓库内相对路径：不得绝对、不得含 .. 段（会拼进软链与删除判定）；尾斜杠去掉 */
function relPathList(o: Obj, key: string, where: string, fallback: string[]): string[] {
  return strList(o, key, where, fallback).map((p) => {
    if (p === "" || p.startsWith("/") || p.split("/").includes("..")) {
      throw new Error(`[nexus.config] ${where}.${key} 的 ${JSON.stringify(p)} 必须是仓库内相对路径（不以 / 开头、不含 ..）`);
    }
    return p.replace(/\/+$/, "");
  });
}
/** 命令清单：每条是非空字符串数组（argv，不经 shell） */
function commandList(o: Obj, key: string, where: string, fallback: string[][], allowEmpty: boolean): string[][] {
  const v = o[key];
  if (v === undefined) return fallback;
  const ok =
    Array.isArray(v) &&
    (allowEmpty || v.length > 0) &&
    v.every((c) => Array.isArray(c) && c.length > 0 && c.every((x) => typeof x === "string" && x !== ""));
  if (!ok) throw new Error(`[nexus.config] ${where}.${key} 必须是${allowEmpty ? "" : "非空的"}命令数组，每条形如 ["pnpm", "build"]`);
  return v as string[][];
}

export const DEFAULT_PRIVATE_REQUIRED = ["/", "/sw.js", "/version.json", "/manifest.webmanifest"];

/** 发版链默认步骤：完成标准 → 构建 → 部署（部署自带冒烟与失败回滚） */
export const DEFAULT_RELEASE_STEPS: string[][] = [
  ["pnpm", "check"],
  ["pnpm", "build"],
  ["pnpm", "run", "deploy"],
];

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

  const wt = section(raw, "worktree");
  const base = str(wt, "base", "worktree", deploy?.branch ?? "main");
  if (!/^[\w./-]+$/.test(base) || base.startsWith("-")) throw new Error("[nexus.config] worktree.base 不是合法分支名");
  const portBase = posInt(wt, "portBase", "worktree", 4173);
  if (portBase > 65_000) throw new Error("[nexus.config] worktree.portBase 必须小于 65000");
  const share = relPathList(wt, "share", "worktree", [join(appRoot, ".build-number")]);
  const isolatable = relPathList(wt, "isolatable", "worktree", share);
  for (const p of isolatable) {
    if (!share.includes(p)) throw new Error(`[nexus.config] worktree.isolatable 的 ${p} 不在 worktree.share 里——只能隔离共享项`);
  }
  const worktree: WorktreeConfig = {
    dir: wt.dir === undefined ? null : str(wt, "dir", "worktree"),
    base,
    portBase,
    portStep: posInt(wt, "portStep", "worktree", 10),
    share,
    isolatable,
    disposable: relPathList(wt, "disposable", "worktree", []),
    postCreate: commandList(wt, "postCreate", "worktree", [["pnpm", "install", "--frozen-lockfile"]], true),
    // 合入可能改了锁文件（工作树里加了依赖）：先按锁文件装依赖，否则主仓库的验证找不到新依赖
    postMerge: commandList(
      wt,
      "postMerge",
      "worktree",
      [
        ["pnpm", "install", "--frozen-lockfile"],
        ["pnpm", "build"],
      ],
      true,
    ),
  };

  const rel = section(raw, "release");
  const release: ReleaseConfig = {
    steps: commandList(rel, "steps", "release", DEFAULT_RELEASE_STEPS, false),
    lockTtlMin: posInt(rel, "lockTtlMin", "release", 30),
    holdTtlMin: posInt(rel, "holdTtlMin", "release", 120),
    push: bool(rel, "push", "release", true),
    githubRelease: bool(rel, "githubRelease", "release", false),
  };

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
    worktree,
    release,
    task: raw.task === undefined ? null : parseTaskConfig(raw.task),
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
