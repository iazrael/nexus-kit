import { existsSync, readdirSync } from "node:fs";
import { relative, join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { context, settleRun } from "./runtime.js";
import { idOf } from "./definition.js";
import { readRun, readRunPointer } from "./records.js";
import { check, safePath, errorMessage, maxMinutes, printable } from "./validation.js";
const usage = "用法：task watch <任务标识...> | --all [--timeout-minutes 45] [--poll-ms 5000]\n协调者在当前回合前台运行，--timeout-minutes 取小于宿主单条命令上限的值（如 9）；退出 0 全部结束，退出 3 观察超时、再跑一轮。\n宿主一轮结束后不保证唤醒会话，也不保证保留后台进程；取消观察不会终止执行器。";
function line(id, sample) {
    if (!sample)
        return `${id}: 未产生运行记录`;
    const info = sample.info;
    return `${id} run=${sample.directory}: state=${printable(info.state)} reason=${printable(info.endReason ?? "未分类")} exitCode=${printable(info.exitCode ?? "-")} signal=${printable(info.signal ?? "-")} ${info.endReason === "needs_approval" ? "【核对授权后 task resume 原会话续跑】" : ""}任务状态=${printable(info.taskStatus ?? "未记录")} 提交=${printable(info.lastHead?.slice(0, 8) ?? "-")} ${printable(info.endMessage ?? info.error)}${info.notificationError ? " 流水写入失败：" + printable(info.notificationError) : ""}`;
}
export async function watchCommand(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            all: { type: "boolean" },
            help: { type: "boolean", short: "h" },
            "timeout-minutes": { type: "string" },
            "poll-ms": { type: "string" },
        },
    });
    if (values.help) {
        console.log(usage);
        return 0;
    }
    check(values.all ? positionals.length === 0 : positionals.length > 0, usage);
    const timeout = Number(values["timeout-minutes"] ?? 45), poll = Number(values["poll-ms"] ?? 5000);
    check(Number.isFinite(timeout) && timeout >= 0.001 && timeout <= maxMinutes, "timeout-minutes 必须在 0.001 到定时器上限之间");
    check(Number.isSafeInteger(poll) && poll >= 10 && poll <= 60_000, "poll-ms 必须是 10 到 60000 的整数");
    const ctx = context(), control = safePath(ctx.mainRoot, ctx.cfg.controlDir);
    const tracked = new Set(positionals.map(idOf)), samples = new Map(), completed = new Map(), errors = new Map();
    const archived = new Set(), active = new Map();
    const abort = new AbortController();
    let cancelled = 0;
    const interrupt = () => {
        cancelled = 130;
        abort.abort();
    }, terminate = () => {
        cancelled = 143;
        abort.abort();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    const watchStarted = Date.now(), deadline = watchStarted + timeout * 60_000;
    const folder = (id) => safePath(ctx.mainRoot, `${ctx.cfg.controlDir}/${id}`);
    const readAt = (id, directory) => {
        check(/^[a-z0-9-]+$/.test(directory), "运行目录标识不合法");
        const path = safePath(ctx.mainRoot, relative(ctx.mainRoot, join(folder(id), "runs", directory, "run.json"))), info = readRun(path);
        check(info.id === id, "运行记录任务标识不一致");
        check(Number.isFinite(Date.parse(info.startedAt)) && (!info.endedAt || Number.isFinite(Date.parse(info.endedAt))), "运行时间不合法");
        check(!info.endedAt || ["completed", "failed", "interrupted"].includes(info.state), "结束时间与运行状态矛盾");
        return { directory, info: settleRun(info) };
    };
    // An orphaned record never gets endedAt; settleRun already marked it interrupted.
    const ended = (info) => Boolean(info.endedAt) || info.state === "interrupted";
    const read = (id) => {
        const pointer = safePath(ctx.mainRoot, `${ctx.cfg.controlDir}/${id}/latest.json`);
        return existsSync(pointer) ? readAt(id, readRunPointer(pointer)) : null;
    };
    const collect = (id) => {
        const sample = read(id), before = completed.size;
        let pending = tracked.has(id) && !sample;
        const runs = safePath(ctx.mainRoot, relative(ctx.mainRoot, join(folder(id), "runs")));
        const directories = existsSync(runs)
            ? readdirSync(runs, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
            : [];
        for (const directory of directories) {
            const key = id + ":" + directory;
            if (archived.has(key))
                continue;
            const recordFile = safePath(ctx.mainRoot, relative(ctx.mainRoot, join(runs, directory, "run.json")));
            if (!existsSync(recordFile)) {
                active.set(key, `${id} run=${directory}: 运行记录准备中`);
                pending = true;
                continue;
            }
            const run = directory === sample?.directory ? sample : readAt(id, directory);
            const relevant = active.has(key) ||
                Date.parse(run.info.endedAt ?? run.info.startedAt) >= watchStarted ||
                (directory === sample?.directory && (tracked.has(id) || !run.info.endedAt));
            if (ended(run.info)) {
                archived.add(key);
                active.delete(key);
                if (relevant) {
                    const text = line(id, run);
                    completed.set(key, text);
                    console.log("[ended] " + text);
                }
            }
            else if (relevant) {
                active.set(key, line(id, run));
                pending = true;
            }
        }
        // The latest pointer is authoritative even while a new run directory is not listed yet.
        if (sample && !ended(sample.info)) {
            active.set(id + ":" + sample.directory, line(id, sample));
            pending = true;
        }
        return { sample, pending, added: completed.size > before };
    };
    const summary = () => {
        console.log("=== 任务观察结果 ===");
        for (const text of completed.values())
            console.log(text);
        for (const text of active.values())
            console.log(text);
        for (const id of tracked)
            if (!samples.get(id))
                console.log(line(id, null));
        if (!tracked.size)
            console.log("没有正在运行的任务");
    };
    console.error("[task:watch] 开始观察；取消观察不会停止执行器");
    try {
        while (true) {
            if (cancelled) {
                summary();
                return cancelled;
            }
            const candidates = new Set(tracked);
            if (values.all && existsSync(control)) {
                for (const entry of readdirSync(control, { withFileTypes: true })) {
                    if (entry.isDirectory() &&
                        /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.name) &&
                        entry.name.length <= 64 &&
                        (existsSync(join(control, entry.name, "latest.json")) || existsSync(join(control, entry.name, "runs"))))
                        candidates.add(entry.name);
                }
            }
            let pending = false;
            for (const id of candidates) {
                try {
                    const current = collect(id);
                    errors.delete(id);
                    if (tracked.has(id) || current.pending || current.added) {
                        tracked.add(id);
                        samples.set(id, current.sample);
                        pending ||= current.pending;
                    }
                }
                catch (error) {
                    tracked.add(id);
                    const count = (errors.get(id) ?? 0) + 1;
                    errors.set(id, count);
                    pending = true;
                    console.error(`[task:watch] ${id} 记录读取失败（${count}/3）：${errorMessage(error)}`);
                    if (count >= 3) {
                        summary();
                        return 1;
                    }
                }
            }
            if (!pending) {
                summary();
                return 0;
            }
            if (Date.now() >= deadline) {
                summary();
                console.error("[task:watch] 观察超时，尚有任务未结束或记录未就绪；现场保留");
                return 3;
            }
            try {
                await delay(Math.min(poll, Math.max(1, deadline - Date.now())), undefined, { signal: abort.signal });
            }
            catch (error) {
                if (!cancelled)
                    throw error;
            }
        }
    }
    finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
    }
}
