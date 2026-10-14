/**
 * 日志 store（机制见 docs/架构算法/日志与诊断.md）：命名 logger → 级别阈值 → 分区环形缓冲 →
 * 防抖落盘 localStorage（页面隐藏、pagehide 立即写）→ 下次启动读回 → 行式文本导出。
 *
 * - 级别阈值：低于阈值的调用不入缓冲也不打印。`?log=debug` 打开详细日志，只记在 sessionStorage
 *   （本会话有效，重开回默认）——两个项目都踩过「debug 忘了关一直刷」。
 * - 持久化以会话为轮转单位（ring.ts trimForPersist）。其他会话的记录（上一局，或同时开着的另一个窗口）
 *   每次落盘和导出时从存储现读，不进本次的环形缓冲：本次的高频事件挤不掉它们，两个窗口各自落盘也不会
 *   互相覆盖。
 * - 写盘失败（配额满、隐私模式）不抛错、不打断页面：先降级重试一次（只留本会话、预算减半），仍失败才
 *   记入健康状态；首次出问题打一条 console 警告；导出头部如实写出。
 * - 载荷在写入时规整成纯 JSON：Error 保留名称、消息与截断堆栈，BigInt 转字符串，不可序列化的、过长的
 *   就地降级成说明文字——持久化与导出不会因为某一条失败。
 * - 导出时对全文兜底去掉 URL 的查询串与片段（消息和载荷是自由文本，可能带凭证）。
 *
 * 存储、时钟、console、会话号、环境信息都可注入；DOM 只在函数体内访问，Node 里 import 不报错。
 */
import { errText, formatTime, safeGlobalStorage, scrubUrl, scrubUrlsInText, type StorageLike } from "../util.ts";
import { DEFAULT_DOMAINS, LogRing, mergeByTime, trimForPersist, type DomainSpec, type LogEntry, type LogLevel } from "./ring.ts";

export type { DomainSpec, LogEntry, LogLevel, StorageLike };
export { formatTime, scrubUrl, scrubUrlsInText };

/** 与 @nexus-kit/pwa 的 PwaLogger 同形：可直接作为 createPwaController 的 logger 传入 */
export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface LogStoreOptions {
  /** localStorage 键；级别记在 sessionStorage 的 `${key}.level` */
  key: string;
  /** 分区声明；不写 = 一个默认区（2000 条） */
  domains?: readonly DomainSpec[];
  /** 持久化保留的会话数（含本次），默认 3 */
  sessionsKept?: number;
  /** 持久化总字符预算（JSON 序列化后），默认 40 万 */
  charBudget?: number;
  /** 落盘防抖，默认 1000ms */
  flushDelayMs?: number;
  /** 初始默认级别，默认 info */
  level?: LogLevel;
  /** 持久化存储；默认 localStorage，传 null 不持久化 */
  storage?: StorageLike | null;
  /** 级别记忆存储；默认 sessionStorage，传 null 不记 */
  sessionStorage?: StorageLike | null;
  /** 默认 Date.now */
  clock?: () => number;
  /** 默认全局 console；传 null 不打印 */
  console?: Pick<Console, "debug" | "info" | "warn" | "error"> | null;
  /** 本次会话号；默认随机 */
  session?: string;
  /** 导出头部的环境行；默认 UA、屏幕、页面路径（不含查询串与片段） */
  env?: () => string[];
  /** 读级别用的 URL 查询串；默认 location.search */
  search?: string;
}

export interface PersistHealth {
  /** 降级重试后仍失败的次数 */
  failures: number;
  lastError: string | null;
  /** 正常写入失败、降级（只留本会话、预算减半）后写成的次数 */
  degraded: number;
  /** 读回其他会话时的问题（坏数据、读失败）；没问题为 null */
  restoreError: string | null;
}

