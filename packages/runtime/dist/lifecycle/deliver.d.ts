/**
 * 诊断文件交付：系统分享优先（手机上能直接发给开发者），不支持或失败时下载兜底。文件一律 `.txt`——
 * 安卓分享只认少数扩展名，日志与后续各节合在一个文本文件里，按节标题切开即可还原。
 * 用户在分享面板里取消算「取消」，不再追加下载。
 */
export { scrubUrl } from "../util.ts";
export type DeliverResult = "shared" | "downloaded" | "cancelled";
/** `<前缀>-诊断-YYYYMMDD-HHMMSS.txt`（本地时刻） */
export declare function diagnosticFileName(prefix: string, at: number): string;
export declare function deliverTextFile(name: string, text: string): Promise<DeliverResult>;
