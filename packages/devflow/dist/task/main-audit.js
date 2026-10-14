import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { check, json, object, text, errorCode, safePath, printable } from "./validation.js";
import { gitOutput as git, atomic as save } from "./io.js";
import { fingerprint, nonce } from "./definition.js";
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function capture(root) {
    const entries = git(root, "ls-files", "--stage", "-z").split("\0").filter(Boolean);
    const flags = git(root, "ls-files", "-v", "-z").split("\0").filter(Boolean);
    const indexed = Object.create(null);
    for (const entry of entries) {
        const tab = entry.indexOf("\t"), path = entry.slice(tab + 1);
        (indexed[path] ??= []).push(entry.slice(0, tab));
    }
    // Include HEAD paths too: removing a file from the index must not remove it from the audit.
    for (const path of git(root, "ls-tree", "-r", "--name-only", "-z", "HEAD").split("\0").filter(Boolean))
        indexed[path] ??= [];
    const files = Object.create(null);
    for (const path of Object.keys(indexed).sort()) {
        let content;
        try {
            const file = join(root, path), stat = lstatSync(file);
            if (stat.isSymbolicLink())
                content = `link:${hash(readlinkSync(file))}`;
            else if (stat.isDirectory())
                content = "directory"; // Gitlinks are represented by their index entries.
            else
                content = `file:${stat.mode & 0o111}:${hash(readFileSync(file))}`;
        }
        catch (e) {
            if (errorCode(e) !== "ENOENT")
                throw e;
            content = "missing";
        }
        files[path] = hash(JSON.stringify([indexed[path], content]));
    }
    return {
        head: git(root, "rev-parse", "HEAD").trim(),
        branch: git(root, "rev-parse", "--abbrev-ref", "HEAD").trim(),
        files,
        dirty: git(root, "status", "--porcelain", "--untracked-files=no", "-z"),
        hidden: flags.filter((entry) => /^[a-zS]/.test(entry)).map((entry) => entry.slice(2)),
    };
}
export function assertMainClean(root) {
    const state = capture(root);
    check(state.hidden.length === 0, `主仓索引隐藏工作副本：${JSON.stringify(state.hidden)}；先取消 assume-unchanged 或 skip-worktree`);
    check(state.dirty === "", `主仓受跟踪文件有未提交或暂存改动：${JSON.stringify(state.dirty.split("\0").filter(Boolean))}；保留现场，先由协调者核对`);
    return state;
}
function readState(value) {
    const o = object(value, "主仓状态");
    for (const key of ["head", "branch"])
        text(o[key], key);
    check(typeof o.dirty === "string", "主仓 dirty 不合法");
    check(Array.isArray(o.hidden) && o.hidden.every((v) => typeof v === "string"), "主仓 hidden 不合法");
    for (const value of Object.values(object(o.files, "主仓文件指纹")))
        check(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "主仓文件指纹不合法");
    return o;
}
function readAudit(file) {
    check(!lstatSync(file).isSymbolicLink(), "主仓审计不能是软链");
    const o = object(json(file), "主仓审计");
    check(o.version === 1 && typeof o.passed === "boolean", "主仓审计格式不合法");
    text(o.operation, "operation");
    readState(o.before);
    if (o.after !== undefined)
        readState(o.after);
    check(!o.passed || o.after !== undefined, "主仓审计缺少收尾状态");
    return o;
}
export function beginMainAudit(root, control, operation) {
    const before = assertMainClean(root), file = safePath(control, `main-audit/${nonce()}.json`);
    save(file, { version: 1, operation, before, passed: false });
    save(safePath(control, `main-audit-refs/${basename(file)}`), { file });
    return file;
}
/**
 * allowAdvance: the execution window may last hours while the coordinator integrates other tasks.
 * A clean main that only fast-forwarded passes with a warning listing the new commits;
 * uncommitted changes, hidden index entries, branch switches and rewritten history still fail.
 */
