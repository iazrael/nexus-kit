const WINDOW_MS = 60_000;
function describeReason(reason) {
    if (reason instanceof Error)
        return reason.message;
    if (typeof reason === "string")
        return reason;
    try {
        return JSON.stringify(reason) ?? String(reason);
    }
    catch {
        return String(reason);
    }
}
/** 返回注销函数 */
export function captureGlobalErrors(store, options = {}) {
    if (typeof window === "undefined")
        return () => undefined;
    const log = store.log("error");
    const clock = options.clock ?? Date.now;
    const maxPerMinute = options.maxPerMinute ?? 20;
    /** 本窗口已记录的消息 → 之后又重复的次数 */
    const seen = new Map();
    let windowStart = clock();
    let inWindow = 0;
    let suppressed = 0;
    function record(message, data) {
        const now = clock();
        if (now - windowStart >= WINDOW_MS) {
            for (const [m, repeated] of seen)
                if (repeated > 0)
                    log.warn(`上一分钟「${m}」又重复了 ${repeated} 次`);
            if (suppressed > 0)
                log.warn(`上一分钟有 ${suppressed} 条未捕获异常超出记录上限，未逐条记录`);
            seen.clear();
            windowStart = now;
            inWindow = 0;
            suppressed = 0;
        }
        const repeated = seen.get(message);
        if (repeated !== undefined) {
            seen.set(message, repeated + 1);
            return;
        }
        if (inWindow >= maxPerMinute) {
            suppressed++;
            return;
        }
        inWindow++;
        seen.set(message, 0);
        log.error(message, data);
    }
    const onError = (event) => {
        const at = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined;
        record(`未捕获异常：${event.message || describeReason(event.error)}`, {
            ...(event.error !== undefined && event.error !== null ? { error: event.error } : {}),
            ...(at === undefined ? {} : { at }),
        });
    };
    const onRejection = (event) => {
        const reason = event.reason;
        record(`未处理的 Promise 拒绝：${describeReason(reason)}`, reason instanceof Error ? { error: reason } : {});
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
    };
}
