/**
 * 性能采集入口（机制见 docs/架构算法/性能采集.md）：把帧统计、水位长线、跨会话保留、启动画像拼起来，接进日志导出。
 *
 * - 采样：start 后立刻采一个基线点，之后每 sampleMs（默认 5 秒）一次；页面隐藏时补采一次。每个点 = 本区间的帧统计
 *   （fps / hitches / worstMs / workMs）+ 内置指标（heapMB 只有 Chromium、dom、storageMB、longTasks / longTaskMs
 *   只有 Chromium）+ 宿主登记的指标。读不到或读数抛错记 null，不中断采样。
 * - 每次采样后把本局长线写盘（persist.ts）：下一局（或别的窗口）能读到这一局最后的水位。
 * - milestone / span / spanAsync 记时间点与阶段耗时，captureBoot 采一条启动画像（boot.ts）。
 * - 日志导出里注册三节摘要（启动画像、性能走势、其他会话最后的水位）与「性能数据（JSONL）」附录。
 *
 * 浏览器 API 全部可注入（performance、时钟、rAF、存储），单测不碰真环境。
 */
import type { LogStore } from "../log/store.ts";
import { errText, formatTime, safeGlobalStorage, type StorageLike } from "../util.ts";
import { captureBootTrace, formatBootTrace, loadBootTraces, type BootTrace, type NavTimingLike, type ResTimingLike } from "./boot.ts";
import { createFrameMeter, type Hitch } from "./frames.ts";
import { createVitalsPersist } from "./persist.ts";
import { trendOf, VitalRing, type Trend, type VitalSample } from "./vitals.ts";

export * from "./boot.ts";
export * from "./frames.ts";
export * from "./gl.ts";
export * from "./persist.ts";
export * from "./vitals.ts";

/** performance 里用到的部分 */
export interface PerformanceLike {
  memory?: { usedJSHeapSize?: number };
  getEntriesByType?: (type: string) => unknown[];
}

export interface PerfOptions {
  /** 存储键前缀：`<prefix>.vitals`（水位）、`<prefix>.boot`（启动画像） */
  prefix: string;
  store: LogStore;
  version: string;
  build: number;
  /** 默认 localStorage */
  storage?: StorageLike | null;
  /** 采样间隔，默认 5000ms */
  sampleMs?: number;
  /** 内存长线点数，默认 2048（5 秒一点约 2.8 小时） */
  cap?: number;
  /** 每个会话写盘保留的点数，默认 120（约 10 分钟） */
  keepSamples?: number;
  /** 写盘保留的会话数（含本局），默认 3 */
  sessionsKept?: number;
  /** 启动画像保留次数，默认 5 */
  bootKeep?: number;
  /** 以下注入点默认取浏览器全局 */
  performance?: PerformanceLike;
  clock?: () => number;
  epoch?: () => number;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  /** 默认 navigator.storage.estimate */
  estimateStorage?: () => Promise<{ usage?: number }>;
}

