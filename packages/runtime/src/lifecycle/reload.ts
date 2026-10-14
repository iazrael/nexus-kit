/**
 * 兜底页的「重新加载」：先激活已下载好的新版本再刷新。逻辑在 boot/guard.ts 的 reloadLatest——同一份源码也被
 * 编进 index.html 的内联兜底（主包没加载上时用），两处不会漂移。这里只是 runtime 里的入口：补上默认的
 * navigator.serviceWorker 与 location.reload，并在真正刷新时 resolve。
 * 这是「升级必须用户确认」的唯一例外（需求裁决），机制见 docs/架构算法/日志与诊断.md §5。
 */
import { reloadLatest, type SwLike } from "../boot/guard.ts";

export type { SwLike };

export interface ReloadOptions {
  /** 等新版本下载与接管的总时限，默认 15000ms；没有新版本时检查一结束就刷新，不会等满 */
  timeoutMs?: number;
  /** 默认 navigator.serviceWorker；null = 不支持 */
  sw?: SwLike | null;
  /** 默认 location.reload */
  reload?: () => void;
  /** 发现新版本正在下载时回调，界面据此改提示 */
  onUpdating?: () => void;
}

export function reloadToLatestVersion(options: ReloadOptions = {}): Promise<void> {
  const sw =
    options.sw === undefined
      ? typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? (navigator.serviceWorker as unknown as SwLike)
        : null
      : options.sw;
  const reload = options.reload ?? (() => location.reload());
  return new Promise((resolve) => {
    reloadLatest({
      sw,
      timeoutMs: options.timeoutMs ?? 15000,
      reload: () => {
        reload();
        resolve();
      },
      ...(options.onUpdating ? { onProgress: () => options.onUpdating?.() } : {}),
    });
  });
}
