// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectWarmUrls, warmRuntimeCache } from "./offline-warm.ts";

const ORIGIN = "https://app.test";

describe("collectWarmUrls", () => {
  it("只收同源、落在运行时前缀内的路径；去查询串、去重、排序", () => {
    const urls = collectWarmUrls(
      [
        { name: `${ORIGIN}/data/b.json?v=1` },
        { name: `${ORIGIN}/data/a.json` },
        { name: `${ORIGIN}/data/a.json#x` },
        { name: `${ORIGIN}/assets/index-abc.js` },
        { name: "https://cdn.other/data/c.json" },
      ],
      ORIGIN,
      { prefixes: ["/data/"] },
    );
    expect(urls).toEqual(["/data/a.json", "/data/b.json"]);
  });

  it("额外登记地址与派生路径一并收入（派生同样过前缀过滤）", () => {
    const urls = collectWarmUrls([{ name: `${ORIGIN}/atlas/hero-0.json` }], ORIGIN, {
      prefixes: ["/atlas/"],
      extra: ["/atlas/map.webp", "/elsewhere/x"],
      expand: (p) => (p.endsWith(".json") ? [p.replace(/\.json$/, ".webp"), "/outside/y"] : []),
    });
    expect(urls).toEqual(["/atlas/hero-0.json", "/atlas/hero-0.webp", "/atlas/map.webp"]);
  });
});

describe("warmRuntimeCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  function patch(active: { postMessage: ReturnType<typeof vi.fn> } | null) {
    Object.defineProperty(window.navigator, "serviceWorker", { value: { ready: Promise.resolve({ active }) }, configurable: true });
  }
  function stubChannel() {
    const channel = { port1: { onmessage: null as null | (() => void) }, port2: {} };
    vi.stubGlobal("MessageChannel", function () {
      return channel;
    });
    return channel;
  }

  it("CACHE_URLS 消息带清单，回执即完成", async () => {
    const channel = stubChannel();
    const postMessage = vi.fn(() => queueMicrotask(() => channel.port1.onmessage?.()));
    patch({ postMessage });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await warmRuntimeCache(["/data/a.json"], logger);
    expect(postMessage).toHaveBeenCalledWith({ type: "CACHE_URLS", payload: { urlsToCache: ["/data/a.json"] } }, [channel.port2]);
    expect(logger.info).toHaveBeenCalledWith("离线补缓存完成", expect.anything());
  });

  it("SW 未激活：reject", async () => {
    patch(null);
    await expect(warmRuntimeCache([])).rejects.toThrow("SW 未激活");
  });

  it("回执超时：reject", async () => {
    vi.useFakeTimers();
    stubChannel();
    patch({ postMessage: vi.fn() });
    const p = warmRuntimeCache(["/data/a.json"]);
    const assertion = expect(p).rejects.toThrow("回执超时");
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });
});