export function finishMainAudit(root, file, allowAdvance = false) {
    file = safePath(root, relative(root, file));
    const audit = readAudit(file);
    try {
        const after = capture(root);
        audit.after = after;
        audit.paths = [...new Set([...Object.keys(audit.before.files), ...Object.keys(after.files)])].filter((path) => audit.before.files[path] !== after.files[path]);
        const settled = audit.before.branch === after.branch && after.dirty === "" && after.hidden.length === 0;
        const unchanged = audit.paths.length === 0 && audit.before.head === after.head;
        const advanced = allowAdvance &&
            audit.before.head !== after.head &&
            spawnSync("git", ["merge-base", "--is-ancestor", audit.before.head, after.head], { cwd: root }).status === 0;
        audit.passed = settled && (unchanged || advanced);
        if (audit.passed && advanced) {
            audit.commits = git(root, "log", "-z", "--format=%H %s", `${audit.before.head}..${after.head}`)
                .split("\0")
                .filter(Boolean)
                .map(printable);
            const shown = audit.commits.slice(0, 20).join(" | ");
            const more = audit.commits.length > 20 ? ` | 另有 ${audit.commits.length - 20} 个，见 ${file}` : "";
            audit.warning = `主仓在 ${audit.operation} 期间有 ${audit.commits.length} 个新提交（快进，工作区干净）：${shown}${more}。协调者确认这些提交都来自自己的合入`;
        }
        if (!audit.passed)
            audit.error = `主仓在 ${audit.operation} 期间变化：路径 ${JSON.stringify(audit.paths)}；HEAD ${audit.before.head} → ${after.head}；索引隐藏路径 ${JSON.stringify(after.hidden)}；Git 状态 ${JSON.stringify(after.dirty)}。变化来源需协调者核对`;
    }
    catch (e) {
        audit.passed = false;
        audit.error = `主仓审计收尾失败：${e instanceof Error ? e.message : String(e)}`;
    }
    save(file, audit);
    save(safePath(dirname(dirname(file)), `main-audit-refs/${basename(file)}`), { file, sha256: fingerprint(file) });
    check(audit.passed, `${audit.error}；主仓审计记录 ${file}；核对后使用 verify --main-review <JSON> 登记，不自动回滚`);
    return audit.warning;
}
export function reviewMainAudits(control, reviewFile) {
    assertReferences(control);
    const review = object(json(reviewFile), "主仓核对记录");
    text(review.reviewer, "reviewer");
    text(review.reason, "reason");
    check(Array.isArray(review.incidents) && review.incidents.length > 0, "incidents 必须是非空数组");
    const entries = review.incidents.map((value) => {
        const o = object(value, "主仓审计引用"), id = text(o.id, "id");
        check(/^[a-z0-9-]+\.json$/.test(id), "主仓审计 id 不合法");
        const file = safePath(control, `main-audit/${id}`), audit = readAudit(file);
        check(!audit.passed, "核对记录只能引用异常审计");
        check(o.sha256 === fingerprint(file), "主仓审计指纹不匹配");
        const record = { id, sha256: o.sha256, reviewer: review.reviewer, reason: review.reason };
        const target = safePath(control, `main-audit/reviews/${id}`);
        const existing = existsSync(target);
        if (existing) {
            const previous = object(json(target), "已有主仓核对登记");
            check(Object.entries(record).every(([key, value]) => previous[key] === value), "已有主仓核对记录不可覆盖；保留原核对依据");
        }
        return { target, record, existing };
    });
    // Validate the whole review before writing any acknowledgements.
    for (const entry of entries)
        if (!entry.existing)
            save(entry.target, entry.record);
}
function assertReference(control, pointer) {
    const reference = object(json(pointer), "主仓审计引用"), file = text(reference.file, "file");
    check(dirname(file) === join(control, "main-audit"), "主仓审计路径不匹配");
    readAudit(safePath(control, `main-audit/${basename(file)}`));
    if (reference.sha256 !== undefined)
        check(reference.sha256 === fingerprint(file), "主仓审计指纹变化");
}
function assertReferences(control) {
    const refs = safePath(control, "main-audit-refs");
    if (existsSync(refs)) {
        for (const id of readdirSync(refs))
            assertReference(control, safePath(control, `main-audit-refs/${id}`));
    }
    const runs = safePath(control, "runs");
    if (existsSync(runs)) {
        for (const directory of readdirSync(runs)) {
            const pointer = safePath(control, `runs/${directory}/main-audit.json`);
            if (!existsSync(pointer))
                continue; // Historical executions may have no audit.
            assertReference(control, pointer);
        }
    }
}
export function assertMainAuditsReviewed(control) {
    assertReferences(control);
    const dir = safePath(control, "main-audit");
    if (!existsSync(dir))
        return; // Existing tasks may have no historical audit evidence.
    for (const id of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
        const file = safePath(control, `main-audit/${id}`), audit = readAudit(file);
        if (audit.passed)
            continue;
        const reviewFile = safePath(control, `main-audit/reviews/${id}`);
        check(existsSync(reviewFile), `主仓异常审计尚未核对：${file}；SHA-256 ${fingerprint(file)}；verify --main-review <JSON> 需要 reviewer、reason、incidents[{id,sha256}]`);
        const review = object(json(reviewFile), "主仓核对登记");
        text(review.reviewer, "reviewer");
        text(review.reason, "reason");
        check(review.id === id && review.sha256 === fingerprint(file), `主仓审计或核对登记已变化：${file}`);
    }
}
export function mainAuditWarnings(control) {
    const dir = safePath(control, "main-audit");
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((id) => id.endsWith(".json"))
        .sort()
        .flatMap((id) => {
        const warning = readAudit(safePath(control, `main-audit/${id}`)).warning;
        return typeof warning === "string" ? [warning] : [];
    });
}
export function mainAuditManifest(control) {
    const dir = safePath(control, "main-audit");
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((id) => id.endsWith(".json"))
        .sort()
        .flatMap((id) => {
        const file = safePath(control, `main-audit/${id}`), audit = readAudit(file);
        const files = [file];
        const reference = safePath(control, `main-audit-refs/${id}`);
        if (existsSync(reference))
            files.push(reference);
        if (!audit.passed)
            files.push(safePath(control, `main-audit/reviews/${id}`));
        return files.map((file) => ({ file, sha256: fingerprint(file) }));
    });
}
