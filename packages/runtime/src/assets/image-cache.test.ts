import { describe, expect, it } from "vitest";
import { createImageCache } from "./image-cache.ts";
import { createLoader } from "./loader.ts";

const MB = 1024 * 1024;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 假位图：url 里带尺寸，形如 /a-512x512.png */
class FakeBitmap {
  closed = false;
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  close() {
    this.closed = true;
    this.width = 0;
    this.height = 0;
  }
}

function rig(budgetMB = 2) {
  const fetched: string[] = [];
  const evicted: string[] = [];
  const warns: string[] = [];
  const gauges = new Map<string, () => number | null>();
  const gates = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();
  const loader = createLoader({ concurrency: 4 });
  const cache = createImageCache({
    loader,
    budgetMB,
    fetch: async (url: string) => {
      fetched.push(url);
      if (url.includes("hold")) await new Promise<void>((resolve, reject) => gates.set(url, { resolve, reject }));
      if (url.includes("404")) return new Response("", { status: 404 });
      return new Response(url);
    },
    decode: async (blob: Blob) => {
      const [, w, h] = /-(\d+)x(\d+)/.exec(await blob.text())!;
      return new FakeBitmap(Number(w), Number(h)) as unknown as ImageBitmap;
    },
    onEvict: (url) => evicted.push(url),
    perf: { registerGauge: (n, r) => (gauges.set(n, r), () => gauges.delete(n)) },
    log: { debug: () => undefined, info: () => undefined, warn: (m, d) => warns.push(`${m} ${JSON.stringify(d)}`), error: () => undefined },
  });
  return { cache, loader, fetched, evicted, warns, gauges, gates };
}

const fake = (b: ImageBitmap) => b as unknown as FakeBitmap;

