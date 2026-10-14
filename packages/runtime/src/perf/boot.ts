/**
 * 启动画像：一次启动一条低频摘要，回答「点开图标白屏那几秒花在哪」。JS 开始执行前的耗时（SW 唤醒、首字节、
 * 下载与解析）只有 Navigation Timing / Resource Timing 记得，没人去读就等于没有。
 *
 * 一条画像：导航分段耗时、宿主记的阶段（span）与时间点（milestone）、按类型汇总的资源（请求数、走网络的字节、
 * 缓存命中数——区分「首次真下载」与「二次读缓存」，两种慢的治法完全不同）、最慢的几个资源（地址去查询串）、
 * 本次是否由 SW 接管。落盘 localStorage 留最近 keep 次（默认 5）；同一次启动（sid 相同）再采覆盖前一条——
 * 先在挂载时采一份兜底，load 之后再采一份完整的，不占两个名额。写失败先退到只存这一条，再不行放弃，不抛。
 *
 * 采集只读传入的数据（导航条目、资源条目），浏览器 API 的读取在 perf/index.ts，单测直接造条目。
 */
import { errText, scrubUrl, type StorageLike } from "../util.ts";

export type NavTimingLike = Pick<
  PerformanceNavigationTiming,
  | "redirectStart"
  | "redirectEnd"
  | "workerStart"
  | "fetchStart"
  | "requestStart"
  | "responseStart"
  | "responseEnd"
  | "domInteractive"
  | "domContentLoadedEventEnd"
  | "loadEventEnd"
>;

export type ResTimingLike = Pick<PerformanceResourceTiming, "name" | "duration" | "transferSize" | "decodedBodySize">;

export interface NavSummary {
  redirectMs: number;
  /** SW 唤醒（workerStart→fetchStart）；SW 未参与为 0 */
  swBootMs: number;
  /** 首字节（fetchStart→responseStart） */
  ttfbMs: number;
  /** 请求全程（requestStart→responseEnd） */
  requestMs: number;
  /** HTML 解析到可交互（responseEnd→domInteractive） */
  domParseMs: number;
  /** DOMContentLoaded 结束的绝对时刻 */
  dclMs: number;
  /** load 结束的绝对时刻；采集时还没发生为 null */
  loadMs: number | null;
}

export interface ResGroup {
  n: number;
  /** 走了网络的传输 KB（缓存命中 transferSize 为 0，不计入） */
  kb: number;
  /** 缓存命中条数（transferSize 为 0 且有响应体） */
  cached: number;
  /** 耗时合计 ms（并发时大于墙钟，只作量级参考） */
  ms: number;
}

export interface SlowResource {
  url: string;
  ms: number;
  kb: number;
}

export interface BootTrace {
  /** 本次启动的会话号 */
  sid: string;
  /** 墙钟时刻（epoch ms） */
  at: number;
  /** 采到哪一步：mounted / loaded …… */
  phase: string;
  version: string;
  build: number;
  swControlled: boolean;
  nav: NavSummary | null;
  spans: Record<string, number>;
  milestones: Record<string, number>;
  res: Record<string, ResGroup>;
  slowest: SlowResource[];
}

const r = Math.round;
const kb1 = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;

export function summarizeNavigation(nav: NavTimingLike | undefined): NavSummary | null {
  if (nav === undefined) return null;
  return {
    redirectMs: r(nav.redirectEnd - nav.redirectStart),
    swBootMs: nav.workerStart > 0 ? r(nav.fetchStart - nav.workerStart) : 0,
    ttfbMs: r(nav.responseStart - nav.fetchStart),
    requestMs: r(nav.responseEnd - nav.requestStart),
    domParseMs: r(nav.domInteractive - nav.responseEnd),
    dclMs: r(nav.domContentLoadedEventEnd),
    loadMs: nav.loadEventEnd > 0 ? r(nav.loadEventEnd) : null,
  };
}

const KINDS: Array<[string, RegExp]> = [
  ["js", /\.m?js$/],
  ["css", /\.css$/],
  ["img", /\.(png|jpe?g|gif|webp|avif|svg|ico)$/],
  ["font", /\.(woff2?|ttf|otf)$/],
  ["media", /\.(mp3|m4a|ogg|wav|mp4|webm)$/],
  ["data", /\.(json|bin|wasm)$/],
];

function kindOf(url: string): string {
  const path = scrubUrl(url).toLowerCase();
  return KINDS.find(([, re]) => re.test(path))?.[0] ?? "other";
}

export function groupResources(entries: readonly ResTimingLike[]): Record<string, ResGroup> {
  const out: Record<string, ResGroup> = {};
  for (const e of entries) {
    const g = (out[kindOf(e.name)] ??= { n: 0, kb: 0, cached: 0, ms: 0 });
    g.n++;
    g.kb = kb1(g.kb * 1024 + e.transferSize);
    if (e.transferSize === 0 && e.decodedBodySize > 0) g.cached++;
    g.ms = r(g.ms + e.duration);
  }
  return out;
}

