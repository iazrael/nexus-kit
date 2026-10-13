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
export const DEFAULT_PRIVATE_REQUIRED = ["/", "/sw.js", "/version.json", "/manifest.webmanifest"];
export function parseNexusConfig(raw, repoRoot, env = {}) {
    if (!isObj(raw))
        throw new Error("[nexus.config] 顶层必须是对象");
    const cl = raw.changelog === undefined ? {} : raw.changelog;
    const docs = raw.docs === undefined ? {} : raw.docs;
    if (!isObj(cl))
        throw new Error("[nexus.config] changelog 必须是对象");
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
export function loadNexusConfig(cwd = process.cwd(), env = process.env) {
    let dir = resolve(cwd);
    for (;;) {
        const file = join(dir, CONFIG_FILE);
        if (existsSync(file)) {
            let raw;
            try {
                raw = JSON.parse(readFileSync(file, "utf8"));
            }
            catch (error) {
                throw new Error(`[nexus.config] ${file} 不是合法 JSON：${String(error).slice(0, 120)}`, { cause: error });
            }
            return parseNexusConfig(raw, dir, env);
        }
        const parent = resolve(dir, "..");
        if (parent === dir)
            throw new Error(`[nexus.config] 从 ${cwd} 向上找不到 ${CONFIG_FILE}`);
        dir = parent;
    }
}
