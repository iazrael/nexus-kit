// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverTextFile, diagnosticFileName } from "./deliver.ts";

afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as { canShare?: unknown }).canShare;
  delete (navigator as { share?: unknown }).share;
});

describe("diagnosticFileName", () => {
  it("前缀 + 本地时刻，只含文件名安全字符", () => {
    expect(diagnosticFileName("my-app", new Date(2026, 9, 14, 9, 5, 7).getTime())).toBe("my-app-诊断-20261014-090507.txt");
  });
});

describe("deliverTextFile", () => {
  it("支持分享文件时走系统分享；用户取消返回 cancelled 且不再下载", async () => {
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