export function slowestResources(entries: readonly ResTimingLike[], n = 5): SlowResource[] {
  return [...entries]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, n)
    .map((e) => ({ url: scrubUrl(e.name), ms: r(e.duration), kb: r(e.transferSize / 1024) }));
}

export function rollTraces(prev: readonly BootTrace[], next: BootTrace, keep = 5): BootTrace[] {
  return [next, ...prev.filter((t) => t.sid !== next.sid)].slice(0, keep);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 落盘画像逐字段校验：坏条目会让导出那一节抛错，而导出是出事后取证的唯一入口 */
function isTrace(t: unknown): t is BootTrace {
  return (
    isObj(t) &&
    typeof t.sid === "string" &&
    typeof t.at === "number" &&
    typeof t.phase === "string" &&
    typeof t.version === "string" &&
    typeof t.build === "number" &&
    typeof t.swControlled === "boolean" &&
    (t.nav === null || isObj(t.nav)) &&
    isObj(t.spans) &&
    isObj(t.milestones) &&
    isObj(t.res) &&
    Array.isArray(t.slowest)
  );
}

/** 读已存的画像；读失败或不是合法 JSON 时经 onError 报原因并按空处理（下次写盘覆盖掉坏数据） */
export function loadBootTraces(key: string, storage: StorageLike | null, onError?: (reason: string) => void): BootTrace[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isTrace) : [];
  } catch (error) {
    onError?.(`启动画像记录损坏或读不到，已丢弃：${errText(error)}`);
    return [];
  }
}

export interface BootInput {
  sid: string;
  phase: string;
  version: string;
  build: number;
  at: number;
  swControlled: boolean;
  nav: NavTimingLike | undefined;
  resources: readonly ResTimingLike[];
  spans: Record<string, number>;
  milestones: Record<string, number>;
}

/** 采一条画像并落盘（读不到旧记录、写失败都不抛，原因交给 onError），返回这条画像 */
export function captureBootTrace(
  input: BootInput,
  persist: { key: string; storage: StorageLike | null; keep: number; onError?: (reason: string) => void },
): BootTrace {
  const trace: BootTrace = {
    sid: input.sid,
    at: input.at,
    phase: input.phase,
    version: input.version,
    build: input.build,
    swControlled: input.swControlled,
    nav: summarizeNavigation(input.nav),
    spans: { ...input.spans },
    milestones: { ...input.milestones },
    res: groupResources(input.resources),
    slowest: slowestResources(input.resources),
  };
  const { storage, key, keep, onError } = persist;
  if (storage !== null) {
    // 配额满时逐级退化：全部 → 只存这一条 → 放弃（本会话内存里仍可导出）
    let lastError: unknown = null;
    for (const candidate of [rollTraces(loadBootTraces(key, storage, onError), trace, keep), [trace]]) {
      try {
        storage.setItem(key, JSON.stringify(candidate));
        lastError = null;
        break;
      } catch (error) {
        lastError = error; // 降一级再试
      }
    }
    if (lastError !== null) onError?.(`启动画像写盘失败（只存这一条也写不下）：${errText(lastError)}`);
  }
  return trace;
}

export function formatBootTrace(t: BootTrace): string[] {
  const lines = [
    `${new Date(t.at).toISOString()} · ${t.version}（构建 ${t.build}）· ${t.phase} · ${t.swControlled ? "SW 接管" : "无 SW（首访或未就绪）"}`,
  ];
  if (t.nav !== null) {
    const n = t.nav;
    lines.push(
      `  导航 重定向 ${n.redirectMs}ms · SW 唤醒 ${n.swBootMs}ms · 首字节 ${n.ttfbMs}ms · 响应 ${n.requestMs}ms · 解析 ${n.domParseMs}ms · DCL ${n.dclMs}ms · load ${n.loadMs ?? "-"}ms`,
    );
  }
  const spans = Object.entries(t.spans);
  if (spans.length > 0) lines.push(`  阶段 ${spans.map(([k, v]) => `${k} ${v}ms`).join(" · ")}`);
  const res = Object.entries(t.res);
  if (res.length > 0) {
    lines.push(
      `  网络 ${res.map(([k, g]) => `${k} ${g.n} 个${g.cached > 0 ? `（缓存 ${g.cached}）` : ""} ${g.kb}KB ${g.ms}ms`).join(" · ")}`,
    );
  }
  const ms = Object.entries(t.milestones).sort((a, b) => a[1] - b[1]);
  if (ms.length > 0) lines.push(`  时刻 ${ms.map(([k, v]) => `${k} ${v}ms`).join(" · ")}`);
  if (t.slowest.length > 0) lines.push(`  最慢 ${t.slowest.map((s) => `${s.url} ${s.ms}ms ${s.kb}KB`).join(" · ")}`);
  return lines;
}
