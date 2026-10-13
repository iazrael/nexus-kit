function runtimePath(url, origin, prefixes) {
    let path = url;
    if (/^https?:\/\//u.test(url)) {
        if (!url.startsWith(`${origin}/`))
            return null;
        path = url.slice(origin.length);
    }
    path = path.split("?")[0].split("#")[0];
    return prefixes.some((p) => path.startsWith(p)) ? path : null;
}
/** 汇总要补存的站内路径（去重、排序、只收同源且落在运行时前缀内的） */
export function collectWarmUrls(entries, origin, opts) {
    const out = new Set();
    const add = (raw) => {
        const path = runtimePath(raw, origin, opts.prefixes);
        if (path === null)
            return;
        out.add(path);
        for (const derived of opts.expand?.(path) ?? []) {
            const d = runtimePath(derived, origin, opts.prefixes);
            if (d !== null)
                out.add(d);
        }
    };
    for (const e of entries)
        add(e.name);
    for (const r of opts.extra ?? [])
        add(r);
    return [...out].sort();
}
/** 补存回执超时：workbox 按条 Promise.all 聚合，任一条取不到整批不回执——超时不代表全失败 */
export const WARM_ACK_TIMEOUT_MS = 60_000;
/**
 * 把清单交 SW 补存；成功 resolve（宿主据此提示「已可离线使用」），失败/超时 reject。
 * 补存失败不影响使用，只是那次断网可能打不开——调用方记日志即可，不要对用户承诺。
 */
export async function warmRuntimeCache(urls, logger) {
    const t0 = performance.now();
    const reg = await navigator.serviceWorker.ready;
    const sw = reg.active;
    if (sw === null)
        throw new Error("SW 未激活");
    logger?.info("离线补缓存：本会话已下载资源交 SW 补存", { urls: urls.length });
    await new Promise((resolve, reject) => {
        const ch = new MessageChannel();
        const timer = setTimeout(() => reject(new Error("补缓存回执超时（个别条目可能取不到，其余多已补存）")), WARM_ACK_TIMEOUT_MS);
        ch.port1.onmessage = () => {
            clearTimeout(timer);
            resolve();
        };
        sw.postMessage({ type: "CACHE_URLS", payload: { urlsToCache: [...urls] } }, [ch.port2]);
    });
    logger?.info("离线补缓存完成", { urls: urls.length, ms: Math.round(performance.now() - t0) });
}
