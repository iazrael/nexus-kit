/**
 * 水位跨会话保留：内存里的长线刷新即失，而「上一局最后几分钟怎么了」正是排查闪退最需要的。localStorage
 * `<key>` 存一张会话表，每个会话一行 { updatedAt, samples }，只留最后 keepSamples 个点、最近 sessionsKept 个会话
 * （含本局）。每次写都是「读整表 → 只改本行 → 写回」：同一应用开在多个窗口时各写各的行，互不覆盖。
 * 上一局疑似异常时，它最后保存的那段水位就是现场；导出时连同会话号一起列出。
 * 坏数据只丢坏行；读写失败不抛，同一原因只经 onError 报一次（诊断不能把页面搞挂，也不能每 5 秒刷一条）。
 */
import { type StorageLike } from "../util.ts";
import type { VitalSample } from "./vitals.ts";
export interface SavedVitals {
    session: string;
    updatedAt: number;
    samples: VitalSample[];
}
export declare function createVitalsPersist(options: {
    key: string;
    storage: StorageLike | null;
    session: string;
    keepSamples?: number;
    sessionsKept?: number;
    onError?: (reason: string) => void;
}): {
    /** 本局最新的长线写盘（只留最后 keepSamples 个点） */
    save(series: readonly VitalSample[], now: number): void;
    /** 其他会话（上一局、别的窗口）保存的水位，最近更新的在前 */
    others(): SavedVitals[];
};
export type VitalsPersist = ReturnType<typeof createVitalsPersist>;
