// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPersistentStorage } from "./persist.ts";

afterEach(() => {
  delete (window.navigator as { storage?: unknown }).storage;
});

describe("requestPersistentStorage", () => {
  it("授予/拒绝/异常/不支持四路都不抛，结果如实返回", async () => {
    const storage = {
      persist: vi.fn(async () => true),
      estimate: vi.fn(async () => ({ usage: 3 * 1048576, quota: 512 * 1048576 })),
    };
    Object.defineProperty(window.navigator, "storage", { value: storage, configurable: true });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(requestPersistentStorage(logger)).resolves.toBe("granted");
    expect(logger.info).toHaveBeenCalledWith("持久化存储已授予", { usageMB: 3, quotaMB: 512 });
    storage.persist.mockResolvedValueOnce(false);
    await expect(requestPersistentStorage(logger)).resolves.toBe("denied");
    storage.persist.mockRejectedValueOnce(new Error("x"));
    await expect(requestPersistentStorage(logger)).resolves.toBe("failed");
    Object.defineProperty(window.navigator, "storage", { value: {}, configurable: true });
    await expect(requestPersistentStorage()).resolves.toBe("unsupported");
  });
});
