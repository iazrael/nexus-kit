/**
 * 未捕获异常进日志：用户反馈「点了某个按钮就卡死 / 报错」时，诊断文件里要有那次报错的消息和堆栈。
 * 监听 window 的 `error`（同步异常、资源以外的脚本错误）与 `unhandledrejection`（没人 catch 的 Promise）。
 *
 * 限频按固定的一分钟窗口：同一条消息每个窗口只记一次；每个窗口逐条记录的总数有上限，超出的只计数。
 * 窗口翻转时补记两类汇总——某条消息在窗口里又重复了几次、超出上限压下了几条——然后清空本窗口的记账
 * （记账不会随运行时间无限增长）。一个死循环里的报错不会把启动、存档、升级这些低频记录挤出缓冲，
 * 刷了一阵就停的报错也不会丢掉次数。
 */
import type { LogStore } from "../log/store.ts";
export interface CaptureErrorsOptions {
    /** 每分钟最多逐条记录的异常数，默认 20 */
    maxPerMinute?: number;
    /** 默认 Date.now */
    clock?: () => number;
}
/** 返回注销函数 */
export declare function captureGlobalErrors(store: LogStore, options?: CaptureErrorsOptions): () => void;