interface SpanRecord {
  name: string;
  ms: number;
  /** 结束时的墙钟（epoch ms） */
  at: number;
}

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
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function createPerf(o: PerfOptions) {
  const { store, prefix } = o;
  const log = store.log("perf");
  const session = store.session;
  const storage = o.storage === undefined ? safeGlobalStorage("localStorage") : o.storage;
  const perfApi: PerformanceLike = o.performance ?? (typeof performance === "undefined" ? {} : (performance as unknown as PerformanceLike));
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
  const bootError = (reason: string): void => warnOnce("启动画像读写失败（同一原因不再重复记录）", { reason });
  const persist = createVitalsPersist({
    key: `${prefix}.vitals`,
    storage,
    session,
    keepSamples: o.keepSamples ?? 120,
    sessionsKept: o.sessionsKept ?? 3,
    onError: (reason) => warnOnce("水位读写失败（同一原因不再重复记录）", { reason }),
  });
  const gauges = new Map<string, () => number | null>();
  const milestones: Record<string, number> = {};
  const spans: SpanRecord[] = [];
  let lastBoot: BootTrace | null = null;
  let disposed = false;
  // 诊断不能把页面搞挂，也不能每 5 秒刷一条：同一处同一原因只记一条 warn
  const reported = new Set<string>();
  const warnOnce = (what: string, data: Record<string, unknown>): void => {
    const id = `${what}|${JSON.stringify(data)}`;
    if (reported.has(id)) return;
    reported.add(id);
    log.warn(what, data);
  };

  // ── 内置指标里需要异步或观察者的两项 ──
  let storageMB: number | null = null;
  let storageReadAt = -Infinity;
  const estimate =
    o.estimateStorage ??
    (typeof navigator !== "undefined" && typeof navigator.storage?.estimate === "function" ? () => navigator.storage.estimate() : null);
  const refreshStorage = (): void => {
    if (estimate === null) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const now = clock();
    if (now - storageReadAt < STORAGE_REFRESH_MS) return;
    storageReadAt = now;
    estimate()
      .then((e) => {
        storageMB = typeof e.usage === "number" ? round1(e.usage / MB) : null;
      })
      .catch((error: unknown) => {
        storageMB = null;
        warnOnce("读存储用量失败（storageMB 记 null）", { error: errText(error) });
      });
  };
  let longTasks: number | null = null;
  let longTaskMs: number | null = null;
  let observer: PerformanceObserver | null = null;
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
  } catch (error) {
    observer = null;
    longTasks = null;
    longTaskMs = null;
    warnOnce("长任务观察装不上（longTasks 记 null）", { error: errText(error) });
  }

  const readGauge = (name: string, read: () => number | null): number | null => {
    try {
      const v = read();
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    } catch (error) {
      warnOnce("指标读数失败（记 null）", { gauge: name, error: errText(error) });
      return null;
    }
  };

  function sampleNow(): VitalSample {
    const w = frames.takeWindow();
    const heap = perfApi.memory?.usedJSHeapSize;
    const v: Record<string, number | null> = {
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
    for (const [name, read] of gauges) v[name] = readGauge(name, read);
    const sample: VitalSample = { t: epoch(), v };
    ring.push(sample);
    persist.save(ring.series(), sample.t);
    refreshStorage();
    return sample;
  }

  // ── 启动画像 ──
  const entries = <T>(type: string): T[] => {
    try {
      return (perfApi.getEntriesByType?.(type) ?? []) as T[];
    } catch (error) {
      warnOnce("读性能条目失败（启动画像缺这部分）", { type, error: errText(error) });
      return [];
    }
  };
  function captureBoot(phase: string): BootTrace {
    const spanMap: Record<string, number> = {};
    for (const s of spans) spanMap[s.name] = s.ms;
    lastBoot = captureBootTrace(
      {
        sid: session,
        phase,
        version: o.version,
        build: o.build,
        at: epoch(),
        swControlled: typeof navigator !== "undefined" && navigator.serviceWorker?.controller != null,
        nav: entries<NavTimingLike>("navigation")[0],
        resources: entries<ResTimingLike>("resource"),
        spans: spanMap,
        milestones,
      },
      { key: bootKey, storage, keep: bootKeep, onError: bootError },
    );
    log.info("启动画像", { phase, nav: lastBoot.nav, res: lastBoot.res });
    return lastBoot;
  }

  // ── 导出 ──
  const trend = (): Trend => trendOf(ring.series());
  function trendLines(): string[] {
    const t = trend();
    if (t.samples === 0) return ["（还没有采样）"];
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
  function othersLines(): string[] {
    const others = persist.others();
    if (others.length === 0) return ["（没有其他会话的记录）"];
    return others.map((x) => {
      const lastSample = x.samples[x.samples.length - 1];
      const brief = lastSample === undefined ? "" : `，最后一点 ${formatTime(lastSample.t)} ${JSON.stringify(lastSample.v)}`;
      return `会话 ${x.session}：${x.samples.length} 个点，更新于 ${formatTime(x.updatedAt)}${brief}`;
    });
  }
  function bootLines(): string[] {
    const traces = loadBootTraces(bootKey, storage, bootError);
    const list = lastBoot !== null && !traces.some((t) => t.sid === lastBoot!.sid) ? [lastBoot, ...traces] : traces;
    return list.length === 0 ? ["（还没有启动画像）"] : list.slice(0, 3).flatMap(formatBootTrace);
  }
  function exportJsonl(): string {
    const row = (kind: string, fields: object): string => JSON.stringify({ kind, ...fields });
    const rows = [row("meta", { session, version: o.version, build: o.build, sampleMs, exportedAt: epoch() }), row("trend", trend())];
    for (const s of ring.series()) rows.push(row("vital", { t: s.t, ...s.v }));
    for (const other of persist.others())
      for (const s of other.samples) rows.push(row("savedVital", { session: other.session, t: s.t, ...s.v }));
    for (const t of loadBootTraces(bootKey, storage, bootError)) rows.push(row("boot", t));
    for (const [name, ms] of Object.entries(milestones)) rows.push(row("milestone", { name, ms }));
    for (const s of spans) rows.push(row("span", s));
    for (const h of frames.hitches()) rows.push(row("hitch", h satisfies Hitch));
    return `${rows.join("\n")}\n`;
  }
  const unregister = [
    store.registerSection("启动画像", bootLines),
    store.registerSection("性能走势", trendLines),
    store.registerSection("其他会话最后的水位", othersLines),
    store.registerAppendix("性能数据（JSONL）", exportJsonl),
  ];

  // ── 运行 ──
  let timer: ReturnType<typeof setInterval> | null = null;
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      try {
        sampleNow();
      } catch (error) {
        log.warn("页面隐藏时补采失败", { error: errText(error) });
      }
    }
  };

  const recordSpan = (name: string, start: number): void => {
    spans.push({ name, ms: Math.round(clock() - start), at: epoch() });
    if (spans.length > SPANS_KEPT) spans.shift();
  };

  return {
    /** 登记宿主指标；名字不得占用内置指标与 JSONL 行字段（见 RESERVED），否则抛错 */
    registerGauge(name: string, read: () => number | null): () => void {
      if (RESERVED.has(name)) throw new Error(`性能指标名「${name}」是保留名（内置指标或导出字段），换一个名字`);
      gauges.set(name, read);
      return () => {
        if (gauges.get(name) === read) gauges.delete(name);
      };
    },
    /** 记一个时间点（距导航开始的毫秒数） */
    milestone(name: string): void {
      milestones[name] = Math.round(clock());
      log.debug("时间点", { name, ms: milestones[name] });
    },
    span<T>(name: string, fn: () => T): T {
      const start = clock();
      try {
        return fn();
      } finally {
        recordSpan(name, start);
      }
    },
    async spanAsync<T>(name: string, work: Promise<T>): Promise<T> {
      const start = clock();
      try {
        return await work;
      } finally {
        recordSpan(name, start);
      }
    },
    frameStart: frames.frameStart,
    frameEnd: frames.frameEnd,
    sampleNow,
    series: (): VitalSample[] => ring.series(),
    trend,
    captureBoot,
    exportJsonl,
    start(): void {
      if (disposed) throw new Error("性能采集已 dispose（导出摘要已注销），不能再 start；需要时重新 createPerf");
      if (timer !== null) return;
      sampleNow();
      timer = setInterval(() => {
        try {
          sampleNow();
        } catch (error) {
          log.warn("采样失败", { error: errText(error) });
        }
      }, sampleMs);
      frames.startAuto();
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      frames.stopAuto();
      observer?.disconnect();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      for (const off of unregister) off();
    },
  };
}

export type Perf = ReturnType<typeof createPerf>;
