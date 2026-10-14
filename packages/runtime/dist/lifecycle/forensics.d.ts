/**
 * 异常退出取证（机制见 docs/架构算法/日志与诊断.md）：用户说「刚才闪退了」时，开发者要知道上一局是
 * 正常关的还是被系统杀的。
 *
 * 会话表（localStorage `<前缀>.sessions`）：每个会话一行 { openAt, aliveAt, exitAt? }。启动时写本行；
 * 每 heartbeatMs 与切后台时刷新 aliveAt；pagehide 写 exitAt。每次更新都「读整表 → 只改本行 → 写回」，
 * 同一应用开在多个窗口（主屏 PWA 加浏览器标签）时各写各的行，互不覆盖。
 *
 * 判词只针对「本局之外最近开启的那个会话」（多窗口时更早崩溃的会话会被它盖住，不再单独报告）：有 exitAt = 正常；仍在运行（开在别的窗口）= 无法判定；其余 =
 * 疑似异常。「仍在运行」靠 Web Locks 判：每个会话持有一把 `<前缀>.alive.<会话号>` 锁，页面关闭或进程
 * 被杀时浏览器自动释放，所以锁还在 = 活着、锁不在 = 已结束——闪退后马上重开，上一局几秒前刚有心跳，
 * 也能判出疑似异常。查询是异步的：verdict 先给初值，settled 落定后更新；不支持 Web Locks 的环境
 * （Safari 15.4 以前）退回心跳规则：两个心跳周期内还有心跳的判无法判定。疑似异常只说明缺少正常关闭的凭证，不证明死因或死亡时刻：Safari 没有
 * freeze/resume 事件，系统杀进程时 pagehide 不保证执行，用户从多任务里划掉也表现为没有告别。
 * 从往返缓存（bfcache）恢复是同一局复活，要撤销 exitAt，否则下次会误判正常关闭。
 *
 * 表的读写失败不抛错（诊断不能把页面搞挂），同一类失败只记一次日志，免得存储满时每 30 秒刷一条。
 */
import type { LogStore } from "../log/store.ts";
import { type StorageLike } from "../util.ts";
export type ExitVerdict = {
    kind: "first-run";
} | {
    kind: "clean";
    endedAt: number;
}
/** lastAliveAt：上一局最后有动静的时刻（心跳与日志中最晚的），不是死亡时刻 */
 | {
    kind: "abrupt";
    lastAliveAt: number;
} | {
    kind: "unknown";
    reason: string;
};
/** 会话表原文 → 上一局判词（纯函数）。excludeSession 是本局（启动早期表里还没有本局，可不传） */
export declare function interpretLastExit(raw: string | null, now: number, heartbeatMs: number, excludeSession?: string, 
/** 仍在运行的会话（Web Locks 查得）；不知道时不传，退回心跳规则 */
running?: ReadonlySet<string>): {
    verdict: ExitVerdict;
    previousSession: string | null;
};
/** Web Locks 的最小形状（生产即 navigator.locks） */
export interface LockManagerLike {
    request(name: string, callback: () => Promise<void>): Promise<unknown>;
    query(): Promise<{
        held?: ReadonlyArray<{
            name?: string;
        }>;
    }>;
}
export interface ForensicsOptions {
    /** 会话表键 `${prefix}.sessions` */
    prefix: string;
    store: LogStore;
    /** 默认 localStorage（拿不到 = 不取证，判词为无法判定） */
    storage?: StorageLike | null;
    /** 默认 Date.now */
    clock?: () => number;
    /** 存活心跳间隔，默认 30 秒 */
    heartbeatMs?: number;
    /** 默认 navigator.locks；传 null 或不支持时退回心跳规则 */
    locks?: LockManagerLike | null;
}
export interface Forensics {
    /** 当前判词：Web Locks 查询落定前是初值 */
    readonly verdict: ExitVerdict;
    /** 落定后的判词 */
    readonly settled: Promise<ExitVerdict>;
    readonly previousSession: string | null;
    dispose(): void;
}
/** 启动早期调用（渲染之前）：得出上局判词、写本局一行、挂告别与心跳 */
export declare function startForensics(options: ForensicsOptions): Forensics;
