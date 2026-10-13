/**
 * 持久化存储申请（docs/架构算法/离线与升级.md §6）：向浏览器声明「重要数据，别当垃圾清」，
 * iOS 存储紧张时 Cache Storage 与 IndexedDB 同受益。被拒/异常不阻塞，结果与配额落日志。
 * 时机：用户已产生值得保存的数据之后（首次进入核心流程），不要在首屏调用。
 */
import type { PwaLogger } from "./controller.ts";

export type PersistResult = "granted" | "denied" | "unsupported" | "failed";

export async function requestPersistentStorage(logger?: PwaLogger): Promise<PersistResult> {
  if (typeof navigator === "undefined" || navigator.storage?.persist === undefined) return "unsupported";
  try {
    const granted = await navigator.storage.persist();
    const est = await navigator.storage.estimate();
    const quota = { usageMB: Math.round((est.usage ?? 0) / 1048576), quotaMB: Math.round((est.quota ?? 0) / 1048576) };
    if (granted) logger?.info("持久化存储已授予", quota);
    else logger?.warn("持久化存储被浏览器拒绝（不阻塞使用，缓存可能被系统清理）", quota);
    return granted ? "granted" : "denied";
  } catch (error) {
    logger?.warn("持久化存储请求失败（不阻塞使用）", { error: String(error).slice(0, 200) });
    return "failed";
  }
}
