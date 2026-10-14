/**
 * 图像资源的真浏览器 e2e：不用模板（模板没有图片），在 .e2e/e2e-assets-site 放一个只引用 runtime 构建产物的
 * 测试页。图片请求由 Playwright 拦下：按文件名里的尺寸现做 PNG，每个请求压 800ms 延迟模拟慢网，并记下每个请求
 * 何时开始、同时在飞多少。断言：
 *   1. 关键闸门放行前，档位 2、3 的图一张都没请求；档位 1 照发；
 *   2. 同时在飞的请求不超过调度器的并发上限（测试页设 3，低于浏览器每域 6 路，排除浏览器替我们限流）；
 *   3. 同一张图同时取两次只请求一次；
 *   4. 超预算淘汰的位图真的关掉了（ImageBitmap 关闭后宽高变 0），宿主收到淘汰通知；
 *   5. 接了 /perf：采样点里有 assets.bitmapMB 等指标，导出的 JSONL 里也有。
 */
import { mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright";
import type { ImageCache, Loader } from "../packages/runtime/src/assets/index.ts";
import type { Perf } from "../packages/runtime/src/perf/index.ts";
import { assertPackagesBuilt, KIT, serve } from "./e2e-lib.ts";

/** 测试页挂在 window.__t 上的对象 */
interface Harness {
  perf: Perf;
  loader: Loader;
  cache: ImageCache;
  evicted: string[];
}

const PORT = Number(process.env.E2E_ASSETS_PORT ?? 4319);
const URL = `http://127.0.0.1:${PORT}/`;
const SITE = join(KIT, ".e2e/e2e-assets-site");
const DELAY_MS = 800;
const log = (m: string): void => console.log(`[e2e-assets] ${m}`);

function expect(cond: boolean, what: string): void {
  if (!cond) throw new Error(`断言失败：${what}`);
  log(`✓ ${what}`);
}

/** 纯色 RGBA PNG（不压图像质量，只要浏览器能解码出这个尺寸） */
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>assets e2e</title>
<script type="module">
  import { createLogStore } from "./runtime/log/index.js";
  import { createPerf } from "./runtime/perf/index.js";
  import { createLoader, createImageCache } from "./runtime/assets/index.js";
  const logs = createLogStore({ key: "e2e.log", console: null });
  const perf = createPerf({ prefix: "e2e", store: logs, version: "v0.0.0", build: 0 });
  const loader = createLoader({ concurrency: 3, log: logs.log("assets"), perf });
  const evicted = [];
  const cache = createImageCache({ loader, budgetMB: 1, perf, log: logs.log("assets"), onEvict: (u) => evicted.push(u) });
  window.__t = { logs, perf, loader, cache, evicted };
  document.documentElement.dataset.ready = "1";
</script>`;

async function main(): Promise<void> {
  assertPackagesBuilt();
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  cpSync(join(KIT, "packages/runtime/dist"), join(SITE, "runtime"), { recursive: true });
  writeFileSync(join(SITE, "index.html"), PAGE);
  const server = await serve(SITE, PORT);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const started = new Map<string, number>();
    const startedAt = new Map<string, number>();
    let inflight = 0;
    let peak = 0;
    await page.route(/\/img\//, async (route) => {
      const name = new globalThis.URL(route.request().url()).pathname.split("/").pop()!;
      started.set(name, (started.get(name) ?? 0) + 1);
      startedAt.set(name, Date.now());
      inflight++;
      peak = Math.max(peak, inflight);
      const [, w, h] = /-(\d+)x(\d+)\.png$/.exec(name) ?? [];
      await new Promise((r) => setTimeout(r, DELAY_MS));
      inflight--;
      await route.fulfill({ status: 200, contentType: "image/png", body: png(Number(w), Number(h)) });
    });
    await page.goto(URL);
    await page.waitForSelector("html[data-ready]");

    // 1~3：关键两张（档位 1）挂闸门；后面 8 张不急的（档位 3）、2 张附近的（档位 2）、同一张关键图再取一次
    const result = await page.evaluate(async () => {
      const { cache, loader } = (window as unknown as { __t: Harness }).__t;
      const t0 = performance.now();
      const critical = Promise.all([cache.acquire("/img/c1-64x64.png", { tier: 1 }), cache.acquire("/img/c2-64x64.png", { tier: 1 })]);
      loader.hold(critical, 30_000);
      let criticalAt = 0;
      let criticalEpoch = 0;
      void critical.then(() => ((criticalAt = performance.now() - t0), (criticalEpoch = Date.now())));
      const rest = [
        ...Array.from({ length: 8 }, (_, i) => cache.acquire(`/img/idle${i}-32x32.png`, { tier: 3 })),
        cache.acquire("/img/near0-32x32.png", { tier: 2 }),
        cache.acquire("/img/near1-32x32.png", { tier: 2 }),
        cache.acquire("/img/c1-64x64.png", { tier: 3 }),
      ];
      const snapshotBefore = loader.snapshot();
      await Promise.all([critical, ...rest]);
      return { criticalAt, criticalEpoch, queuedBefore: snapshotBefore.queued.length, gateOpenBefore: snapshotBefore.gateOpen };
    });
    log(`关键两张 ${Math.round(result.criticalAt)}ms 有结论，放行前排队 ${result.queuedBefore} 个`);
    expect(!result.gateOpenBefore && result.queuedBefore === 10, "闸门放行前档位 2、3 的 10 张都在排队");
    const early = [...startedAt].filter(([n, at]) => /^(idle|near)/.test(n) && at < result.criticalEpoch - 20);
    expect(early.length === 0, `档位 2、3 的请求都在关键图有结论之后才发出（提前发出 ${early.length} 个）`);
    expect(result.criticalAt < DELAY_MS * 2, "关键图没被不急的图挤到后面（一轮延迟内就到）");
    expect(peak <= 3, `同时在飞的请求不超过并发上限 3（实际峰值 ${peak}）`);
    expect(started.get("c1-64x64.png") === 1, "同一张图同时取两次只请求一次");
    expect([...started.keys()].length === 12, `12 张图各请求一次（实际 ${[...started.keys()].length} 张）`);

    // 4：预算 1MB，放回后再取一张 512×512（1MB）→ 最久没用的被淘汰、位图关闭
    const evict = await page.evaluate(async () => {
      const { cache, evicted } = (window as unknown as { __t: Harness }).__t;
      const a = await cache.acquire("/img/big-a-512x512.png", { tier: 1 });
      cache.release("/img/big-a-512x512.png");
      const b = await cache.acquire("/img/big-b-512x512.png", { tier: 1 });
      return { aWidth: a.width, bWidth: b.width, evicted: [...evicted], stats: cache.stats() };
    });
    expect(evict.aWidth === 0 && evict.bWidth === 512, `被淘汰的位图已关闭（宽 ${evict.aWidth}），新图正常（宽 ${evict.bWidth}）`);
    expect(evict.evicted.includes("/img/big-a-512x512.png"), "宿主收到淘汰通知");
    expect(evict.stats.evictions >= 1 && evict.stats.hits === 0, `统计记了淘汰（${evict.stats.evictions} 次）`);

    // 5：接 /perf：采样点与 JSONL 里都有位图指标
    const vit = await page.evaluate(() => {
      const { perf, cache } = (window as unknown as { __t: Harness }).__t;
      const s = perf.sampleNow();
      return { v: s.v as Record<string, number | null>, jsonl: perf.exportJsonl() as string, stats: cache.stats() };
    });
    const expectMB = Math.round((vit.stats.bytes / 1024 / 1024) * 10) / 10;
    expect(
      vit.v["assets.bitmapMB"] === expectMB && vit.v["assets.bitmaps"] === vit.stats.images,
      `水位采样的 assets.bitmapMB（${vit.v["assets.bitmapMB"]}）与张数和缓存统计一致`,
    );
    expect(vit.v["assets.queued"] === 0 && vit.v["assets.running"] === 0, "水位采样有排队与在飞数");
    expect(vit.jsonl.includes(`"assets.bitmapMB":${expectMB}`), "导出的 JSONL 里有位图指标");

    log("通过：关键闸门压住不急的图 → 并发不超上限 → 同图只下一次 → 超预算淘汰即关位图 → 指标进水位");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[e2e-assets] 失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
