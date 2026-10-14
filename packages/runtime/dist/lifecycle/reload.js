/**
 * 兜底页的「重新加载」：先激活已下载好的新版本再刷新。逻辑在 boot/guard.ts 的 reloadLatest——同一份源码也被
 * 编进 index.html 的内联兜底（主包没加载上时用），两处不会漂移。这里只是 runtime 里的入口：补上默认的
 * navigator.serviceWorker 与 location.reload，并在真正刷新时 resolve。
 * 这是「升级必须用户确认」的唯一例外（需求裁决），机制见 docs/架构算法/日志与诊断.md §5。
 */
import { reloadLatest } from "../boot/guard.js";
export function reloadToLatestVersion(options = {}) {
    const sw = options.sw === undefined
        ? typeof navigator !== "undefined" && "serviceWorker" in navigator
            ? navigator.serviceWorker
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
