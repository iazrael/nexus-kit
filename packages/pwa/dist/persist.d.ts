/**
 * 持久化存储申请（docs/架构算法/离线与升级.md §6）：向浏览器声明「重要数据，别当垃圾清」，
 * iOS 存储紧张时 Cache Storage 与 IndexedDB 同受益。被拒/异常不阻塞，结果与配额落日志。
 * 时机：用户已产生值得保存的数据之后（首次进入核心流程），不要在首屏调用。
 */
import type { PwaLogger } from "./controller.ts";
export type PersistResult = "granted" | "denied" | "unsupported" | "failed";
export declare function requestPersistentStorage(logger?: PwaLogger): Promise<PersistResult>;
