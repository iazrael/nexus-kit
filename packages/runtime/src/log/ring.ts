/**
 * 日志环形缓冲与持久化裁剪的纯逻辑（机制见 docs/架构算法/日志与诊断.md）。
 *
 * 分区：单一环形里高频事件永远赢——旧项目A跑图十几分钟，命中结算把 4000 条冲满，启动、存档、
 * 升级那十几条早被挤没，而「启动为什么慢」只能从这几条看。所以按模块分区，各区独立限额、独立
 * 淘汰；导出时按时间归并回一条时间线。宿主不声明分区时只有一个默认区。
 *
 * 持久化裁剪：浏览器里的「日志轮转」以会话为单位——只留最近 N 个会话，超总字符预算时整段淘汰
 * 最旧的会话，只剩本次会话仍超时才从本次最旧的条目开始丢。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 一条日志。字段取短名：整段要序列化进 localStorage，按字符计预算 */
export interface LogEntry {
  /** 墙钟时刻（epoch ms） */
  t: number;
  /** 会话号 */
  s: string;
  lv: LogLevel;
  /** 模块名 */
  m: string;
  msg: string;
  data?: unknown;
}

export interface DomainSpec {
  name: string;
  /** 本区最多保留的条数 */
  cap: number;
  /** 归入本区的模块名；不写 = 默认区（收其余全部模块），有且只有一个 */
  modules?: readonly string[];
}

export const DEFAULT_DOMAINS: readonly DomainSpec[] = [{ name: "main", cap: 2000 }];

/** 循环缓冲：满了覆盖最旧的槽位，写入 O(1)（cap 由宿主配置，配大了也不搬数组） */
interface Domain {
  name: string;
  cap: number;
  items: Array<LogEntry | undefined>;
  /** 写入序号，与 items 同槽：同一时刻的多条按写入次序归并 */
  seqs: number[];
  /** 最旧一条所在槽位 */
  head: number;
  size: number;
  dropped: number;
}

export class LogRing {
  private readonly domains: Domain[];
  private readonly byModule = new Map<string, Domain>();
  private readonly fallback: Domain;
  private seq = 0;

  constructor(specs: readonly DomainSpec[] = DEFAULT_DOMAINS) {
    if (specs.length === 0) throw new Error("[log] 分区声明至少一个");
    const names = new Set<string>();
    this.domains = specs.map((spec) => {
      if (!Number.isInteger(spec.cap) || spec.cap < 1) throw new Error(`[log] 分区 ${spec.name} 的 cap 必须是正整数`);
      if (names.has(spec.name)) throw new Error(`[log] 分区重名：${spec.name}`);
      names.add(spec.name);
      return {
        name: spec.name,
        cap: spec.cap,
        items: new Array<LogEntry | undefined>(spec.cap),
        seqs: new Array<number>(spec.cap),
        head: 0,
        size: 0,
        dropped: 0,
      };
    });
    const defaults = this.domains.filter((_, i) => specs[i]!.modules === undefined);
    if (defaults.length !== 1) throw new Error(`[log] 只能有一个默认区（不写 modules 的分区），当前 ${defaults.length} 个`);
    this.fallback = defaults[0]!;
    specs.forEach((spec, i) => {
      for (const m of spec.modules ?? []) {
        if (this.byModule.has(m)) throw new Error(`[log] 模块 ${m} 被归入了两个分区`);
        this.byModule.set(m, this.domains[i]!);
      }
    });
  }

  push(entry: LogEntry): void {
    const d = this.byModule.get(entry.m) ?? this.fallback;
    const slot = (d.head + d.size) % d.cap;
    d.items[slot] = entry;
    d.seqs[slot] = this.seq++;
    if (d.size < d.cap) {
      d.size++;
    } else {
      d.head = (d.head + 1) % d.cap; // 刚覆盖的是最旧一条
      d.dropped++;
    }
  }

