/**
 * 图像缓存（机制见 docs/架构算法/图像资源.md）：管「解码后的图放多久」。
 *
 * 解码位图加载即占进程内存（宽 × 高 × 4），与画没画到屏幕无关；只置空引用要等垃圾回收才释放，换页时新旧两份
 * 同时存活（旧项目A性能与显存文档「显存之外」一节）。所以这里按引用计数持有、引用为零进 LRU、超预算从最久没用的开始
 * 淘汰，淘汰时立即 close() 并扣账，再通知宿主销毁自己基于它建的纹理。
 *
 * - acquire 经调度器下载并解码，同一张同时取只下一次；成功才占一个引用，失败或被取消不占。
 * - release 只对成功的 acquire 调；多释放记 warn 不抛。
 * - 被引用的图不淘汰：超预算就照实记账（预算管的是「不用了还留着」的那部分）。
 * - 失败不进缓存，下次 acquire 重新下载。
 */
import type { Logger } from "../log/store.ts";
import { errText, scrubUrl } from "../util.ts";
import type { GaugeRegistry, Loader, Priority } from "./loader.ts";

export interface ImageCacheOptions {
  loader: Loader;
  /** 不再被引用的图最多留多少（与被引用的合计算），单位 MB */
  budgetMB: number;
  /** 默认 globalThis.fetch */
  fetch?: (url: string) => Promise<Response>;
  /** 默认 createImageBitmap */
  decode?: (blob: Blob) => Promise<ImageBitmap>;
  /** 淘汰后通知宿主（此时位图已 close）：宿主在这里销毁基于它上传的纹理 */
  onEvict?: (url: string) => void;
  /** 传入时登记 assets.bitmapMB / assets.bitmaps 两个水位指标 */
  perf?: GaugeRegistry;
  log?: Logger;
}

export interface ImageCacheStats {
  /** 已解码在内存里的张数 */
  images: number;
  /** 其中正被引用的张数 */
  referenced: number;
  /** 解码字节合计（宽 × 高 × 4） */
  bytes: number;
  /** 本局解码字节最高点 */
  peakBytes: number;
  budgetBytes: number;
  hits: number;
  misses: number;
  evictions: number;
}

interface Entry {
  refs: number;
  bitmap: ImageBitmap | null;
  bytes: number;
}

