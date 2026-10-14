import { errText, formatTime, safeGlobalStorage } from "../util.js";
/** 会话表保留的其他会话行数（本局与仍有心跳的不计） */
const KEEP_OTHERS = 5;
/** 存活锁查询的等待上限：超时按心跳规则落定，判词不永远悬着 */
const LOCK_QUERY_TIMEOUT_MS = 3000;
function isRow(v) {
    if (typeof v !== "object" || v === null)
        return false;
    const o = v;
    return typeof o.openAt === "number" && typeof o.aliveAt === "number" && (o.exitAt === undefined || typeof o.exitAt === "number");
}
/** 会话表原文 → 表；null = 没有；"bad" = 损坏或结构不对 */
function parseTable(raw) {
    if (raw === null)
        return null;
    try {
        const v = JSON.parse(raw);
        if (typeof v !== "object" || v === null)
            return "bad";
        const sessions = v.sessions;
        if (typeof sessions !== "object" || sessions === null)
            return "bad";
        const out = {};
        for (const [id, row] of Object.entries(sessions)) {
            if (!isRow(row))
                return "bad";
            out[id] = row;
        }
        return out;
    }
    catch {
        return "bad";
    }
}
/** 会话表原文 → 上一局判词（纯函数）。excludeSession 是本局（启动早期表里还没有本局，可不传） */
export function interpretLastExit(raw, now, heartbeatMs, excludeSession, 
/** 仍在运行的会话（Web Locks 查得）；不知道时不传，退回心跳规则 */
running) {
    const table = parseTable(raw);
    if (table === "bad")
        return { verdict: { kind: "unknown", reason: "会话表损坏" }, previousSession: null };
    const others = Object.entries(table ?? {}).filter(([id]) => id !== excludeSession);
    if (others.length === 0)
        return { verdict: { kind: "first-run" }, previousSession: null };
    const [id, row] = others.reduce((a, b) => (b[1].openAt > a[1].openAt ? b : a));
    if (row.exitAt !== undefined)
        return { verdict: { kind: "clean", endedAt: row.exitAt }, previousSession: id };
    if (running !== undefined) {
        if (running.has(id))
            return { verdict: { kind: "unknown", reason: "上一会话仍开在其他窗口里" }, previousSession: id };
        return { verdict: { kind: "abrupt", lastAliveAt: row.aliveAt }, previousSession: id };
    }
    if (now - row.aliveAt <= heartbeatMs * 2) {
        const ago = Math.round((now - row.aliveAt) / 1000);
        return {
            verdict: { kind: "unknown", reason: `上一会话 ${ago} 秒前还有心跳，可能仍开在其他窗口里` },
            previousSession: id,
        };
    }
    return { verdict: { kind: "abrupt", lastAliveAt: row.aliveAt }, previousSession: id };
}
function defaultLocks() {
    try {
        const locks = globalThis.navigator?.locks;
        return locks === undefined ? null : locks;
    }
    catch {
        return null;
    }
}
const VERDICT_TEXT = {
    "first-run": "首次启动（没有上一局记录）",
    clean: "上一局正常关闭",
    abrupt: "疑似异常退出（没有正常告别记录）",
    unknown: "无法判定",
};
/** 启动早期调用（渲染之前）：得出上局判词、写本局一行、挂告别与心跳 */
export function startForensics(options) {
    const { prefix, store } = options;
    const storage = options.storage === undefined ? safeGlobalStorage("localStorage") : options.storage;
    const clock = options.clock ?? Date.now;
    const heartbeatMs = options.heartbeatMs ?? 30_000;
    const log = store.log("lifecycle");
    const key = `${prefix}.sessions`;
    const me = store.session;
    const startedAt = clock();
    const failedOnce = new Set();
    const locks = options.locks === undefined ? defaultLocks() : options.locks;
    const lockPrefix = `${prefix}.alive.`;
    // 本局持有自己的存活锁：回调返回的 Promise 不结束锁就一直在。pagehide 时主动放掉（页面在离开或进往返
    // 缓存，都不算「还在运行」），从往返缓存恢复时重新拿。拿锁失败不影响页面
    let releaseLock = null;
    const holdLock = () => {
        if (locks === null || releaseLock !== null)
            return;
        void locks.request(`${lockPrefix}${me}`, () => new Promise((resolve) => (releaseLock = resolve))).catch(() => undefined);
    };
    const dropLock = () => {
        releaseLock?.();
        releaseLock = null;
    };
    holdLock();
    /** 读整表 → 改本行 → 写回；顺带裁掉旧行。同一失败原因只记第一次 */
    const update = (what, change) => {
        if (storage === null)
            return;
        try {
            const parsed = parseTable(storage.getItem(key));
            const table = parsed === null || parsed === "bad" ? {} : parsed;
            const now = clock();
            table[me] = change(table[me], now);
            const others = Object.entries(table)
                .filter(([id]) => id !== me)
                .sort((a, b) => b[1].openAt - a[1].openAt);
            const kept = { [me]: table[me] };
            others.forEach(([id, row], i) => {
                if (i < KEEP_OTHERS || (row.exitAt === undefined && now - row.aliveAt <= heartbeatMs * 2))
                    kept[id] = row;
            });
            storage.setItem(key, JSON.stringify({ v: 1, sessions: kept }));
        }
        catch (error) {
            // 按失败原因去重：存储满时开启、心跳、告别都会失败，原因相同只记一次
            const reason = errText(error);
            if (failedOnce.has(reason))
                return;
            failedOnce.add(reason);
            log.warn("取证会话表写入失败（同一原因不再重复记录）", { what, error: reason });
        }
    };
    // ── 判词：读表在写本行之前；Web Locks 查询落定后再算一次 ──
    let raw = null;
    let readError = storage === null ? "存储不可用" : null;
    if (storage !== null) {
        try {
            raw = storage.getItem(key);
        }
        catch (error) {
            readError = `读取会话表失败：${errText(error)}`;
        }
    }
    const judge = (running) => {
        if (readError !== null)
            return { verdict: { kind: "unknown", reason: readError }, previousSession: null };
        const r = interpretLastExit(raw, startedAt, heartbeatMs, me, running);
        if (r.verdict.kind === "abrupt" && r.previousSession !== null) {
            const lastLog = store.lastEntryAt(r.previousSession);
            if (lastLog !== null)
                r.verdict = { kind: "abrupt", lastAliveAt: Math.max(lastLog, r.verdict.lastAliveAt) };
        }
        return r;
    };
    let result = judge();
    const announce = () => {
        const v = result.verdict;
        if (v.kind === "abrupt")
            log.warn("上一局疑似异常退出", { previousSession: result.previousSession, lastAliveAt: v.lastAliveAt });
        else
            log.info("上一局收场", { verdict: v.kind, previousSession: result.previousSession });
        return v;
    };
    const settled = locks === null || readError !== null
        ? Promise.resolve(announce())
        : Promise.race([
            locks.query(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`${LOCK_QUERY_TIMEOUT_MS}ms 未返回`)), LOCK_QUERY_TIMEOUT_MS)),
        ]).then((snapshot) => {
            const running = new Set((snapshot.held ?? []).flatMap((l) => (l.name?.startsWith(lockPrefix) === true ? [l.name.slice(lockPrefix.length)] : [])));
            running.delete(me);
            result = judge(running);
            return announce();
        }, (error) => {
            log.warn("查询存活锁失败，按心跳规则判定", { error: errText(error) });
            return announce();
        });
    const detail = () => {
        const verdict = result.verdict;
        const lines = [`判词：${VERDICT_TEXT[verdict.kind]}`];
        if (result.previousSession !== null)
            lines.push(`上一会话：${result.previousSession}`);
        if (verdict.kind === "clean")
            lines.push(`关闭时刻：${formatTime(verdict.endedAt)}`);
        if (verdict.kind === "abrupt") {
            const gap = Math.round((startedAt - verdict.lastAliveAt) / 1000);
            lines.push(`最后有动静：${formatTime(verdict.lastAliveAt)}（距本次启动 ${gap} 秒）`);
            lines.push("说明：没有告别只说明缺少正常关闭的凭证，不能证明被系统杀掉或崩溃；用户从多任务里划掉也是这样。");
        }
        if (verdict.kind === "unknown")
            lines.push(`原因：${verdict.reason}`);
        return lines;
    };
    const offSection = store.registerSection("上次退出", detail);
    // ── 本局 ──
    update("open", (_row, now) => ({ openAt: now, aliveAt: now }));
    const onPageHide = () => {
        dropLock();
        update("exit", (row, now) => ({ openAt: row?.openAt ?? startedAt, aliveAt: now, exitAt: now }));
        log.info("页面告别");
        store.flush();
    };
    const onPageShow = (event) => {
        if (!event.persisted)
            return;
        holdLock();
        update("revive", (row, now) => ({ openAt: row?.openAt ?? startedAt, aliveAt: now }));
        log.info("从往返缓存恢复，同一会话继续");
    };
    const alive = () => update("alive", (row, now) => ({ ...(row ?? { openAt: startedAt }), aliveAt: now }));
    const onVisibility = () => {
        if (document.visibilityState === "hidden")
            alive();
    };
    const heartbeat = setInterval(alive, heartbeatMs);
    if (typeof window !== "undefined") {
        window.addEventListener("pagehide", onPageHide);
        window.addEventListener("pageshow", onPageShow);
    }
    if (typeof document !== "undefined")
        document.addEventListener("visibilitychange", onVisibility);
    return {
        get verdict() {
            return result.verdict;
        },
        settled,
        get previousSession() {
            return result.previousSession;
        },
        dispose() {
            clearInterval(heartbeat);
            dropLock();
            offSection();
            if (typeof window !== "undefined") {
                window.removeEventListener("pagehide", onPageHide);
                window.removeEventListener("pageshow", onPageShow);
            }
            if (typeof document !== "undefined")
                document.removeEventListener("visibilitychange", onVisibility);
        },
    };
}