export interface LogStore {
  readonly session: string;
  log(module: string): Logger;
  level(): LogLevel;
  /** 改阈值；remember=true（默认）时记进本会话 */
  setLevel(level: LogLevel, remember?: boolean): void;
  /** 全部记录：存储里其他会话的 + 本次的，按时间归并 */
  entries(): LogEntry[];
  /** 某会话最后有记录的时刻；没有返回 null（取证用来估「最后有动静」的时间） */
  lastEntryAt(session: string): number | null;
  /** 注册导出头部的摘要节；返回注销函数 */
  registerSection(name: string, lines: () => string[]): () => void;
  /** 注册日志之后的附录（性能数据等大块内容）；返回注销函数 */
  registerAppendix(name: string, text: () => string): () => void;
  /** appendix=false 时不带附录（复制到聊天用：附录体积大，截短也只针对日志） */
  exportText(options?: { appendix?: boolean }): string;
  /** 立即落盘 */
  flush(): void;
  persistHealth(): PersistHealth;
  /** 清空内存与持久化 */
  clear(): void;
  /** 摘掉页面监听与定时器 */
  dispose(): void;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const DATA_MAX_CHARS = 2000;
const STACK_MAX_CHARS = 1000;

function isLevel(v: unknown): v is LogLevel {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

/** 级别来源优先级：URL `?log=` > 本会话记住的 > 默认值；非法值一律忽略 */
export function pickLevel(search: string, remembered: string | null, fallback: LogLevel): LogLevel {
  const fromUrl = new URLSearchParams(search).get("log");
  if (isLevel(fromUrl)) return fromUrl;
  if (isLevel(remembered)) return remembered;
  return fallback;
}

/** JSON 序列化时把 Error 展开成可读字段、BigInt 转字符串（默认序列化下 Error 变 {}、BigInt 直接抛） */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.slice(0, STACK_MAX_CHARS) };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * 载荷规整成纯 JSON：原始类型直接放行；其余经 replacer 序列化一次再解析成独立副本（日后原对象被改，
 * 记录不跟着变）。不可序列化或过长时降级成说明文字。调用方不要把大对象整个塞进来：序列化在截断之前。
 */
function normalizeData(data: unknown): unknown {
  if (data === null || typeof data === "number" || typeof data === "boolean") return data;
  if (typeof data === "string")
    return data.length > DATA_MAX_CHARS ? `${data.slice(0, DATA_MAX_CHARS)}…（截断，原长 ${data.length} 字符）` : data;
  let json: string | undefined;
  try {
    json = JSON.stringify(data, replacer);
  } catch (error) {
    return `[无法序列化：${errText(error)}]`;
  }
  if (json === undefined) return undefined;
  if (json.length > DATA_MAX_CHARS) return `${json.slice(0, DATA_MAX_CHARS)}…（截断，原长 ${json.length} 字符）`;
  return JSON.parse(json) as unknown;
}

function isEntry(v: unknown): v is LogEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.t === "number" && typeof o.s === "string" && isLevel(o.lv) && typeof o.m === "string" && typeof o.msg === "string";
}