  /** 全部记录按时间归并（同一时刻按写入次序） */
  entries(): LogEntry[] {
    const tagged = this.domains.map((d) =>
      Array.from({ length: d.size }, (_, i) => {
        const slot = (d.head + i) % d.cap;
        return { item: d.items[slot]!, seq: d.seqs[slot]! };
      }),
    );
    return mergeSorted(tagged, (a, b) => a.item.t - b.item.t || a.seq - b.seq).map((x) => x.item);
  }

  /** 各区因满额淘汰的条数 */
  dropped(): Record<string, number> {
    return Object.fromEntries(this.domains.map((d) => [d.name, d.dropped]));
  }

  clear(): void {
    for (const d of this.domains) {
      d.items.fill(undefined);
      d.head = 0;
      d.size = 0;
      d.dropped = 0;
    }
  }
}

/** 多段各自按时间有序的记录归并为一条时间线 */
export function mergeByTime(lists: readonly (readonly LogEntry[])[]): LogEntry[] {
  return mergeSorted(lists, (a, b) => a.t - b.t);
}

function mergeSorted<T>(lists: readonly (readonly T[])[], cmp: (a: T, b: T) => number): T[] {
  const out: T[] = [];
  const idx = lists.map(() => 0);
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      const cand = lists[i]![idx[i]!];
      if (cand === undefined) continue;
      if (best === -1 || cmp(cand, lists[best]![idx[best]!]!) < 0) best = i;
    }
    if (best === -1) return out;
    out.push(lists[best]![idx[best]!]!);
    idx[best]!++;
  }
}

export interface TrimResult {
  kept: LogEntry[];
  /** 整段淘汰的旧会话数 */
  droppedSessions: number;
  /** 本次会话里为凑预算丢掉的最旧条目数 */
  droppedEntries: number;
}

/**
 * 持久化前裁剪（entries 须按时间有序）：留最近 sessionsKept 个会话（本次会话 current 总在）；
 * 序列化后（JSON 数组）超过 charBudget 时先整段淘汰最旧的会话，只剩本次会话仍超才逐条丢本次最旧的。
 */
export function trimForPersist(
  entries: readonly LogEntry[],
  opts: { sessionsKept: number; charBudget: number; current: string },
  /** 每条序列化长度 + 1 个逗号；调用方可传缓存版本，免得每次落盘都把全部条目再序列化一遍 */
  sizeOf: (e: LogEntry) => number = (e) => JSON.stringify(e).length + 1,
): TrimResult {
  const order: string[] = [];
  const groups = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    let g = groups.get(entry.s);
    if (g === undefined) {
      g = [];
      groups.set(entry.s, g);
      if (entry.s !== opts.current) order.push(entry.s);
    }
    g.push(entry);
  }
  // 旧会话按首条时间排在前（order 即首次出现次序），本次会话固定放最后
  let sessions = order.slice(Math.max(0, order.length - Math.max(0, opts.sessionsKept - 1)));
  let droppedSessions = order.length - sessions.length;
  const current = groups.get(opts.current) ?? [];

  // 数组外层方括号 2 个字符
  const sizeOfGroup = (list: readonly LogEntry[]): number => list.reduce((n, e) => n + sizeOf(e), 0);
  let total = 2 + sessions.reduce((n, s) => n + sizeOfGroup(groups.get(s)!), 0) + sizeOfGroup(current);
  while (total > opts.charBudget && sessions.length > 0) {
    total -= sizeOfGroup(groups.get(sessions[0]!)!);
    sessions = sessions.slice(1);
    droppedSessions++;
  }
  let start = 0;
  while (total > opts.charBudget && start < current.length) {
    total -= sizeOf(current[start]!);
    start++;
  }
  const kept = mergeByTime([...sessions.map((s) => groups.get(s)!), current.slice(start)]);
  return { kept, droppedSessions, droppedEntries: start };
}
