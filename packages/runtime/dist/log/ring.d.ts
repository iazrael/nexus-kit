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
export declare const DEFAULT_DOMAINS: readonly DomainSpec[];
export declare class LogRing {
    private readonly domains;
    private readonly byModule;
    private readonly fallback;
    private seq;
    constructor(specs?: readonly DomainSpec[]);
    push(entry: LogEntry): void;
    /** 全部记录按时间归并（同一时刻按写入次序） */
    entries(): LogEntry[];
    /** 各区因满额淘汰的条数 */
    dropped(): Record<string, number>;
    clear(): void;
}
/** 多段各自按时间有序的记录归并为一条时间线 */
export declare function mergeByTime(lists: readonly (readonly LogEntry[])[]): LogEntry[];
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
export declare function trimForPersist(entries: readonly LogEntry[], opts: {
    sessionsKept: number;
    charBudget: number;
    current: string;
}, 
/** 每条序列化长度 + 1 个逗号；调用方可传缓存版本，免得每次落盘都把全部条目再序列化一遍 */
sizeOf?: (e: LogEntry) => number): TrimResult;
