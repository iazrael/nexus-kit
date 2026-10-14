/**
 * 水位跨会话保留：内存里的长线刷新即失，而「上一局最后几分钟怎么了」正是排查闪退最需要的。localStorage
 * `<key>` 存一张会话表，每个会话一行 { updatedAt, samples }，只留最后 keepSamples 个点、最近 sessionsKept 个会话
 * （含本局）。每次写都是「读整表 → 只改本行 → 写回」：同一应用开在多个窗口时各写各的行，互不覆盖。
 * 上一局疑似异常时，它最后保存的那段水位就是现场；导出时连同会话号一起列出。
 * 坏数据只丢坏行；读写失败不抛，同一原因只经 onError 报一次（诊断不能把页面搞挂，也不能每 5 秒刷一条）。
 */
import { errText } from "../util.js";
function isSample(v) {
    if (typeof v !== "object" || v === null)
        return false;
    const o = v;
    if (typeof o.t !== "number" || typeof o.v !== "object" || o.v === null)
        return false;
    return Object.values(o.v).every((x) => x === null || typeof x === "number");
}
function readTable(raw) {
    if (raw === null)
        return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        // 交给调用方报一次原因；按空表处理，下次写盘覆盖掉坏数据
        throw new Error("水位记录损坏（不是合法 JSON），整表丢弃");
    }
    const sessions = typeof parsed === "object" && parsed !== null ? parsed.sessions : null;
    if (typeof sessions !== "object" || sessions === null)
        return {};
    const out = {};
    for (const [id, row] of Object.entries(sessions)) {
        if (typeof row !== "object" || row === null)
            continue;
        const r = row;
        if (typeof r.updatedAt === "number" && Array.isArray(r.samples) && r.samples.every(isSample)) {
            out[id] = { updatedAt: r.updatedAt, samples: r.samples };
        }
    }
    return out;
}
export function createVitalsPersist(options) {
    const { key, storage, session } = options;
    const keepSamples = options.keepSamples ?? 120;
    const sessionsKept = options.sessionsKept ?? 3;
    const reported = new Set();
    const fail = (error) => {
        const reason = errText(error);
        if (reported.has(reason))
            return;
        reported.add(reason);
        options.onError?.(reason);
    };
    const read = () => {
        if (storage === null)
            return {};
        try {
            return readTable(storage.getItem(key));
        }
        catch (error) {
            fail(error);
            return {};
        }
    };
    return {
        /** 本局最新的长线写盘（只留最后 keepSamples 个点） */
        save(series, now) {
            if (storage === null)
                return;
            const table = read();
            table[session] = { updatedAt: now, samples: series.slice(-keepSamples) };
            // 本局 + 最近更新的 sessionsKept - 1 个其他会话
            const others = Object.entries(table)
                .filter(([id]) => id !== session)
                .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
                .slice(0, Math.max(0, sessionsKept - 1));
            const trimmed = [[session, table[session]], ...others];
            try {
                storage.setItem(key, JSON.stringify({ v: 1, sessions: Object.fromEntries(trimmed) }));
            }
            catch (error) {
                fail(error);
            }
        },
        /** 其他会话（上一局、别的窗口）保存的水位，最近更新的在前 */
        others() {
            return Object.entries(read())
                .filter(([id]) => id !== session)
                .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
                .map(([id, row]) => ({ session: id, updatedAt: row.updatedAt, samples: row.samples }));
        },
    };
}
