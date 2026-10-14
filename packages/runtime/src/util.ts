/** runtime 各子路径共用的内部小工具（不从包入口导出整份，按需被各子路径转出） */

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function errText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** 本地时区的完整时刻：YYYY-MM-DD HH:MM:SS.mmm */
export function formatTime(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 取全局 Web Storage：沙箱 iframe、Safari 禁用存储、浏览器拦截第三方存储时，**访问属性本身就会抛**
 * SecurityError——`globalThis.localStorage ?? null` 拦不住。拿不到一律返回 null。
 */
export function safeGlobalStorage(name: "localStorage" | "sessionStorage"): StorageLike | null {
  try {
    const s = (globalThis as Record<string, unknown>)[name];
    return typeof s === "object" && s !== null ? (s as StorageLike) : null;
  } catch {
    return null;
  }
}

/** URL 只留来源与路径：查询串、片段、用户名密码可能带凭证，不进诊断文件 */
export function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** 文本里出现的 http(s) URL 统一去掉查询串与片段（导出兜底：日志消息和数据是自由文本） */
export function scrubUrlsInText(text: string): string {
  // 只认 URL 合法的 ASCII 字符：中文、引号、空白都是 URL 的边界；句尾的 ) , . ; 归回正文
  return text.replace(/\bhttps?:\/\/[\w\-.~:/?#[\]@!$&()*+,;=%]+/g, (u) => {
    const tail = /[),.;]+$/.exec(u)?.[0] ?? "";
    return scrubUrl(u.slice(0, u.length - tail.length)) + tail;
  });
}
