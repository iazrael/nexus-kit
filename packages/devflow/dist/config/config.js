import { parseTaskConfig } from "../task/config.js";
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
export const CONFIG_FILE = "nexus.config.json";
function isObj(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(o, key, where, fallback) {
    const v = o[key];
    if (v === undefined && fallback !== undefined)
        return fallback;
    if (typeof v !== "string" || v === "")
        throw new Error(`[nexus.config] ${where}.${key} 必须是非空字符串`);
    return v;
}
function strList(o, key, where, fallback) {
    const v = o[key];
    if (v === undefined)
        return fallback;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
        throw new Error(`[nexus.config] ${where}.${key} 必须是字符串数组`);
    return v;
}
function posInt(o, key, where, fallback) {
    const v = o[key];
    if (v === undefined)
        return fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
        throw new Error(`[nexus.config] ${where}.${key} 必须是正整数`);
    return v;
}
function bool(o, key, where, fallback) {
    const v = o[key];
    if (v === undefined)
        return fallback;
    if (typeof v !== "boolean")
        throw new Error(`[nexus.config] ${where}.${key} 必须是布尔值`);
    return v;
}
function section(raw, key) {
    const v = raw[key];
    if (v === undefined)
        return {};
    if (!isObj(v))
        throw new Error(`[nexus.config] ${key} 必须是对象`);
    return v;
}
/** 仓库内相对路径：不得绝对、不得含 .. 段（会拼进软链与删除判定）；尾斜杠去掉 */
function relPathList(o, key, where, fallback) {
    return strList(o, key, where, fallback).map((p) => {
        if (p === "" || p.startsWith("/") || p.split("/").includes("..")) {
            throw new Error(`[nexus.config] ${where}.${key} 的 ${JSON.stringify(p)} 必须是仓库内相对路径（不以 / 开头、不含 ..）`);
        }
        return p.replace(/\/+$/, "");
    });
}
/** 命令清单：每条是非空字符串数组（argv，不经 shell） */
function commandList(o, key, where, fallback, allowEmpty) {
    const v = o[key];
    if (v === undefined)
        return fallback;
    const ok = Array.isArray(v) &&
        (allowEmpty || v.length > 0) &&
        v.every((c) => Array.isArray(c) && c.length > 0 && c.every((x) => typeof x === "string" && x !== ""));
    if (!ok)
        throw new Error(`[nexus.config] ${where}.${key} 必须是${allowEmpty ? "" : "非空的"}命令数组，每条形如 ["pnpm", "build"]`);
    return v;
}
export const DEFAULT_PRIVATE_REQUIRED = ["/", "/sw.js", "/version.json", "/manifest.webmanifest"];
/** 发版链默认步骤：完成标准 → 构建 → 部署（部署自带冒烟与失败回滚） */
export const DEFAULT_RELEASE_STEPS = [
    ["pnpm", "check"],
    ["pnpm", "build"],
    ["pnpm", "run", "deploy"],
];
export function parseNexusConfig(raw, repoRoot, env = {}) {
    if (!isObj(raw))
        throw new Error("[nexus.config] 顶层必须是对象");
    const docs = raw.docs === undefined ? {} : raw.docs;
    if (!isObj(docs))
        throw new Error("[nexus.config] docs 必须是对象");
    const appRoot = str(raw, "appRoot", "", ".");
    let deploy = null;
    if (raw.deploy !== undefined) {
        if (!isObj(raw.deploy))
            throw new Error("[nexus.config] deploy 必须是对象");
        const d = { ...raw.deploy };
        if (env.NEXUS_DEPLOY_TARGET)
            d.target = env.NEXUS_DEPLOY_TARGET;
        if (env.NEXUS_DEPLOY_ROOT)
            d.remoteRoot = env.NEXUS_DEPLOY_ROOT;
        if (env.NEXUS_DEPLOY_PUBLIC_URL !== undefined)
            d.publicUrl = env.NEXUS_DEPLOY_PUBLIC_URL;
        if (env.NEXUS_DEPLOY_KEEP)
            d.keep = Number(env.NEXUS_DEPLOY_KEEP);
        const publicUrl = d.publicUrl === undefined ? "" : d.publicUrl;
        if (typeof publicUrl !== "string")
            throw new Error("[nexus.config] deploy.publicUrl 必须是字符串");
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
        if (!/^[\w.@-]+$/.test(deploy.target))
            throw new Error("[nexus.config] deploy.target 只能含字母、数字与 _ . @ -");
        for (const p of [...deploy.privateRequired, ...deploy.gzipRequired, ...deploy.edgeTtlProbes]) {
            if (!/^\/[\w./-]*$/.test(p))
                throw new Error(`[nexus.config] deploy 路径 ${p} 只能含字母、数字与 _ . / -，且以 / 开头`);
        }
    }
    const wt = section(raw, "worktree");
    const base = str(wt, "base", "worktree", deploy?.branch ?? "main");
    if (!/^[\w./-]+$/.test(base) || base.startsWith("-"))
        throw new Error("[nexus.config] worktree.base 不是合法分支名");
    const portBase = posInt(wt, "portBase", "worktree", 4173);
    if (portBase > 65_000)
        throw new Error("[nexus.config] worktree.portBase 必须小于 65000");
    const share = relPathList(wt, "share", "worktree", [join(appRoot, ".build-number")]);
    const isolatable = relPathList(wt, "isolatable", "worktree", share);
    for (const p of isolatable) {
        if (!share.includes(p))
            throw new Error(`[nexus.config] worktree.isolatable 的 ${p} 不在 worktree.share 里——只能隔离共享项`);
    }
    const worktree = {
        dir: wt.dir === undefined ? ".worktrees" : wt.dir === null ? null : str(wt, "dir", "worktree"),
        base,
        portBase,
        portStep: posInt(wt, "portStep", "worktree", 10),
        share,
        isolatable,
        disposable: relPathList(wt, "disposable", "worktree", []),
        postCreate: commandList(wt, "postCreate", "worktree", [["pnpm", "install", "--frozen-lockfile"]], true),
        // 合入可能改了锁文件（工作树里加了依赖）：先按锁文件装依赖，否则主仓库的验证找不到新依赖
        postMerge: commandList(wt, "postMerge", "worktree", [
            ["pnpm", "install", "--frozen-lockfile"],
            ["pnpm", "build"],
        ], true),
    };
    const rel = section(raw, "release");
    const release = {
        steps: commandList(rel, "steps", "release", DEFAULT_RELEASE_STEPS, false),
        lockTtlMin: posInt(rel, "lockTtlMin", "release", 30),
        holdTtlMin: posInt(rel, "holdTtlMin", "release", 120),
        push: bool(rel, "push", "release", true),
        githubRelease: bool(rel, "githubRelease", "release", false),
    };
    return {
        repoRoot,
        appRoot,
        changelog: parseChangelogConfig(raw),
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
/** CHANGELOG 门禁只消费应用根与 changelog 段，不校验任务、部署等无关配置。 */
function parseChangelogConfig(raw) {
    const appRoot = str(raw, "appRoot", "", ".");
    const cl = section(raw, "changelog");
    return {
        path: str(cl, "path", "changelog", join(appRoot, "CHANGELOG.md")),
        sourceDirs: strList(cl, "sourceDirs", "changelog", [join(appRoot, "src") + "/"]),
    };
}
function readConfigFile(dir) {
    const file = join(dir, CONFIG_FILE);
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch (error) {
        throw new Error(`[nexus.config] ${file} 无法读取或不是合法 JSON：${String(error).slice(0, 120)}`, { cause: error });
    }
}
/** 只读 dir 下的配置，不向上查找：合入后不能借用上级目录里别的项目的配置。 */
export function loadNexusConfigAt(dir, env = process.env) {
    if (!existsSync(join(dir, CONFIG_FILE)))
        throw new Error(`[nexus.config] ${join(dir, CONFIG_FILE)} 不存在`);
    return parseNexusConfig(readConfigFile(dir), dir, env);
}
function findConfigDir(cwd) {
    let dir = resolve(cwd);
    for (;;) {
        if (existsSync(join(dir, CONFIG_FILE)))
            return dir;
        const parent = resolve(dir, "..");
        if (parent === dir)
            throw new Error(`[nexus.config] 从 ${cwd} 向上找不到 ${CONFIG_FILE}`);
        dir = parent;
    }
}
export function loadNexusConfig(cwd = process.cwd(), env = process.env) {
    return loadNexusConfigAt(findConfigDir(cwd), env);
}
export function loadChangelogConfig(cwd = process.cwd()) {
    const repoRoot = findConfigDir(cwd);
    const raw = readConfigFile(repoRoot);
    if (!isObj(raw))
        throw new Error("[nexus.config] 顶层必须是对象");
    return { repoRoot, changelog: parseChangelogConfig(raw) };
}
