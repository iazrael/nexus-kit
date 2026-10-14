// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, deliverTextFile, diagnosticFileName, prefersShare } from "./deliver.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (navigator as { canShare?: unknown }).canShare;
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { clipboard?: unknown }).clipboard;
});

/** happy-dom 的 navigator.clipboard 只有 getter：用自有属性盖住，afterEach 里 delete 即恢复 */
function stubClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

/** 主要指针是否粗指针（触屏） */
function stubPointer(coarse: boolean): void {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)" ? coarse : false }));
}

describe("diagnosticFileName", () => {
  it("前缀 + 本地时刻，只含文件名安全字符", () => {
    expect(diagnosticFileName("my-app", new Date(2026, 9, 14, 9, 5, 7).getTime())).toBe("my-app-诊断-20261014-090507.txt");
  });
});

describe("deliverTextFile", () => {
  it("触屏设备优先分享，桌面（精确指针）直接下载；可显式指定", () => {
    stubPointer(true);
    expect(prefersShare()).toBe(true);
    stubPointer(false);
    expect(prefersShare()).toBe(false);
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersShare()).toBe(false);
  });

  it("桌面即使支持分享也直接下载", async () => {
    stubPointer(false);
    const share = vi.fn(async () => undefined);
    Object.assign(navigator, { canShare: () => true, share });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    expect(await deliverTextFile("a.txt", "内容")).toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("支持分享文件时走系统分享；用户取消返回 cancelled 且不再下载", async () => {
    stubPointer(true);
    const share = vi.fn(async () => undefined);
    Object.assign(navigator, { canShare: () => true, share });
    expect(await deliverTextFile("a.txt", "内容")).toBe("shared");
    const file = (share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0]!;
    expect(file.name).toBe("a.txt");
    expect(await file.text()).toBe("内容");

    Object.assign(navigator, { share: vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }))) });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    expect(await deliverTextFile("a.txt", "内容")).toBe("cancelled");
    expect(click).not.toHaveBeenCalled();
  });

  it("不支持分享、或分享因非用户原因失败：下载兜底，用完回收 object URL", async () => {
    stubPointer(true);
    vi.useFakeTimers();
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("b.txt");
      expect(this.href).toBe("blob:x");
    });
    expect(await deliverTextFile("b.txt", "x")).toBe("downloaded");
    Object.assign(navigator, {
      canShare: () => true,
      share: vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" }))),
    });
    expect(await deliverTextFile("b.txt", "x")).toBe("downloaded");
    expect(click).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:x");
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    vi.useRealTimers();
  });
});

describe("copyText", () => {
  it("优先剪贴板 API", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard({ writeText });
    expect(await copyText("全文")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("全文");
  });

  it("退回复制命令时：全选用 setSelectionRange（iOS 上 select() 常选不中）、字号 16px 防缩放、复制后焦点还原", async () => {
    stubClipboard(undefined);
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    let seen: { start: number | null; end: number | null; fontSize: string } | null = null;
    Object.assign(document, {
      execCommand: () => {
        const area = document.querySelector("textarea")!;
        seen = { start: area.selectionStart, end: area.selectionEnd, fontSize: area.style.fontSize };
        return true;
      },
    });
    expect(await copyText("12345")).toBe(true);
    expect(seen).toEqual({ start: 0, end: 5, fontSize: "16px" });
    expect(document.activeElement).toBe(opener);
  });

  it("剪贴板 API 没有或被拒：退回隐藏文本框 + 复制命令；都失败返回 false，不抛", async () => {
    stubClipboard({ writeText: vi.fn(async () => Promise.reject(new Error("NotAllowedError"))) });
    const exec = vi.fn(() => true);
    Object.assign(document, { execCommand: exec });
    expect(await copyText("全文")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelectorAll("textarea")).toHaveLength(0);

    stubClipboard(undefined);
    Object.assign(document, { execCommand: () => false });
    expect(await copyText("全文")).toBe(false);
    Object.assign(document, {
      execCommand: () => {
        throw new Error("不支持");
      },
    });
    expect(await copyText("全文")).toBe(false);
  });
});
