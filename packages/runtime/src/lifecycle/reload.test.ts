import { describe, expect, it, vi } from "vitest";
import { reloadToLatestVersion, type SwLike } from "./reload.ts";

describe("reloadToLatestVersion", () => {
  it("runtime 入口：用同一份 reloadLatest，刷新时 resolve；新版本下载中时回调 onUpdating", async () => {
    const posted: unknown[] = [];
    const listeners: Array<() => void> = [];
    const worker = { postMessage: (m: unknown) => (posted.push(m), setTimeout(() => listeners.forEach((l) => l()), 5)) };
    const reg = { waiting: null as typeof worker | null, installing: {} as unknown, update: async () => undefined };
    setTimeout(() => {
      reg.installing = null;
      reg.waiting = worker;
    }, 60);
    const sw: SwLike = { controller: {}, getRegistration: async () => reg, addEventListener: (_t, l) => void listeners.push(l) };
    const reload = vi.fn();
    const onUpdating = vi.fn();
    await reloadToLatestVersion({ sw, reload, onUpdating, timeoutMs: 2000 });
    expect(onUpdating).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([{ type: "SKIP_WAITING" }]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("不支持 SW：直接刷新", async () => {
    const reload = vi.fn();
    await reloadToLatestVersion({ sw: null, reload });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
