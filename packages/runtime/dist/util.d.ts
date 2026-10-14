/** runtime 各子路径共用的内部小工具（不从包入口导出整份，按需被各子路径转出） */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export declare function errText(error: unknown): string;
export declare const pad: (n: number, w?: number) => string;
/** 本地时区的完整时刻：YYYY-MM-DD HH:MM:SS.mmm */
export declare function formatTime(t: number): string;
/**
 * 取全局 Web Storage：沙箱 iframe、Safari 禁用存储、浏览器拦截第三方存储时，**访问属性本身就会抛**
 * SecurityError——`globalThis.localStorage ?? null` 拦不住。拿不到一律返回 null。
 */
export declare function safeGlobalStorage(name: "localStorage" | "sessionStorage"): StorageLike | null;
/** URL 只留来源与路径：查询串、片段、用户名密码可能带凭证，不进诊断文件 */
export declare function scrubUrl(url: string): string;
/** 文本里出现的 http(s) URL 统一去掉查询串与片段（导出兜底：日志消息和数据是自由文本） */
export declare function scrubUrlsInText(text: string): string;