const MB = 1024 * 1024;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function createImageCache(options: ImageCacheOptions) {
  const { loader, log } = options;
  if (!(options.budgetMB >= 0)) throw new RangeError(`图像缓存预算须为非负数：${String(options.budgetMB)}`);
  const budgetBytes = options.budgetMB * MB;
  const fetchImage = options.fetch ?? ((url: string) => globalThis.fetch(url));
  const decode = options.decode ?? ((blob: Blob) => createImageBitmap(blob));
  const entries = new Map<string, Entry>();
  /** 已解码、引用为零的图；Map 的插入顺序即最久没用在前 */
  const lru = new Map<string, Entry>();
  let bytes = 0;
  let peakBytes = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let disposed = false;

  function evict(url: string, e: Entry): void {
    lru.delete(url);
    entries.delete(url);
    e.bitmap?.close();
    bytes -= e.bytes;
    evictions++;
    try {
      options.onEvict?.(url);
    } catch (error) {
      log?.warn("宿主的淘汰回调出错（位图已关闭，不影响缓存）", { url: scrubUrl(url), error: errText(error) });
    }
  }

  function enforce(): void {
    for (const [url, e] of lru) {
      if (bytes <= budgetBytes) return;
      evict(url, e);
    }
    if (bytes > budgetBytes) log?.debug("解码位图超预算，剩下的都在被引用", { MB: round1(bytes / MB), budgetMB: options.budgetMB });
  }

  /** 引用归零的已解码图进 LRU（最久没用排最前），再按预算淘汰 */
  function park(url: string, e: Entry): void {
    if (e.refs !== 0 || e.bitmap === null || entries.get(url) !== e) return;
    lru.set(url, e);
    enforce();
  }

  async function load(url: string, entry: Entry): Promise<ImageBitmap> {
    let bitmap: ImageBitmap;
    try {
      const res = await fetchImage(url);
      if (!res.ok) {
        // 不读的响应体要取消，否则连接要等垃圾回收才放回，白占一个并发位
        void res.body?.cancel().catch(() => undefined);
        throw new Error(`加载图像失败：HTTP ${res.status} ${scrubUrl(url)}`);
      }
      bitmap = await decode(await res.blob());
    } catch (error) {
      if (entries.get(url) === entry) entries.delete(url);
      log?.warn("图像加载失败", { url: scrubUrl(url), error: errText(error) });
      throw error;
    }
    if (entries.get(url) !== entry) {
      // 加载途中缓存已 dispose：没人管这张图了，立即关掉
      bitmap.close();
      throw new Error(`图像缓存已 dispose：${scrubUrl(url)}`);
    }
    entry.bitmap = bitmap;
    entry.bytes = bitmap.width * bitmap.height * 4;
    bytes += entry.bytes;
    if (bytes > peakBytes) peakBytes = bytes;
    // 调用方都取消了、请求已在飞：下完照样留着（引用为零进 LRU，可被淘汰）
    park(url, entry);
    enforce();
    return bitmap;
  }

  const unregister = options.perf
    ? [
        options.perf.registerGauge("assets.bitmapMB", () => round1(bytes / MB)),
        options.perf.registerGauge("assets.bitmaps", () => entries.size - [...entries.values()].filter((e) => e.bitmap === null).length),
      ]
    : [];

  return {
    /** 取一张图并占一个引用；成功后用完调 release */
    acquire(url: string, priority: Priority, opts: { signal?: AbortSignal } = {}): Promise<ImageBitmap> {
      if (disposed) return Promise.reject(new Error(`图像缓存已 dispose：${scrubUrl(url)}`));
      // 已取消的信号：命中也不给、不占引用（调用方按取消处理，不会 release）
      if (opts.signal?.aborted) return Promise.reject(opts.signal.reason ?? new DOMException("已取消", "AbortError"));
      let entry = entries.get(url);
      if (entry?.bitmap) {
        entry.refs++;
        lru.delete(url);
        hits++;
        return Promise.resolve(entry.bitmap);
      }
      if (entry === undefined) {
        entry = { refs: 0, bitmap: null, bytes: 0 };
        entries.set(url, entry);
        misses++;
      }
      const own = entry;
      own.refs++;
      return loader
        .schedule(url, priority, () => load(url, own), opts)
        .catch((error: unknown) => {
          own.refs--;
          // 全部取消、请求没发出：调度器已出队，这条空记录也撤掉
          if (own.refs === 0 && own.bitmap === null && !loader.has(url) && entries.get(url) === own) entries.delete(url);
          // 解码已完成、调用方恰在拿到结果前取消：图已在内存里，引用归零就进 LRU，否则永远淘汰不掉
          park(url, own);
          throw error;
        });
    },

    /** 放回一个引用；引用为零进 LRU，超预算时可能被淘汰 */
    release(url: string): void {
      if (disposed) return; // dispose 后宿主收尾时的 release 是正常的，不当成多释放
      const e = entries.get(url);
      if (e === undefined || e.bitmap === null || e.refs === 0) {
        log?.warn("多释放了一次图像（没有对应的成功 acquire）", { url: scrubUrl(url) });
        return;
      }
      e.refs--;
      park(url, e);
    },

    /** 已解码的图（不改引用、不算命中）；没有返回 undefined */
    peek: (url: string): ImageBitmap | undefined => entries.get(url)?.bitmap ?? undefined,

    stats(): ImageCacheStats {
      let images = 0;
      let referenced = 0;
      for (const e of entries.values()) {
        if (e.bitmap === null) continue;
        images++;
        if (e.refs > 0) referenced++;
      }
      return { images, referenced, bytes, peakBytes, budgetBytes, hits, misses, evictions };
    },

    /** 关掉全部位图（包括还在被引用的）、注销水位指标；之后在飞的加载下完即关，acquire 直接拒绝，release 忽略 */
    dispose(): void {
      disposed = true;
      for (const e of entries.values()) e.bitmap?.close();
      entries.clear();
      lru.clear();
      bytes = 0;
      for (const off of unregister.splice(0)) off();
    },
  };
}

export type ImageCache = ReturnType<typeof createImageCache>;
