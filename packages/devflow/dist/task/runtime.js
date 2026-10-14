import { loadNexusConfig } from "../config.js";
import { worktreeNew } from "../worktree.js";
import { systemProcessProbe } from "../worktree-procs.js";
import { taskWorktree } from "./config.js";
import { errorMessage, errorCode } from "./validation.js";
import { readSnapshot, readRun, readVerification, readAccepted, readReview, readPointer, readRunPointer, readRework } from "./records.js";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { agySessions, agyResult, agyInvocation } from "./agy.js";
import { existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, rmSync, cpSync, openSync, closeSync, chmodSync, lstatSync, } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, config, safePath, readTask, taskFile, header, setHeader, record, writeJson, sha, fingerprint, nonce, text, inside, } from "./definition.js";
function toolCli() {
    return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../cli.ts" : "../cli.js", import.meta.url));
}
export function git(root, ...args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function context(cwd = process.cwd()) {
    const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
    const common = realpathSync(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    check(common.endsWith("/.git"), "本批仅支持常规非 bare Git 仓库");
    return { root, mainRoot: dirname(common), cfg: config(root), backend: loadNexusConfig(root).worktree };
}
function inputFile(ctx, path) {
    return safePath(ctx.root, relative(ctx.root, realpathSync(resolve(ctx.root, path))));
}
function control(ctx, id) {
    return safePath(ctx.mainRoot, `${ctx.cfg.controlDir}/${id}`);
}
function atomic(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${nonce()}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    renameSync(temp, path);
}
function snapshotPath(ctx, id) {
    return join(control(ctx, id), "definition.json");
}
function loadSnapshot(ctx, id) {
    const file = snapshotPath(ctx, id);
    check(existsSync(file), "缺少派发或建树记录");
    return readSnapshot(file, ctx.root);
}
function worktree(ctx, snap) {
    return taskWorktree(ctx.mainRoot, snap.config, snap.spec.id);
}
function assertCommitted(root, paths) {
    for (const path of paths) {
        check(git(root, "ls-files", "--", path) === path, `输入或任务未提交：${path}`);
        check(git(root, "status", "--porcelain", "--", path) === "", `输入或任务有未提交改动：${path}`);
    }
}
function checkInputs(root, spec, source = false) {
    for (const input of spec.inputs) {
        const file = safePath(root, source ? (input.source ?? input.path) : input.path);
        check(existsSync(file), `缺少输入：${input.path}`);
        check(fingerprint(file) === input.sha256, `输入指纹不符：${input.path}`);
    }
}
function checkDefinition(ctx, snap, root) {
    const task = readTask(root, ctx.cfg, snap.spec.id);
    check(task.definition === snap.definition, "任务定义已变化，需要重新派发或重新确认");
    check(fingerprint(safePath(root, "nexus.config.json")) === snap.nexusHash, "工作树后端配置已变化，旧派发记录失效");
    check(sha(JSON.stringify(config(root))) === snap.configHash, "项目配置已变化，旧派发记录失效");
    for (const rule of snap.rules)
        check(fingerprint(safePath(root, rule.path)) === rule.sha256, `公共规则已变化：${rule.path}`);
    return task;
}
function prepare(ctx, id, refresh = false) {
    const task = readTask(ctx.root, ctx.cfg, id);
    check(["待认领", "返工", "中断", "受阻", "执行中"].includes(task.status), `状态 ${task.status} 不能派发或建树`);
    assertCommitted(ctx.root, [`${ctx.cfg.tasksDir}/${id}.md`, "nexus.config.json", ...ctx.cfg.rules]);
    checkInputs(ctx.root, task.spec, true);
    for (const dep of task.spec.dependencies) {
        const path = join(control(ctx, dep.id), "accepted.json");
        check(existsSync(path), `前置任务未通过：${dep.id}`);
        const accepted = checkedAcceptance(ctx, dep.id), wt = taskWorktree(ctx.mainRoot, ctx.cfg, dep.id);
        if (existsSync(wt)) {
            assertClean(wt);
            check(git(wt, "rev-parse", "HEAD") === accepted.acceptanceCommit && git(wt, "status", "--porcelain") === "", `前置任务版本变化或存在未提交内容：${dep.id}`);
        }
        else
            check(spawnSync("git", ["merge-base", "--is-ancestor", accepted.acceptanceCommit, "HEAD"], { cwd: ctx.mainRoot }).status === 0, `前置验收提交尚未集成：${dep.id}`);
        check(!dep.commit || dep.commit === accepted.verifiedCommit, `前置提交不符：${dep.id}`);
    }
    // The control directory must be ignored, otherwise launch metadata dirties main.
    const probe = relative(ctx.mainRoot, join(control(ctx, id), "definition.json"));
    const ignored = spawnSync("git", ["check-ignore", "--quiet", probe], { cwd: ctx.mainRoot });
    check(ignored.status === 0, `控制目录必须先由 Git 忽略：${ctx.cfg.controlDir}`);
    const snap = {
        version: 2,
        base: git(ctx.root, "rev-parse", "HEAD"),
        sourceRoot: ctx.root,
        spec: task.spec,
        definition: task.definition,
        config: task.effective,
        configHash: sha(JSON.stringify(ctx.cfg)),
        nexusHash: fingerprint(safePath(ctx.root, "nexus.config.json")),
        rules: ctx.cfg.rules.map((path) => ({ path, sha256: fingerprint(safePath(ctx.root, path)) })),
    };
    if (existsSync(snapshotPath(ctx, id))) {
        const old = loadSnapshot(ctx, id);
        if (refresh) {
            check(realpathSync(ctx.root) === realpathSync(worktree(ctx, old)), "重新确认必须在原任务工作树执行");
            check(["返工", "中断", "受阻", "执行中"].includes(task.status), "当前状态不能重新确认");
            check(old.spec.branch === snap.spec.branch && old.spec.worktree === snap.spec.worktree, "重新确认不能更换任务分支或工作树");
            const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", old.base, "HEAD"], { cwd: ctx.root });
            snap.base = ancestor.status === 0 ? old.base : git(ctx.mainRoot, "rev-parse", "HEAD");
            check(spawnSync("git", ["merge-base", "--is-ancestor", snap.base, "HEAD"], { cwd: ctx.root }).status === 0, "变基后必须先对齐主仓基准");
            return snap;
        }
        checkDefinition(ctx, old, existsSync(worktree(ctx, old)) ? worktree(ctx, old) : ctx.root);
        check(old.definition === snap.definition, "旧任务定义不同，保留现场并由协调者处理");
        return old;
    }
    return snap;
}
function commitTask(ctx, snap, wt, content, message) {
    const rel = `${ctx.cfg.tasksDir}/${snap.spec.id}.md`;
    writeFileSync(taskFile(wt, ctx.cfg, snap.spec.id), content);
    git(wt, "add", "--", rel);
    git(wt, "commit", "-m", message, "--", rel);
}
function lock(ctx, id, fn) {
    const path = join(control(ctx, id), "operation.lock");
    mkdirSync(dirname(path), { recursive: true });
    try {
        mkdirSync(path);
    }
    catch (e) {
        if (errorCode(e) === "EEXIST")
            throw new Error("任务操作正在进行或残锁待检查，拒绝重复操作", { cause: e });
        throw e;
    }
    let result;
    try {
        result = fn();
    }
    catch (e) {
        rmSync(path, { recursive: true });
        throw e;
    }
    if (result instanceof Promise)
        return result.finally(() => rmSync(path, { recursive: true }));
    rmSync(path, { recursive: true });
    return result;
}
export function start(ctx, id, owner) {
    text(owner, "负责人");
    check(!/[\r\n]/.test(owner), "负责人不能含换行");
    return lock(ctx, id, () => {
        const snap = existsSync(snapshotPath(ctx, id)) ? loadSnapshot(ctx, id) : prepare(ctx, id);
        const wt = worktree(ctx, snap);
        if (existsSync(wt)) {
            check(git(wt, "rev-parse", "--show-toplevel") === realpathSync(wt), "目录不是独立工作树");
            check(git(wt, "branch", "--show-current") === snap.spec.branch, "已有工作树分支不符");
            checkDefinition(ctx, snap, wt);
            checkInputs(wt, snap.spec);
            check(spawnSync("git", ["merge-base", "--is-ancestor", snap.base, "HEAD"], { cwd: wt }).status === 0, "旧工作树不是固定起点的后续版本");
            if (!existsSync(snapshotPath(ctx, id)))
                atomic(snapshotPath(ctx, id), snap);
            const current = readTask(wt, ctx.cfg, id);
            if (["待认领", "中断", "返工", "受阻"].includes(current.status))
                commitTask(ctx, snap, wt, record(setHeader(setHeader(current.content, "状态", "执行中"), "负责人", owner), "恢复原工作树继续执行"), `续跑：${id}`);
            return { id, worktree: wt, base: snap.base, head: git(wt, "rev-parse", "HEAD"), restored: true };
        }
        checkDefinition(ctx, snap, snap.sourceRoot);
        checkInputs(snap.sourceRoot, snap.spec, true);
        // nexus-devflow computes directory from the branch basename.
        check(snap.spec.branch.split("/").at(-1) === id, "分支末段必须与任务标识一致");
        const created = worktreeNew({
            cwd: snap.sourceRoot,
            config: { ...ctx.backend, dir: snap.config.worktreeDir, share: [], postCreate: snap.config.postCreate },
            procs: systemProcessProbe(),
            log: (message) => process.stderr.write(`[task] ${message}\n`),
            run: (cmd, args, cwd) => {
                execFileSync(cmd, args, { cwd, stdio: ["ignore", 2, 2] });
            },
        }, { branch: snap.spec.branch, from: snap.base });
        check(realpathSync(created.root) === realpathSync(wt), "后端建树位置与任务不符");
        check(existsSync(wt), "后端建树位置与任务不符");
        check(git(wt, "rev-parse", "HEAD") === snap.base && git(wt, "branch", "--show-current") === snap.spec.branch, "后端建树版本不符");
        for (const input of snap.spec.inputs) {
            const dest = safePath(wt, input.path);
            if (!existsSync(dest)) {
                mkdirSync(dirname(dest), { recursive: true });
                cpSync(safePath(snap.sourceRoot, input.source ?? input.path), dest, { errorOnExist: true, force: false });
            }
        }
        for (const input of snap.spec.inputs)
            chmodSync(safePath(wt, input.path), 0o444);
        checkInputs(wt, snap.spec);
        atomic(snapshotPath(ctx, id), snap);
        const task = checkDefinition(ctx, snap, wt);
        let content = setHeader(setHeader(setHeader(task.content, "状态", "执行中"), "负责人", owner), "开始时间", new Date().toISOString());
        content = record(content, `认领；起始提交 ${snap.base}，分支 ${snap.spec.branch}，工作树 ${snap.spec.worktree}`);
        commitTask(ctx, snap, wt, content, `认领：${id}`);
        return { id, worktree: wt, base: snap.base, head: git(wt, "rev-parse", "HEAD"), restored: false };
    });
}
export function status(ctx, id) {
    const dir = safePath(ctx.root, ctx.cfg.tasksDir);
    const files = id ? [`${id}.md`] : readdirSync(dir).filter((p) => p.endsWith(".md") && p !== "协作规则.md");
    const tasks = files.map((file) => {
        const content = readFileSync(safePath(ctx.root, `${ctx.cfg.tasksDir}/${file}`), "utf8");
        const match = content.match(/<!-- task-config -->\s*```json\n([\s\S]*?)\n```/);
        if (!match)
            return {
                task: `${ctx.cfg.tasksDir}/${file}`,
                legacy: true,
                status: content.match(/^> 状态：(.+)$/m)?.[1] ?? "未登记",
                note: "主仓历史状态，未读取旧工作树；旧任务只读，不支持派发",
            };
        const key = file.slice(0, -3), task = readTask(ctx.root, ctx.cfg, key, false);
        const wt = taskWorktree(ctx.mainRoot, ctx.cfg, key), hasTree = existsSync(wt);
        let current = task.status, head = null;
        if (hasTree) {
            check(git(wt, "branch", "--show-current") === task.spec.branch, `工作树分支不符：${key}`);
            current = header(readFileSync(taskFile(wt, ctx.cfg, key), "utf8"), "状态");
            head = git(wt, "rev-parse", "HEAD");
        }
        return {
            id: key,
            task: `${ctx.cfg.tasksDir}/${file}`,
            status: current,
            worktree: wt,
            treeExists: hasTree,
            head,
            legacy: false,
            run: runInfo(ctx, key),
            verification: verificationInfo(ctx, key, head),
            acceptance: acceptanceInfo(ctx, key, head),
        };
    });
    return { tasks };
}
function verificationInfo(ctx, id, head) {
    const pointer = join(control(ctx, id), "latest-verify.json");
    if (!existsSync(pointer))
        return null;
    try {
        const latest = readPointer(pointer), file = safePath(ctx.mainRoot, relative(ctx.mainRoot, latest.file)), receipt = readVerification(file);
        check(!latest.sha256 || fingerprint(file) === latest.sha256, "验证材料指纹变化");
        if (receipt.passed)
            assertReceiptIntegrity(ctx, receipt);
        let matchesHead = receipt.commit === head;
        const acceptedFile = join(control(ctx, id), "accepted.json");
        if (!matchesHead && existsSync(acceptedFile)) {
            const accepted = readAccepted(acceptedFile);
            matchesHead = accepted.acceptanceCommit === head && accepted.verifiedCommit === receipt.commit;
        }
        return { passed: receipt.passed, commit: receipt.commit, matchesHead, endedAt: receipt.endedAt ?? null };
    }
    catch (e) {
        return { error: errorMessage(e) };
    }
}
function assertReceiptIntegrity(ctx, receipt) {
    check(receipt.passed, "正式验收引用的独立验证未通过");
    const output = safePath(ctx.mainRoot, relative(ctx.mainRoot, receipt.output));
    check(JSON.stringify(outputManifest(output)) === JSON.stringify(receipt.outputs), "独立复跑产物指纹变化");
    check(receipt.commands.length > 0 && receipt.commands.every((cmd) => cmd.exitCode === 0 && !cmd.timedOut), "验证命令记录不完整或失败");
    for (const cmd of receipt.commands) {
        check(fingerprint(safePath(ctx.mainRoot, relative(ctx.mainRoot, cmd.stdout))) === cmd.stdoutSha256 &&
            fingerprint(safePath(ctx.mainRoot, relative(ctx.mainRoot, cmd.stderr))) === cmd.stderrSha256, "独立验证日志指纹变化");
    }
}
function checkedAcceptance(ctx, id) {
    const accepted = readAccepted(join(control(ctx, id), "accepted.json"));
    check(accepted.id === id, "正式验收任务不匹配");
    const file = safePath(ctx.mainRoot, relative(ctx.mainRoot, accepted.receipt));
    check(fingerprint(file) === accepted.receiptSha256, "正式验收材料指纹变化");
    const receipt = readVerification(file);
    check(receipt.commit === accepted.verifiedCommit && receipt.id === id, "正式验收引用不匹配");
    check(accepted.review.commit === accepted.verifiedCommit && accepted.review.code.passed, "正式验收审查不匹配");
    assertReceiptIntegrity(ctx, receipt);
    return accepted;
}
function acceptanceInfo(ctx, id, head) {
    const file = join(control(ctx, id), "accepted.json");
    if (!existsSync(file))
        return null;
    try {
        const accepted = checkedAcceptance(ctx, id);
        const integrated = spawnSync("git", ["merge-base", "--is-ancestor", accepted.acceptanceCommit, "HEAD"], { cwd: ctx.mainRoot }).status === 0;
        return {
            verifiedCommit: accepted.verifiedCommit,
            acceptanceCommit: accepted.acceptanceCommit,
            acceptedAt: accepted.acceptedAt,
            passed: true,
            integrated,
            matchesHead: head === accepted.acceptanceCommit,
        };
    }
    catch (e) {
        return {
            verifiedCommit: "",
            acceptanceCommit: "",
            acceptedAt: "",
            passed: false,
            integrated: false,
            matchesHead: false,
            error: errorMessage(e),
        };
    }
}
export function shortStatus(result) {
    const clean = (v) => Array.from(String(v ?? "-"), (char) => (char.codePointAt(0) < 32 || char.codePointAt(0) === 127 ? " " : char)).join("");
    return result.tasks
        .map((t) => {
        if (t.legacy)
            return `${clean(t.task)}\t${clean(t.status)}\t历史（主仓快照）\t-\t验证=-`;
        const v = t.verification, label = !v
            ? "-"
            : v.error
                ? "材料错误"
                : !v.endedAt
                    ? "进行中"
                    : !v.passed && !v.commit
                        ? "失败"
                        : !t.head
                            ? "无法对账"
                            : !v.matchesHead
                                ? "过期"
                                : v.passed
                                    ? "通过"
                                    : "失败";
        return `${clean(t.id)}\t${clean(t.status)}${t.treeExists ? "" : "（调用树记录，树缺失）"}\t${clean(t.run?.state ?? "未派发")}\t${t.head?.slice(0, 8) ?? "-"}\t验证=${label}\t验收=${!t.acceptance ? "-" : t.acceptance.error ? "材料错误" : t.acceptance.matchesHead ? "通过" : t.acceptance.integrated ? "已集成（历史）" : "通过（历史，当前无法对账）"}`;
    })
        .join("\n");
}
function alive(pid) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid === 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        if (errorCode(e) === "ESRCH")
            return false;
        if (errorCode(e) === "EPERM")
            return true;
        throw e;
    }
}
function groupAlive(pid) {
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && alive(-pid);
}
function latestRun(ctx, id) {
    const pointer = join(control(ctx, id), "latest.json");
    if (!existsSync(pointer))
        return null;
    const directory = readRunPointer(pointer);
    const file = safePath(ctx.mainRoot, `${ctx.cfg.controlDir}/${id}/runs/${directory}/run.json`);
    return { file, data: readRun(file), directory };
}
function runInfo(ctx, id) {
    const run = latestRun(ctx, id);
    if (!run)
        return null;
    const info = run.data;
    if (["starting", "running"].includes(info.state) &&
        !alive(info.supervisorPid) &&
        (info.supervisorPid || Date.now() - Date.parse(info.startedAt) > 10_000))
        return { ...info, state: "interrupted", error: "监督进程已退出，原记录没有收尾；核对现场后恢复" };
    return info;
}
function noRunning(ctx, id) {
    const info = runInfo(ctx, id);
    check(!info || (!["starting", "running"].includes(info.state) && !groupAlive(info.executorPid)), "任务正在运行，拒绝重复派发、续跑或验收");
}
function promptFor(ctx, snap, resume) {
    const id = snap.spec.id;
    return `${resume ? "继续原会话与原工作树，不重建现场。" : "执行已分配的独立任务。"}\n任务：${ctx.cfg.tasksDir}/${id}.md\n起始提交：${snap.base}\n工作树：${worktree(ctx, snap)}\n先阅读任务与公共规则 ${ctx.cfg.rules.join("、")}，再执行 ${JSON.stringify(process.execPath)} ${JSON.stringify(toolCli())} task start ${id} --owner agy，自建或恢复工作树。工具启动目录为 ${snap.sourceRoot}。\n建树后只在指定树内白名单操作，不修改主仓或其他工作树；输入副本由 start 按指纹准备。\n目标：${snap.spec.goal}\n范围：${snap.spec.scope}\n每阶段更新同一任务并提交，保留失败命令、输出、现场和下一步。返工时以任务文件最新返工要求为准，逐项核对缺陷、复现命令和通过标准。只标待验收，不自行通过、合入、推送或发布。\n预算 ${snap.config.budgetMinutes} 分钟为进度检查节点，不删除现场；同方法三次失败保存证据并标受阻。\n最终回复给交付 SHA、复现命令、实际结果和未验证范围。`;
}
export async function dispatch(ctx, id, options = {}) {
    if (options.dryRun) {
        const snap = prepare(ctx, id, options.refreshDefinition);
        return { id, base: snap.base, prompt: promptFor(ctx, snap, false), dryRun: true };
    }
    const run = launch(ctx, id, false, options);
    return options.detach ? run : waitForRun(ctx, run);
}
export async function resume(ctx, id, options = {}) {
    const run = launch(ctx, id, true, options);
    return options.detach ? run : waitForRun(ctx, run);
}
async function waitForRun(ctx, run) {
    const file = safePath(ctx.mainRoot, relative(ctx.mainRoot, join(run.runDir, "run.json")));
    let cancelled = 0;
    const interrupt = () => {
        cancelled = 130;
    }, terminate = () => {
        cancelled = 143;
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    process.stderr.write(`[task] 等待任务 ${run.id}；运行目录 ${run.runDir}；取消等待不会终止执行器\n`);
    try {
        while (true) {
            const info = readRun(file);
            if (cancelled)
                return { ...info, runDir: run.runDir, waitingCancelled: true, commandExitCode: cancelled };
            if (info.endedAt && ["completed", "failed", "interrupted"].includes(info.state)) {
                const commandExitCode = info.state === "completed" ? (info.taskStatus === "受阻" ? 3 : 0) : 1;
                if (commandExitCode)
                    process.stderr.write(`[task] ${info.error ?? "任务受阻"}；运行目录 ${run.runDir}\n`);
                return { ...info, runDir: run.runDir, commandExitCode, ...(info.state === "completed" ? { result: agyResult(info.stdout) } : {}) };
            }
            const pid = info.supervisorPid ?? run.supervisorPid;
            if (!alive(pid))
                return { ...info, state: "interrupted", error: "监督进程异常退出，核对现场后恢复", runDir: run.runDir, commandExitCode: 1 };
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
    }
}
function launch(ctx, id, resuming, options) {
    return lock(ctx, id, () => {
        noRunning(ctx, id);
        const snap = options.refreshDefinition ? prepare(ctx, id, true) : resuming ? loadSnapshot(ctx, id) : prepare(ctx, id);
        const wt = worktree(ctx, snap);
        const task = checkDefinition(ctx, snap, existsSync(wt) ? wt : snap.sourceRoot);
        const previous = latestRun(ctx, id);
        const conversationId = resuming ? (options.conversation ?? previous?.data.conversationId ?? null) : null;
        if (resuming) {
            text(conversationId, "恢复会话 conversation_id");
            check(!/[\s\0]/.test(text(conversationId, "会话标识")), "非法会话标识");
            check(existsSync(wt), "原工作树缺失，不创建替代现场");
        }
        check(resuming
            ? ["返工", "中断", "受阻", "执行中"].includes(task.status)
            : ["待认领", "执行中", "中断", "受阻", "返工"].includes(task.status), `状态 ${task.status} 不能启动`);
        const definitionFile = snapshotPath(ctx, id);
        if (options.refreshDefinition && existsSync(definitionFile)) {
            writeJson(join(control(ctx, id), "definitions", `${nonce()}.json`), loadSnapshot(ctx, id));
            atomic(definitionFile, snap);
        }
        else if (!existsSync(definitionFile))
            atomic(definitionFile, snap);
        const directory = nonce(), runDir = join(control(ctx, id), "runs", directory);
        mkdirSync(runDir, { recursive: true });
        const info = {
            id,
            state: "starting",
            startedAt: new Date().toISOString(),
            supervisorPid: null,
            executorPid: null,
            conversationId,
            resume: resuming,
            sourceRoot: snap.sourceRoot,
            stdout: join(runDir, "stdout.json"),
            stderr: join(runDir, "stderr.log"),
            budgetReached: false,
            hardTimeout: false,
        };
        atomic(join(runDir, "run.json"), info);
        atomic(join(control(ctx, id), "latest.json"), { directory });
        writeFileSync(join(runDir, "prompt.txt"), promptFor(ctx, snap, resuming), { flag: "wx" });
        const runnerLog = openSync(join(runDir, "supervisor.log"), "wx");
        let child;
        try {
            child = spawn(process.execPath, [toolCli(), "task", "_supervise", id, "--run-dir", directory], {
                cwd: snap.sourceRoot,
                detached: true,
                stdio: ["ignore", runnerLog, runnerLog],
                env: { ...process.env },
            });
            check(typeof child.pid === "number" && Number.isInteger(child.pid), "无法启动监督进程");
            child.unref();
        }
        finally {
            closeSync(runnerLog);
        }
        return { id, state: "starting", supervisorPid: child.pid, conversationId, runDir, resume: resuming };
    });
}
function markInterrupted(ctx, snap, message) {
    const wt = worktree(ctx, snap);
    if (!existsSync(wt))
        return;
    const task = readTask(wt, ctx.cfg, snap.spec.id);
    if (["执行中", "待认领"].includes(task.status))
        commitTask(ctx, snap, wt, record(setHeader(task.content, "状态", "中断"), message), `记录中断：${snap.spec.id}`);
}
export async function supervise(ctx, id, directory) {
    const runDir = safePath(ctx.mainRoot, `${ctx.cfg.controlDir}/${id}/runs/${directory}`), file = join(runDir, "run.json");
    const info = readRun(file), snap = loadSnapshot(ctx, id);
    info.supervisorPid = process.pid;
    const save = () => atomic(file, info);
    let child, budget, progress, hard, sessionTimer, termination, cleanupError, out, err, sessionError;
    const readSession = agySessions(join(runDir, "agy.debug.log"), info.resume ? info.conversationId : null);
    const pollSession = () => {
        let id;
        try {
            id = readSession();
        }
        catch (e) {
            if (!info.conversationId && e instanceof Error && "identifiedConversationId" in e && typeof e.identifiedConversationId === "string") {
                info.conversationId = e.identifiedConversationId;
                info.sessionSource = "startup-log";
                save();
            }
            throw e;
        }
        if (id && (info.conversationId !== id || info.sessionSource !== "startup-log")) {
            info.conversationId = id;
            info.sessionSource = "startup-log";
            save();
        }
    };
    const terminate = () => {
        if (termination || !child?.pid)
            return;
        termination = stopGroup(child.pid).catch((error) => {
            cleanupError = error;
        });
    };
    const guarded = (callback) => () => {
        try {
            callback();
        }
        catch (e) {
            sessionError ??= e;
            terminate();
        }
    };
    const stop = () => {
        info.stopRequested = true;
        terminate();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
        checkDefinition(ctx, snap, snap.sourceRoot);
        const { exe, argv } = agyInvocation(snap.config.agy, info.resume ? text(info.conversationId, "conversationId") : null, join(runDir, "agy.debug.log"), readFileSync(join(runDir, "prompt.txt"), "utf8"));
        out = openSync(info.stdout, "wx");
        err = openSync(info.stderr, "wx");
        child = spawn(text(exe, "执行器命令"), argv, {
            cwd: snap.sourceRoot,
            detached: true,
            stdio: ["ignore", out, err],
            env: { ...process.env, TASK_ID: id, TASK_ROOT: snap.sourceRoot, TASK_TOOL_CLI: toolCli() },
        });
        info.executorPid = child.pid ?? null;
        info.state = "running";
        save();
        sessionTimer = setInterval(guarded(pollSession), 100);
        budget = setTimeout(guarded(() => {
            info.budgetReached = true;
            info.budgetMessage = "预算到点；现场和进程保留，协调者检查阶段进度";
            save();
        }), snap.config.budgetMinutes * 60_000);
        progress = setInterval(guarded(() => {
            const wt = worktree(ctx, snap);
            info.progressAt = new Date().toISOString();
            if (existsSync(wt))
                info.lastHead = git(wt, "rev-parse", "HEAD");
            save();
        }), snap.config.progressMinutes * 60_000);
        if (snap.config.hardTimeoutMinutes > 0)
            hard = setTimeout(guarded(() => {
                info.hardTimeout = true;
                terminate();
                save();
            }), snap.config.hardTimeoutMinutes * 60_000);
        const exit = await new Promise((resolve) => {
            child.once("error", (error) => resolve({ exitCode: null, signal: null, error: error.message }));
            child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
        });
        Object.assign(info, exit);
        if (sessionError)
            throw sessionError;
        pollSession();
        check(!exit.error, `执行器启动失败：${exit.error}`);
        check(exit.exitCode === 0 && !info.hardTimeout, `执行器退出码 ${exit.exitCode}，信号 ${exit.signal ?? "无"}`);
        const result = agyResult(info.stdout);
        if (info.conversationId)
            check(result.conversation_id === info.conversationId, "最终输出返回了不同会话，拒绝替换原会话");
        info.conversationId = result.conversation_id;
        info.sessionSource ??= "final-json";
        if (!readSession())
            info.sessionWarning = "未识别启动日志会话格式；本次使用最终 JSON 登记";
        const wt = worktree(ctx, snap);
        check(existsSync(wt), "执行器结束但任务树缺失");
        info.taskStatus = readTask(wt, ctx.cfg, id).status;
        check(["待验收", "受阻"].includes(info.taskStatus), "执行器结束但任务没有交付或登记受阻");
        info.lastHead = git(wt, "rev-parse", "HEAD");
        info.state = "completed";
    }
    catch (e) {
        info.state = info.hardTimeout || info.stopRequested ? "interrupted" : "failed";
        info.error = errorMessage(e);
        // A failed output can still carry the session identifier needed for recovery.
        if (existsSync(info.stdout)) {
            try {
                const result = JSON.parse(readFileSync(info.stdout, "utf8"));
                if (typeof result === "object" &&
                    result !== null &&
                    "conversation_id" in result &&
                    typeof result.conversation_id === "string" &&
                    result.conversation_id &&
                    !/[\s\0]/.test(result.conversation_id)) {
                    info.reportedConversationId = result.conversation_id;
                    if (!info.resume && !info.conversationId)
                        info.conversationId = result.conversation_id;
                }
            }
            catch (parseError) {
                info.outputError = errorMessage(parseError);
            }
        }
        try {
            markInterrupted(ctx, snap, `执行中断：${errorMessage(e)}；日志 ${relative(ctx.mainRoot, runDir)}`);
        }
        catch (recordError) {
            info.recordError = errorMessage(recordError);
        }
        process.exitCode = 1;
    }
    finally {
        clearTimeout(budget);
        clearInterval(progress);
        clearTimeout(hard);
        clearInterval(sessionTimer);
        if (groupAlive(child?.pid))
            terminate();
        await termination;
        if (cleanupError) {
            info.state = "failed";
            info.error = `执行器后代收尾失败：${errorMessage(cleanupError)}`;
            process.exitCode = 1;
        }
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
        if (out !== undefined)
            closeSync(out);
        if (err !== undefined)
            closeSync(err);
        info.endedAt = new Date().toISOString();
        save();
    }
    return info;
}
function assertClean(wt) {
    const flags = execFileSync("git", ["ls-files", "-v", "-z"], { cwd: wt, encoding: "utf8" }).split("\0").filter(Boolean);
    check(!flags.some((entry) => /^[a-zS]/.test(entry)), "Git 索引存在忽略工作副本的标记，先取消 assume-unchanged 或 skip-worktree");
    check(git(wt, "status", "--porcelain") === "", "工作树有未提交或暂存内容，不能验证、验收或登记返工");
}
function delivery(ctx, snap) {
    const wt = worktree(ctx, snap);
    check(existsSync(wt), "交付工作树缺失");
    check(git(wt, "branch", "--show-current") === snap.spec.branch, "交付分支不符");
    const task = checkDefinition(ctx, snap, wt);
    check(task.status === "待验收", "任务必须处于待验收");
    assertClean(wt);
    checkInputs(wt, snap.spec);
    const commit = git(wt, "rev-parse", "HEAD");
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", snap.base, commit], { cwd: wt });
    check(ancestor.status === 0, "交付提交不是固定起点的后续版本，先确认变基后的任务基准");
    const changed = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${snap.base}..${commit}`], {
        cwd: wt,
        encoding: "utf8",
    })
        .split("\0")
        .filter(Boolean);
    const forbidden = changed.filter((path) => !snap.spec.writable.includes(path));
    if (forbidden.length) {
        const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
        const range = `${snap.base}..${commit}`;
        const details = forbidden.map((path) => {
            const commits = git(wt, "log", "--full-history", "--no-renames", "--format=%H", range, "--", path);
            return `改动超出白名单：${JSON.stringify(path)}；相关提交：${commits.split("\n").join("、")}；查看：git -C ${quote(wt)} log --full-history --no-renames --oneline ${quote(range)} -- ${quote(path)}`;
        });
        throw new Error(details.join("\n"));
    }
    for (const path of snap.spec.writable)
        safePath(wt, path);
    return { wt, task, commit, changed };
}
export async function verify(ctx, id) {
    return lock(ctx, id, async () => {
        noRunning(ctx, id);
        const snap = loadSnapshot(ctx, id), directory = nonce(), output = join(control(ctx, id), "verifications", directory);
        mkdirSync(output, { recursive: true });
        const file = join(output, "result.json"), result = { id, passed: false, startedAt: new Date().toISOString(), definition: snap.definition, commands: [], output };
        atomic(file, result);
        atomic(join(control(ctx, id), "latest-verify.json"), { file });
        try {
            const { wt, commit, changed } = delivery(ctx, snap);
            result.commit = commit;
            result.changed = changed;
            for (const [index, entry] of snap.spec.verify.entries()) {
                const commandOutput = join(output, String(index));
                mkdirSync(commandOutput);
                const argv = entry.argv.map((arg) => arg.replaceAll("{output}", commandOutput));
                const stdout = join(output, `${index}.stdout.log`), stderr = join(output, `${index}.stderr.log`);
                const out = openSync(stdout, "wx"), err = openSync(stderr, "wx");
                let run;
                try {
                    run = await runCommand(argv, wt, { ...process.env, TASK_VERIFY_OUTPUT: commandOutput }, out, err, (entry.timeoutSeconds ?? 300) * 1000);
                }
                finally {
                    closeSync(out);
                    closeSync(err);
                }
                result.commands.push({
                    name: entry.name,
                    argv,
                    exitCode: run.exitCode,
                    signal: run.signal,
                    timedOut: run.timedOut,
                    stdout,
                    stderr,
                    stdoutSha256: fingerprint(stdout),
                    stderrSha256: fingerprint(stderr),
                    error: run.error ?? null,
                });
                atomic(file, result);
                check(run.exitCode === 0 && !run.timedOut && !run.cancelled, `验证命令失败：${entry.name}；${run.timedOut ? "期限已到（超时）" : run.cancelled ? "协调者中断" : "退出码 " + run.exitCode}；错误 ${run.error ?? readFileSync(stderr, "utf8")}；记录 ${file}`);
                check(git(wt, "rev-parse", "HEAD") === commit, "验证命令改变了交付提交");
                check(git(wt, "status", "--porcelain") === "", "验证命令修改了受跟踪文件或生成未提交文件");
                checkInputs(wt, snap.spec);
            }
            result.outputs = outputManifest(output);
            result.passed = true;
        }
        catch (e) {
            result.error = errorMessage(e);
            throw new Error(`${errorMessage(e)}；验证材料 ${file}`, { cause: e });
        }
        finally {
            result.endedAt = new Date().toISOString();
            atomic(file, result);
            atomic(join(control(ctx, id), "latest-verify.json"), { file, sha256: fingerprint(file) });
        }
        return { ...result, receipt: file };
    });
}
export function rework(ctx, id, messagePath) {
    text(messagePath, "返工说明 --message-file");
    const message = readRework(inputFile(ctx, messagePath));
    return lock(ctx, id, () => {
        noRunning(ctx, id);
        const snap = loadSnapshot(ctx, id), wt = worktree(ctx, snap);
        check(existsSync(wt), "原工作树缺失，不能登记返工");
        check(git(wt, "branch", "--show-current") === snap.spec.branch, "工作树分支不符");
        const task = checkDefinition(ctx, snap, wt);
        check(["待验收", "受阻", "中断"].includes(task.status), `状态 ${task.status} 不能登记返工`);
        assertClean(wt);
        const content = record(setHeader(task.content, "状态", "返工"), `返工要求\n\n~~~json\n${JSON.stringify(message, null, 2)}\n~~~`);
        commitTask(ctx, snap, wt, content, `返工：${id}`);
        return { id, status: "返工", commit: git(wt, "rev-parse", "HEAD"), worktree: wt };
    });
}
export function accept(ctx, id, reviewPath) {
    text(reviewPath, "独立审查记录 --review");
    return lock(ctx, id, () => {
        noRunning(ctx, id);
        const snap = loadSnapshot(ctx, id), { wt, task, commit } = delivery(ctx, snap);
        const pointer = join(control(ctx, id), "latest-verify.json");
        check(existsSync(pointer), "缺少独立验证材料");
        const latest = readPointer(pointer), file = latest.file;
        const receiptFile = safePath(ctx.mainRoot, relative(ctx.mainRoot, file));
        check(fingerprint(receiptFile) === latest.sha256, "验证材料指纹变化");
        const receipt = readVerification(receiptFile);
        check(receipt.passed === true && receipt.id === id && receipt.definition === snap.definition, "独立验证未通过或材料不匹配");
        check(receipt.commit === commit, "交付提交已变化，必须重新验证");
        assertReceiptIntegrity(ctx, receipt);
        check(receipt.commands.length === snap.spec.verify.length, "验证命令记录不完整或失败");
        const reviewFile = inputFile(ctx, reviewPath);
        const review = readReview(reviewFile);
        check(review.commit === commit, "审查记录提交不匹配");
        for (const kind of ["code", ...(snap.spec.productReviewRequired === true ? ["product"] : [])]) {
            check(review[kind]?.passed === true, `缺少通过的独立 ${kind} 审查`);
            text(review[kind].reviewer, `${kind} 审查者`);
            text(review[kind].record, `${kind} 审查依据`);
        }
        commitTask(ctx, snap, wt, record(setHeader(task.content, "状态", "通过"), `协调者验收通过；被验收提交 ${commit}；验证记录 ${relative(ctx.mainRoot, receiptFile)}；审查 SHA-256 ${fingerprint(reviewFile)}`), `验收：${id}`);
        const accepted = {
            id,
            status: "通过",
            verifiedCommit: commit,
            acceptanceCommit: git(wt, "rev-parse", "HEAD"),
            receipt: receiptFile,
            receiptSha256: fingerprint(receiptFile),
            review,
            reviewSha256: fingerprint(reviewFile),
            acceptedAt: new Date().toISOString(),
        };
        atomic(join(control(ctx, id), "accepted.json"), accepted);
        return accepted;
    });
}
function outputManifest(output) {
    check(!lstatSync(output).isSymbolicLink(), "验证输出根目录不能是软链");
    const root = realpathSync(output), files = {};
    for (const dir of readdirSync(output)
        .filter((p) => /^\d+$/.test(p))
        .sort()) {
        const walk = (path) => {
            check(!lstatSync(path).isSymbolicLink() && inside(root, realpathSync(path)), "验证输出目录不能是软链或越界");
            for (const name of readdirSync(path).sort()) {
                const file = join(path, name), stat = lstatSync(file);
                check(!stat.isSymbolicLink(), "验证产物不能包含软链");
                if (stat.isDirectory())
                    walk(file);
                else {
                    check(stat.isFile(), "验证产物必须是普通文件");
                    files[relative(output, file)] = fingerprint(file);
                }
            }
        };
        walk(join(output, dir));
    }
    return files;
}
async function stopGroup(pid) {
    if (!groupAlive(pid))
        return;
    process.kill(-pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (groupAlive(pid) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
    if (groupAlive(pid))
        process.kill(-pid, "SIGKILL");
    const killedDeadline = Date.now() + 1000;
    while (groupAlive(pid) && Date.now() < killedDeadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
    check(!groupAlive(pid), "执行器进程组仍存在，拒绝释放任务");
}
async function runCommand(argv, cwd, env, out, err, timeout) {
    const child = spawn(text(argv[0], "验证命令"), argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", out, err] });
    let stopping, timedOut = false, cancelled = false;
    const terminate = () => {
        stopping ??= stopGroup(child.pid);
    };
    const stop = () => {
        cancelled = true;
        terminate();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const timer = setTimeout(() => {
        timedOut = true;
        terminate();
    }, timeout);
    let result;
    try {
        result = await new Promise((resolve) => {
            child.once("error", (error) => resolve({ exitCode: null, signal: null, error: error.message }));
            child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
        });
    }
    finally {
        clearTimeout(timer);
        if (groupAlive(child.pid))
            terminate();
        await stopping;
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
    }
    return { ...result, timedOut, cancelled };
}
