/**
 * 诊断文件交付。触屏设备（主要指针是粗指针）优先系统分享——手机上能直接发给开发者；桌面直接下载，
 * 不弹系统分享面板。分享不支持或失败时下载兜底；用户在分享面板里取消算「取消」，不再追加下载。
 * 下载拿不到「成功」的信号（微信等内置浏览器可能什么都没下下来），`downloaded` 的含义是「已触发下载」。
 * 文件一律 `.txt`：安卓分享只认少数扩展名，日志与各节合在一个文本文件里，按节标题切开即可还原。
 *
 * 分享与下载都失灵的环境（应用内浏览器）还有第三条路：copyText 把全文放进剪贴板，用户粘贴进聊天。
 */
export { scrubUrl } from "../util.ts";
export type DeliverResult = "shared" | "downloaded" | "cancelled";
/** `<前缀>-诊断-YYYYMMDD-HHMMSS.txt`（本地时刻） */
export declare function diagnosticFileName(prefix: string, at: number): string;
/** 是否优先系统分享：主要指针是粗指针（手机、平板）为真；桌面与查询不可用时为假 */
export declare function prefersShare(): boolean;
export declare function deliverTextFile(name: string, text: string, options?: {
    share?: boolean;
}): Promise<DeliverResult>;
/**
 * 全文放进剪贴板：剪贴板 API 优先（要求安全上下文与用户手势）；没有或被拒时退回隐藏文本框 + 复制命令
 * （微信等内置浏览器常见）。都失败返回 false，不抛——调用方提示用户改用别的办法。
 */
export declare function copyText(text: string): Promise<boolean>;