function randomSession(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 默认环境行：UA、页面来源与路径（不含查询串与片段）、屏幕与 dpr。宿主可在前后追加自己的行 */
export function defaultEnvLines(): string[] {
  if (typeof navigator === "undefined" || typeof location === "undefined") return [];
  const lines = [`UA：${navigator.userAgent}`, `页面：${location.origin}${location.pathname}`];
  if (typeof screen !== "undefined") lines.push(`屏幕：${screen.width}×${screen.height}，dpr ${globalThis.devicePixelRatio ?? 1}`);
  return lines;
}

function formatEntry(e: LogEntry): string {
  const data = e.data === undefined ? "" : ` ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}`;
  return `${formatTime(e.t)} ${e.lv.toUpperCase().padEnd(5)} [${e.m}] ${e.msg}${data}`;
}

export function createLogStore(options: LogStoreOptions): LogStore {
  const key = options.key;
  const levelKey = `${key}.level`;
  const storage = options.storage === undefined ? safeGlobalStorage("localStorage") : options.storage;
  const sessionStore = options.sessionStorage === undefined ? safeGlobalStorage("sessionStorage") : options.sessionStorage;
  const clock = options.clock ?? Date.now;
  const out = options.console === undefined ? globalThis.console : options.console;
  const session = options.session ?? randomSession();
  const env = options.env ?? defaultEnvLines;
  const sessionsKept = options.sessionsKept ?? 3;
  const charBudget = options.charBudget ?? 400_000;
  const flushDelayMs = options.flushDelayMs ?? 1000;
  const ring = new LogRing(options.domains ?? DEFAULT_DOMAINS);
  const sections = new Map<string, () => string[]>();
  const appendices = new Map<string, () => string>();
  const health: PersistHealth = { failures: 0, lastError: null, degraded: 0, restoreError: null };
  /** 每条序列化长度的缓存（落盘裁剪按条计预算，每次落盘不再把全部条目重算一遍） */
  const sizes = new WeakMap<LogEntry, number>();
  const sizeOf = (e: LogEntry): number => {
    let n = sizes.get(e);
    if (n === undefined) {
      n = JSON.stringify(e).length + 1;
      sizes.set(e, n);
    }
    return n;
  };
  let warned = false;
  const warnOnce = (message: string): void => {
    if (warned || out === null) return;
    warned = true;
    out.warn(`[log] ${message}`);
  };

  // ── 其他会话（上一局、另一个窗口）：从存储现读；原文没变就复用上次的解析结果 ──
  let othersRaw: string | null = null;
  let othersCache: LogEntry[] = [];
  function others(): LogEntry[] {
    if (storage === null) return [];
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch (error) {
      health.restoreError = `读取失败：${errText(error)}`;
      return othersCache;
    }
    if (raw === othersRaw) return othersCache;
    othersRaw = raw;
    othersCache = [];
    if (raw === null) return othersCache;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("不是数组");
      const valid = parsed.filter(isEntry);
      if (valid.length < parsed.length) health.restoreError = `${parsed.length - valid.length} 条格式不对，已跳过`;
      othersCache = valid.filter((e) => e.s !== session).sort((a, b) => a.t - b.t);
    } catch (error) {
      health.restoreError = errText(error);
    }
    return othersCache;
  }
  others(); // 启动即读一次：坏数据尽早记进健康状态

  // ── 级别 ──
  let remembered: string | null = null;
  try {
    remembered = sessionStore?.getItem(levelKey) ?? null;
  } catch {}
  const search = options.search ?? (typeof location === "undefined" ? "" : location.search);
  let threshold = pickLevel(search, remembered, options.level ?? "info");
  const fromUrl = new URLSearchParams(search).get("log");
  if (isLevel(fromUrl)) rememberLevel(fromUrl);

  function rememberLevel(level: LogLevel): void {
    try {
      sessionStore?.setItem(levelKey, level);
    } catch {}
  }

  // ── 落盘 ──
  let timer: ReturnType<typeof setTimeout> | null = null;
  const entries = (): LogEntry[] => mergeByTime([others(), ring.entries()]);

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (storage === null) return;
    const mine = ring.entries();
    try {
      const { kept } = trimForPersist(mergeByTime([others(), mine]), { sessionsKept, charBudget, current: session }, sizeOf);
      storage.setItem(key, JSON.stringify(kept));
      return;
    } catch (first) {
      // 降级：只留本会话、预算减半再试一次（配额被宿主数据挤满时，至少本局现场还能留下）
      try {
        const { kept } = trimForPersist(mine, { sessionsKept: 1, charBudget: Math.floor(charBudget / 2), current: session }, sizeOf);
        storage.setItem(key, JSON.stringify(kept));
        health.degraded++;
        warnOnce(`日志写盘失败（${errText(first)}），已降级为只保存本会话`);
      } catch (error) {
        health.failures++;
        health.lastError = errText(error);
        warnOnce(`日志写盘失败：${health.lastError}`);
      }
    }
  }

  function scheduleFlush(): void {
    if (storage === null || timer !== null) return;
    timer = setTimeout(flush, flushDelayMs);
  }

  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") flush();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  if (typeof window !== "undefined") window.addEventListener("pagehide", flush);

  let lastT = -Infinity;
  function write(lv: LogLevel, m: string, msg: string, data: unknown): void {
    if (RANK[lv] < RANK[threshold]) return;
    // 时间戳单调不减：系统校时回拨时时间线也不乱序（各区内部有序是归并的前提）
    lastT = Math.max(lastT, clock());
    const entry: LogEntry = { t: lastT, s: session, lv, m, msg };
    const normalized = data === undefined ? undefined : normalizeData(data);
    if (normalized !== undefined) entry.data = normalized;
    ring.push(entry);
    if (out !== null) {
      if (normalized === undefined) out[lv](`[${m}] ${msg}`);
      else out[lv](`[${m}] ${msg}`, normalized);
    }
    scheduleFlush();
  }

  function exportText(options: { appendix?: boolean } = {}): string {
    const lines = ["# 诊断日志", `导出时间：${formatTime(clock())}`, `本次会话：${session}`, ...env(), `日志级别：${threshold}`];
    const persist = [
      health.degraded > 0 ? `降级保存 ${health.degraded} 次（只留本会话）` : "",
      health.failures > 0 ? `失败 ${health.failures} 次，最后一次：${health.lastError}` : "",
    ].filter(Boolean);
    lines.push(`持久化：${persist.length === 0 ? "正常" : persist.join("；")}`);
    if (health.restoreError !== null) lines.push(`读回其他会话出错：${health.restoreError}`);
    const dropped = Object.entries(ring.dropped()).filter(([, n]) => n > 0);
    if (dropped.length > 0) lines.push(`丢弃：${dropped.map(([d, n]) => `${d} ${n} 条`).join("、")}（满额淘汰最旧）`);
    for (const [name, provider] of sections) {
      let body: string[];
      try {
        body = provider();
      } catch (error) {
        body = [`（生成失败：${errText(error)}）`];
      }
      lines.push("", `## ${name}`, ...body);
    }
    lines.push("", "## 日志");
    let current: string | null = null;
    for (const e of entries()) {
      if (e.s !== current) {
        current = e.s;
        lines.push(`--- 会话 ${e.s}${e.s === session ? "（本次）" : ""}，首条 ${formatTime(e.t)} ---`);
      }
      lines.push(formatEntry(e));
    }
    if (options.appendix !== false) {
      for (const [name, provider] of appendices) {
        let body: string;
        try {
          body = provider();
        } catch (error) {
          body = `（生成失败：${errText(error)}）`;
        }
        lines.push("", `## ${name}`, body.replace(/\n$/, ""));
      }
    }
    return scrubUrlsInText(`${lines.join("\n")}\n`);
  }

  return {
    session,
    log: (m) => ({
      debug: (msg, data) => write("debug", m, msg, data),
      info: (msg, data) => write("info", m, msg, data),
      warn: (msg, data) => write("warn", m, msg, data),
      error: (msg, data) => write("error", m, msg, data),
    }),
    level: () => threshold,
    setLevel(level, remember = true) {
      threshold = level;
      if (remember) rememberLevel(level);
    },
    entries,
    lastEntryAt(s) {
      let last: number | null = null;
      for (const e of entries()) if (e.s === s && (last === null || e.t > last)) last = e.t;
      return last;
    },
    registerAppendix(name, text) {
      appendices.set(name, text);
      return () => {
        if (appendices.get(name) === text) appendices.delete(name);
      };
    },
    registerSection(name, lines) {
      sections.set(name, lines);
      return () => {
        if (sections.get(name) === lines) sections.delete(name);
      };
    },
    exportText,
    flush,
    persistHealth: () => ({ ...health }),
    clear() {
      ring.clear();
      othersRaw = null;
      othersCache = [];
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        storage?.removeItem(key);
      } catch (error) {
        health.failures++;
        health.lastError = errText(error);
      }
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      if (typeof window !== "undefined") window.removeEventListener("pagehide", flush);
    },
  };
}
