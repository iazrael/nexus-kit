import { errText, scrubUrl } from "../util.js";
const MB = 1024 * 1024;
const round1 = (n) => Math.round(n * 10) / 10;
export function createImageCache(options) {
    const { loader, log } = options;
    if (!(options.budgetMB >= 0))
        throw new RangeError(`图像缓存预算须为非负数：${String(options.budgetMB)}`);
    const budgetBytes = options.budgetMB * MB;
    const fetchImage = options.fetch ?? ((url) => globalThis.fetch(url));
    const decode = options.decode ?? ((blob) => createImageBitmap(blob));
    const entries = new Map();
    /** 已解码、引用为零的图；Map 的插入顺序即最久没用在前 */
    const lru = new Map();
    let bytes = 0;
    let peakBytes = 0;
    let hits = 0;
    let misses = 0;
    let evictions = 0;
    let disposed = false;
    function evict(url, e) {
        lru.delete(url);
        entries.delete(url);
        e.bitmap?.close();
        bytes -= e.bytes;
        evictions++;
        try {
            options.onEvict?.(url);
        }
        catch (error) {
            log?.warn("宿主的淘汰回调出错（位图已关闭，不影响缓存）", { url: scrubUrl(url), error: errText(error) });
        }
    }
    function enforce() {
        for (const [url, e] of lru) {
            if (bytes <= budgetBytes)
                return;
            evict(url, e);
        }
        if (bytes > budgetBytes)
            log?.debug("解码位图超预算，剩下的都在被引用", { MB: round1(bytes / MB), budgetMB: options.budgetMB });
    }
    /** 引用归零的已解码图进 LRU（最久没用排最前），再按预算淘汰 */
    function park(url, e) {
        if (e.refs !== 0 || e.bitmap === null || entries.get(url) !== e)
            return;
        lru.set(url, e);
        enforce();
    }
    async function load(url, entry) {
        let bitmap;
        try {
            const res = await fetchImage(url);
            if (!res.ok) {
                // 不读的响应体要取消，否则连接要等垃圾回收才放回，白占一个并发位
                void res.body?.cancel().catch(() => undefined);
                throw new Error(`加载图像失败：HTTP ${res.status} ${scrubUrl(url)}`);
            }
            bitmap = await decode(await res.blob());
        }
        catch (error) {
            if (entries.get(url) === entry)
                entries.delete(url);
            log?.warn("图像加载失败", { url: scrubUrl(url), error: errText(error) });
            throw error;
        }
        if (entries.get(url) !== entry) {
            // 加载途中缓存已 dispose：没人管这张图了，立即关掉
            bitmap.close();
            throw new Error(`图像缓存已 dispose：${scrubUrl(url)}`);
        }
        entry.bitmap = bitmap;
        entry.bytes = bitmap.width * bitmap.height * 4;
        bytes += entry.bytes;
        if (bytes > peakBytes)
            peakBytes = bytes;
        // 调用方都取消了、请求已在飞：下完照样留着（引用为零进 LRU，可被淘汰）
        park(url, entry);
        enforce();
        return bitmap;
    }
    const unregister = options.perf
        ? [
            options.perf.registerGauge("assets.bitmapMB", () => round1(bytes / MB)),
            options.perf.registerGauge("assets.bitmaps", () => entries.size - [...entries.values()].filter((e) => e.bitmap === null).length),
        ]
        : [];
    return {
        /** 取一张图并占一个引用；成功后用完调 release */
        acquire(url, priority, opts = {}) {
            if (disposed)
                return Promise.reject(new Error(`图像缓存已 dispose：${scrubUrl(url)}`));
            // 已取消的信号：命中也不给、不占引用（调用方按取消处理，不会 release）
            if (opts.signal?.aborted)
                return Promise.reject(opts.signal.reason ?? new DOMException("已取消", "AbortError"));
            let entry = entries.get(url);
            if (entry?.bitmap) {
                entry.refs++;
                lru.delete(url);
                hits++;
                return Promise.resolve(entry.bitmap);
            }
            if (entry === undefined) {
                entry = { refs: 0, bitmap: null, bytes: 0 };
                entries.set(url, entry);
                misses++;
            }
            const own = entry;
            own.refs++;
            return loader
                .schedule(url, priority, () => load(url, own), opts)
                .catch((error) => {
                own.refs--;
                // 全部取消、请求没发出：调度器已出队，这条空记录也撤掉
                if (own.refs === 0 && own.bitmap === null && !loader.has(url) && entries.get(url) === own)
                    entries.delete(url);
                // 解码已完成、调用方恰在拿到结果前取消：图已在内存里，引用归零就进 LRU，否则永远淘汰不掉
                park(url, own);
                throw error;
            });
        },
        /** 放回一个引用；引用为零进 LRU，超预算时可能被淘汰 */
        release(url) {
            if (disposed)
                return; // dispose 后宿主收尾时的 release 是正常的，不当成多释放
            const e = entries.get(url);
            if (e === undefined || e.bitmap === null || e.refs === 0) {
                log?.warn("多释放了一次图像（没有对应的成功 acquire）", { url: scrubUrl(url) });
                return;
            }
            e.refs--;
            park(url, e);
        },
        /** 已解码的图（不改引用、不算命中）；没有返回 undefined */
        peek: (url) => entries.get(url)?.bitmap ?? undefined,
        stats() {
            let images = 0;
            let referenced = 0;
            for (const e of entries.values()) {
                if (e.bitmap === null)
                    continue;
                images++;
                if (e.refs > 0)
                    referenced++;
            }
            return { images, referenced, bytes, peakBytes, budgetBytes, hits, misses, evictions };
        },
        /** 关掉全部位图（包括还在被引用的）、注销水位指标；之后在飞的加载下完即关，acquire 直接拒绝，release 忽略 */
        dispose() {
            disposed = true;
            for (const e of entries.values())
                e.bitmap?.close();
            entries.clear();
            lru.clear();
            bytes = 0;
            for (const off of unregister.splice(0))
                off();
        },
    };
}
