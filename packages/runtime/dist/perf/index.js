import { errText, formatTime, safeGlobalStorage } from "../util.js";
import { captureBootTrace, formatBootTrace, loadBootTraces } from "./boot.js";
import { createFrameMeter } from "./frames.js";
import { createVitalsPersist } from "./persist.js";
import { trendOf, VitalRing } from "./vitals.js";
export * from "./boot.js";
export * from "./frames.js";
export * from "./gl.js";
export * from "./persist.js";
export * from "./vitals.js";
const SPANS_KEPT = 200;
/** 存储用量是跨进程的配额查询，不便宜，只看走势：最多 60 秒读一次、页面隐藏时不读 */
const STORAGE_REFRESH_MS = 60_000;
/** 内置指标名与 JSONL 行字段：宿主指标不得占用，否则覆盖内置读数或弄坏行结构 */
const RESERVED = new Set([
    "fps",
    "hitches",
    "worstMs",
    "workMs",
    "heapMB",
    "dom",
    "storageMB",
    "longTasks",
    "longTaskMs",
    "t",
    "kind",
    "session",
]);
const MB = 1024 * 1024;
const round1 = (n) => Math.round(n * 10) / 10;
export function createPerf(o) {
    const { store, prefix } = o;
    const log = store.log("perf");
    const session = store.session;
    const storage = o.storage === undefined ? safeGlobalStorage("localStorage") : o.storage;
    const perfApi = o.performance ?? (typeof performance === "undefined" ? {} : performance);
    const clock = o.clock ?? (() => performance.now());
    const epoch = o.epoch ?? Date.now;
    const sampleMs = o.sampleMs ?? 5000;
    const bootKey = `${prefix}.boot`;
    const bootKeep = o.bootKeep ?? 5;
    const frames = createFrameMeter({
        clock,
        epoch,
        ...(o.raf ? { raf: o.raf } : {}),
        ...(o.caf ? { caf: o.caf } : {}),
    });
    const ring = new VitalRing(o.cap ?? 2048);
    const bootError = (reason) => warnOnce("启动画像读写失败（同一原因不再重复记录）", { reason });
    const persist = createVitalsPersist({
        key: `${prefix}.vitals`,
        storage,
        session,
        keepSamples: o.keepSamples ?? 120,
        sessionsKept: o.sessionsKept ?? 3,
        onError: (reason) => warnOnce("水位读写失败（同一原因不再重复记录）", { reason }),
    });
    const gauges = new Map();
    const milestones = {};
    const spans = [];
    let lastBoot = null;
    let disposed = false;
    // 诊断不能把页面搞挂，也不能每 5 秒刷一条：同一处同一原因只记一条 warn
    const reported = new Set();
    const warnOnce = (what, data) => {
        const id = `${what}|${JSON.stringify(data)}`;
        if (reported.has(id))
            return;
        reported.add(id);
        log.warn(what, data);
    };
    // ── 内置指标里需要异步或观察者的两项 ──
    let storageMB = null;
    let storageReadAt = -Infinity;
    const estimate = o.estimateStorage ??
        (typeof navigator !== "undefined" && typeof navigator.storage?.estimate === "function" ? () => navigator.storage.estimate() : null);
    const refreshStorage = () => {
        if (estimate === null)
            return;
        if (typeof document !== "undefined" && document.visibilityState === "hidden")
            return;
        const now = clock();
        if (now - storageReadAt < STORAGE_REFRESH_MS)
            return;
        storageReadAt = now;
        estimate()
            .then((e) => {
            storageMB = typeof e.usage === "number" ? round1(e.usage / MB) : null;
        })
            .catch((error) => {
            storageMB = null;
            warnOnce("读存储用量失败（storageMB 记 null）", { error: errText(error) });
        });
    };
    let longTasks = null;
    let longTaskMs = null;
    let observer = null;
    try {
        if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
            longTasks = 0;
            longTaskMs = 0;
            observer = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    longTasks = (longTasks ?? 0) + 1;
                    longTaskMs = (longTaskMs ?? 0) + e.duration;
                }
            });
            observer.observe({ type: "longtask", buffered: true });
        }
    }
    catch (error) {
        observer = null;
        longTasks = null;
        longTaskMs = null;
        warnOnce("长任务观察装不上（longTasks 记 null）", { error: errText(error) });
    }
    const readGauge = (name, read) => {
        try {
            const v = read();
            return typeof v === "number" && Number.isFinite(v) ? v : null;
        }
        catch (error) {
            warnOnce("指标读数失败（记 null）", { gauge: name, error: errText(error) });
            return null;
        }
    };
    function sampleNow() {
        const w = frames.takeWindow();
        const heap = perfApi.memory?.usedJSHeapSize;
        const v = {
            fps: w.fps,
            hitches: w.hitches,
            worstMs: w.worstMs,
            workMs: w.workMs === null ? null : round1(w.workMs),
            heapMB: typeof heap === "number" ? Math.round(heap / MB) : null,
            dom: typeof document === "undefined" ? null : document.getElementsByTagName("*").length,
            storageMB,
            longTasks,
            longTaskMs: longTaskMs === null ? null : Math.round(longTaskMs),
        };
        if (longTasks !== null) {
            longTasks = 0;
            longTaskMs = 0;
        }
        for (const [name, read] of gauges)
            v[name] = readGauge(name, read);
        const sample = { t: epoch(), v };
        ring.push(sample);
        persist.save(ring.series(), sample.t);
        refreshStorage();
        return sample;
    }
    // ── 启动画像 ──
    const entries = (type) => {
        try {
            return (perfApi.getEntriesByType?.(type) ?? []);
        }
        catch (error) {
            warnOnce("读性能条目失败（启动画像缺这部分）", { type, error: errText(error) });
            return [];
        }
    };
    function captureBoot(phase) {
        const spanMap = {};
        for (const s of spans)
            spanMap[s.name] = s.ms;
        lastBoot = captureBootTrace({
            sid: session,
            phase,
            version: o.version,
            build: o.build,
            at: epoch(),
            swControlled: typeof navigator !== "undefined" && navigator.serviceWorker?.controller != null,
            nav: entries("navigation")[0],
            resources: entries("resource"),
            spans: spanMap,
            milestones,
        }, { key: bootKey, storage, keep: bootKeep, onError: bootError });
        log.info("启动画像", { phase, nav: lastBoot.nav, res: lastBoot.res });
        return lastBoot;
    }
    // ── 导出 ──
    const trend = () => trendOf(ring.series());
    function trendLines() {
        const t = trend();
        if (t.samples === 0)
            return ["（还没有采样）"];
        const lines = [`${t.samples} 个点，跨 ${t.spanSec} 秒`];
        for (const [name, m] of Object.entries(t.metrics)) {
            if (m.first === null) {
                lines.push(`${name} 读不到`);
                continue;
            }
            lines.push(`${name} ${m.first} → ${m.last}（净增 ${m.delta}，峰值 ${m.peak} @ 第 ${m.peakAt} 秒）`);
        }
        return lines;
    }
    function othersLines() {
        const others = persist.others();
        if (others.length === 0)
            return ["（没有其他会话的记录）"];
        return others.map((x) => {
            const lastSample = x.samples[x.samples.length - 1];
            const brief = lastSample === undefined ? "" : `，最后一点 ${formatTime(lastSample.t)} ${JSON.stringify(lastSample.v)}`;
            return `会话 ${x.session}：${x.samples.length} 个点，更新于 ${formatTime(x.updatedAt)}${brief}`;
        });
    }
    function bootLines() {
        const traces = loadBootTraces(bootKey, storage, bootError);
        const list = lastBoot !== null && !traces.some((t) => t.sid === lastBoot.sid) ? [lastBoot, ...traces] : traces;
        return list.length === 0 ? ["（还没有启动画像）"] : list.slice(0, 3).flatMap(formatBootTrace);
    }
    function exportJsonl() {
        const row = (kind, fields) => JSON.stringify({ kind, ...fields });
        const rows = [row("meta", { session, version: o.version, build: o.build, sampleMs, exportedAt: epoch() }), row("trend", trend())];
        for (const s of ring.series())
            rows.push(row("vital", { t: s.t, ...s.v }));
        for (const other of persist.others())
            for (const s of other.samples)
                rows.push(row("savedVital", { session: other.session, t: s.t, ...s.v }));
        for (const t of loadBootTraces(bootKey, storage, bootError))
            rows.push(row("boot", t));
        for (const [name, ms] of Object.entries(milestones))
            rows.push(row("milestone", { name, ms }));
        for (const s of spans)
            rows.push(row("span", s));
        for (const h of frames.hitches())
            rows.push(row("hitch", h));
        return `${rows.join("\n")}\n`;
    }
    const unregister = [
        store.registerSection("启动画像", bootLines),
        store.registerSection("性能走势", trendLines),
        store.registerSection("其他会话最后的水位", othersLines),
        store.registerAppendix("性能数据（JSONL）", exportJsonl),
    ];
    // ── 运行 ──
    let timer = null;
    const onVisibility = () => {
        if (document.visibilityState === "hidden") {
            try {
                sampleNow();
            }
            catch (error) {
                log.warn("页面隐藏时补采失败", { error: errText(error) });
            }
        }
    };
    const recordSpan = (name, start) => {
        spans.push({ name, ms: Math.round(clock() - start), at: epoch() });
        if (spans.length > SPANS_KEPT)
            spans.shift();
    };
    return {
        /** 登记宿主指标；名字不得占用内置指标与 JSONL 行字段（见 RESERVED），否则抛错 */
        registerGauge(name, read) {
            if (RESERVED.has(name))
                throw new Error(`性能指标名「${name}」是保留名（内置指标或导出字段），换一个名字`);
            gauges.set(name, read);
            return () => {
                if (gauges.get(name) === read)
                    gauges.delete(name);
            };
        },
        /** 记一个时间点（距导航开始的毫秒数） */
        milestone(name) {
            milestones[name] = Math.round(clock());
            log.debug("时间点", { name, ms: milestones[name] });
        },
        span(name, fn) {
            const start = clock();
            try {
                return fn();
            }
            finally {
                recordSpan(name, start);
            }
        },
        async spanAsync(name, work) {
            const start = clock();
            try {
                return await work;
            }
            finally {
                recordSpan(name, start);
            }
        },
        frameStart: frames.frameStart,
        frameEnd: frames.frameEnd,
        sampleNow,
        series: () => ring.series(),
        trend,
        captureBoot,
        exportJsonl,
        start() {
            if (disposed)
                throw new Error("性能采集已 dispose（导出摘要已注销），不能再 start；需要时重新 createPerf");
            if (timer !== null)
                return;
            sampleNow();
            timer = setInterval(() => {
                try {
                    sampleNow();
                }
                catch (error) {
                    log.warn("采样失败", { error: errText(error) });
                }
            }, sampleMs);
            frames.startAuto();
            if (typeof document !== "undefined")
                document.addEventListener("visibilitychange", onVisibility);
        },
        dispose() {
            disposed = true;
            if (timer !== null)
                clearInterval(timer);
            timer = null;
            frames.stopAuto();
            observer?.disconnect();
            if (typeof document !== "undefined")
                document.removeEventListener("visibilitychange", onVisibility);
            for (const off of unregister)
                off();
        },
    };
}
