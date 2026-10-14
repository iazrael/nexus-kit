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

const WINDOW_MS = 60_000;

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

/** 返回注销函数 */
export function captureGlobalErrors(store: LogStore, options: CaptureErrorsOptions = {}): () => void {
  if (typeof window === "undefined") return () => undefined;
  const log = store.log("error");
  const clock = options.clock ?? Date.now;
  const maxPerMinute = options.maxPerMinute ?? 20;
  /** 本窗口已记录的消息 → 之后又重复的次数 */
  const seen = new Map<string, number>();
  let windowStart = clock();
  let inWindow = 0;
  let suppressed = 0;

  function record(message: string, data: Record<string, unknown>): void {
    const now = clock();
    if (now - windowStart >= WINDOW_MS) {
      for (const [m, repeated] of seen) if (repeated > 0) log.warn(`上一分钟「${m}」又重复了 ${repeated} 次`);
      if (suppressed > 0) log.warn(`上一分钟有 ${suppressed} 条未捕获异常超出记录上限，未逐条记录`);
      seen.clear();
      windowStart = now;
      inWindow = 0;
      suppressed = 0;
    }
    const repeated = seen.get(message);
    if (repeated !== undefined) {
      seen.set(message, repeated + 1);
      return;
    }
    if (inWindow >= maxPerMinute) {
      suppressed++;
      return;
    }
    inWindow++;
    seen.set(message, 0);
    log.error(message, data);
  }

  const onError = (event: ErrorEvent): void => {
    const at = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined;
    record(`未捕获异常：${event.message || describeReason(event.error)}`, {
      ...(event.error !== undefined && event.error !== null ? { error: event.error } : {}),
      ...(at === undefined ? {} : { at }),
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    record(`未处理的 Promise 拒绝：${describeReason(reason)}`, reason instanceof Error ? { error: reason } : {});
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
