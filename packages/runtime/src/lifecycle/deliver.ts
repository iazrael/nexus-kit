/**
 * 诊断文件交付。触屏设备（主要指针是粗指针）优先系统分享——手机上能直接发给开发者；桌面直接下载，
 * 不弹系统分享面板。分享不支持或失败时下载兜底；用户在分享面板里取消算「取消」，不再追加下载。
 * 下载拿不到「成功」的信号（微信等内置浏览器可能什么都没下下来），`downloaded` 的含义是「已触发下载」。
 * 文件一律 `.txt`：安卓分享只认少数扩展名，日志与各节合在一个文本文件里，按节标题切开即可还原。
 *
 * 分享与下载都失灵的环境（应用内浏览器）还有第三条路：copyText 把全文放进剪贴板，用户粘贴进聊天。
 */

import { pad } from "../util.ts";

export { scrubUrl } from "../util.ts";

export type DeliverResult = "shared" | "downloaded" | "cancelled";

/** `<前缀>-诊断-YYYYMMDD-HHMMSS.txt`（本地时刻） */
export function diagnosticFileName(prefix: string, at: number): string {
  const d = new Date(at);
  return `${prefix}-诊断-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
}

/** object URL 回收延迟：点击后浏览器异步开始下载，立即回收在部分 Safari 上会下载空文件 */
const REVOKE_DELAY_MS = 30_000;

/** 是否优先系统分享：主要指针是粗指针（手机、平板）为真；桌面与查询不可用时为假 */
export function prefersShare(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

export async function deliverTextFile(name: string, text: string, options: { share?: boolean } = {}): Promise<DeliverResult> {
  const file = new File([text], name, { type: "text/plain" });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (
    (options.share ?? prefersShare()) &&
    typeof nav.share === "function" &&
    typeof nav.canShare === "function" &&
    nav.canShare({ files: [file] })
  ) {
    try {
      await nav.share({ files: [file], title: name });
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
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
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
  return "downloaded";
}

/**
 * 全文放进剪贴板：剪贴板 API 优先（要求安全上下文与用户手势）；没有或被拒时退回隐藏文本框 + 复制命令
 * （微信等内置浏览器常见）。都失败返回 false，不抛——调用方提示用户改用别的办法。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 被拒（不在手势里、权限策略）：退回复制命令
  }
  // iOS Safari：select() 对隐藏的只读文本框常选不中，要 setSelectionRange；字号小于 16px 聚焦会触发页面缩放。
  // 复制后焦点还给原来的元素。这条退路只在 happy-dom 里单测过接线，iOS 与微信上的实际效果没有实测
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  Object.assign(area.style, { position: "fixed", top: "0", left: "0", opacity: "0", fontSize: "16px" });
  document.body.append(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus();
  }
}
