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
import { formatTime, scrubUrl, scrubUrlsInText, type StorageLike } from "../util.ts";
import { type DomainSpec, type LogEntry, type LogLevel } from "./ring.ts";
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
    exportText(): string;
    /** 立即落盘 */
    flush(): void;
    persistHealth(): PersistHealth;
    /** 清空内存与持久化 */
    clear(): void;
    /** 摘掉页面监听与定时器 */
    dispose(): void;
}
/** 级别来源优先级：URL `?log=` > 本会话记住的 > 默认值；非法值一律忽略 */
export declare function pickLevel(search: string, remembered: string | null, fallback: LogLevel): LogLevel;
/** 默认环境行：UA、页面来源与路径（不含查询串与片段）、屏幕与 dpr。宿主可在前后追加自己的行 */
export declare function defaultEnvLines(): string[];
export declare function createLogStore(options: LogStoreOptions): LogStore;
