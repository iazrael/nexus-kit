/**
 * 诊断文件交付：系统分享优先（手机上能直接发给开发者），不支持或失败时下载兜底。文件一律 `.txt`——
 * 安卓分享只认少数扩展名，日志与后续各节合在一个文本文件里，按节标题切开即可还原。
 * 用户在分享面板里取消算「取消」，不再追加下载。
 */
import { pad } from "../util.js";
export { scrubUrl } from "../util.js";
/** `<前缀>-诊断-YYYYMMDD-HHMMSS.txt`（本地时刻） */
export function diagnosticFileName(prefix, at) {
    const d = new Date(at);
    return `${prefix}-诊断-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
}
/** object URL 回收延迟：点击后浏览器异步开始下载，立即回收在部分 Safari 上会下载空文件 */
const REVOKE_DELAY_MS = 30_000;
export async function deliverTextFile(name, text) {
    const file = new File([text], name, { type: "text/plain" });
    const nav = navigator;
    if (typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [file] })) {
        try {
            await nav.share({ files: [file], title: name });
            return "shared";
        }
        catch (error) {
            if (error instanceof Error && error.name === "AbortError")
                return "cancelled";
            // NotAllowedError（不在用户手势里）等：落到下载
        }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.append(a);
    try {
        a.click();
    }
    finally {
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    }
    return "downloaded";
}