describe("createImageCache", () => {
  it("acquire 下载解码、按宽×高×4 记账；同时取同一张只下一次；释放后再取命中缓存不重下", async () => {
    const { cache, fetched } = rig();
    const [a, b] = await Promise.all([cache.acquire("/a-512x512.png", { tier: 1 }), cache.acquire("/a-512x512.png", { tier: 3 })]);
    expect(a).toBe(b);
    expect(fetched).toEqual(["/a-512x512.png"]);
    expect(cache.stats()).toMatchObject({ images: 1, bytes: MB, referenced: 1, hits: 0, misses: 1 });
    cache.release("/a-512x512.png");
    cache.release("/a-512x512.png");
    expect(cache.stats().referenced).toBe(0);
    expect(await cache.acquire("/a-512x512.png", { tier: 1 })).toBe(a);
    expect(fetched).toHaveLength(1);
    expect(cache.stats().hits).toBe(1);
    expect(cache.peek("/a-512x512.png")).toBe(a);
    expect(cache.peek("/none.png")).toBeUndefined();
  });

  it("超预算从最久没用的开始淘汰：立即 close、扣账、通知宿主；被引用的不淘汰，超了照实记账", async () => {
    const { cache, evicted } = rig(2);
    const a = await cache.acquire("/a-512x512.png", { tier: 1 }); // 1MB
    const b = await cache.acquire("/b-512x512.png", { tier: 1 }); // 1MB
    cache.release("/a-512x512.png");
    cache.release("/b-512x512.png"); // a 比 b 更久没用
    const c = await cache.acquire("/c-512x512.png", { tier: 1 }); // 合计 3MB > 2MB → 淘汰 a
    expect(fake(a).closed).toBe(true);
    expect(fake(b).closed).toBe(false);
    expect(evicted).toEqual(["/a-512x512.png"]);
    expect(cache.stats()).toMatchObject({ images: 2, bytes: 2 * MB, evictions: 1 });
    const d = await cache.acquire("/d-1024x1024.png", { tier: 1 }); // 4MB，淘汰 b 后仍超（c、d 都被引用）
    expect(fake(b).closed).toBe(true);
    expect(cache.stats()).toMatchObject({ bytes: 5 * MB, referenced: 2 });
    expect(fake(c).closed || fake(d).closed).toBe(false);
    // d 解码完成那一刻 b 还没被淘汰，三张同时在内存里：峰值是 6MB，不是淘汰后的 5MB
    expect(cache.stats().peakBytes).toBe(6 * MB);
  });

  it("失败不进缓存，错误给调用方，下次重新下载；HTTP 错误码算失败", async () => {
    const { cache, fetched } = rig();
    await expect(cache.acquire("/x-404-1x1.png", { tier: 1 })).rejects.toThrow(/404/);
    expect(cache.stats()).toMatchObject({ images: 0, referenced: 0 });
    await expect(cache.acquire("/x-404-1x1.png", { tier: 1 })).rejects.toThrow(/404/);
    expect(fetched).toHaveLength(2);
  });

  it("取消：被取消的 acquire 不占引用；全部取消且没发出则不下载；已在下载的下完进缓存（引用为零，可被淘汰）", async () => {
    const { cache, loader, fetched, gates } = rig();
    loader.hold(new Promise(() => undefined), 60_000);
    const ac = new AbortController();
    const p = cache.acquire("/q-1x1.png", { tier: 3 }, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(fetched).toEqual([]);
    expect(cache.stats().images).toBe(0);

    const ac2 = new AbortController();
    const p2 = cache.acquire("/hold-512x512.png", { tier: 1 }, { signal: ac2.signal });
    await flush();
    expect(fetched).toEqual(["/hold-512x512.png"]);
    ac2.abort();
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
    gates.get("/hold-512x512.png")!.resolve();
    await flush();
    await flush();
    expect(cache.stats()).toMatchObject({ images: 1, referenced: 0, bytes: MB });
  });

  it("解码完成与取消挤在同一刻：引用归零的图进 LRU、按预算淘汰，不会永远留在缓存里", async () => {
    const ac = new AbortController();
    const loader = createLoader();
    const cache = createImageCache({
      loader,
      budgetMB: 0,
      fetch: async () => new Response("x"),
      decode: async () => {
        queueMicrotask(() => ac.abort()); // 解码已返回、调用方还没拿到结果时取消
        return new FakeBitmap(10, 10) as unknown as ImageBitmap;
      },
    });
    await expect(cache.acquire("/race.png", { tier: 1 }, { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.stats()).toMatchObject({ images: 0, referenced: 0, bytes: 0, evictions: 1 });
  });

  it("缓存命中时信号已取消：直接拒绝、不占引用", async () => {
    const { cache } = rig();
    await cache.acquire("/a-512x512.png", { tier: 1 });
    await expect(cache.acquire("/a-512x512.png", { tier: 1 }, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(cache.stats().hits).toBe(0);
    cache.release("/a-512x512.png");
    expect(cache.stats().referenced).toBe(0);
  });

  it("HTTP 错误码：取消响应体，不占着连接", async () => {
    let cancelled = false;
    const cache = createImageCache({
      loader: createLoader(),
      budgetMB: 1,
      fetch: async () => {
        const body = new ReadableStream({ cancel: () => void (cancelled = true) });
        return new Response(body, { status: 500 });
      },
    });
    await expect(cache.acquire("/e.png", { tier: 1 })).rejects.toThrow(/500/);
    expect(cancelled).toBe(true);
  });

  it("dispose 之后：acquire 直接拒绝；收尾时的 release 不当成多释放报 warn", async () => {
    const { cache, warns } = rig();
    await cache.acquire("/a-512x512.png", { tier: 1 });
    cache.dispose();
    cache.release("/a-512x512.png");
    expect(warns).toEqual([]);
    await expect(cache.acquire("/b-1x1.png", { tier: 1 })).rejects.toThrow(/dispose/);
  });

  it("多释放一次记 warn 不抛；perf 登记位图字节与张数；dispose 关掉全部位图并注销", async () => {
    const { cache, warns, gauges } = rig();
    const a = await cache.acquire("/a-512x512.png", { tier: 1 });
    expect(gauges.get("assets.bitmapMB")!()).toBe(1);
    expect(gauges.get("assets.bitmaps")!()).toBe(1);
    cache.release("/a-512x512.png");
    expect(() => cache.release("/a-512x512.png")).not.toThrow();
    expect(() => cache.release("/never.png")).not.toThrow();
    expect(warns.filter((w) => /多释放/.test(w))).toHaveLength(2);
    cache.dispose();
    expect(fake(a).closed).toBe(true);
    expect(gauges.has("assets.bitmapMB")).toBe(false);
  });
});
