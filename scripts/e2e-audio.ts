/**
 * 音频的真浏览器 e2e：与图像资源一样，在 .e2e/e2e-audio-site 放一个只引用 runtime 构建产物的测试页。音频请求由
 * Playwright 拦下，按文件名现做 WAV（beep-120 = 120ms），slow-* 压 800ms 延迟、*-404 回 404，并记下每个文件请求了几次。
 * Chromium 里断言：
 *   1. 解锁前的音效丢掉、解锁前点的音乐记下意图；真实点击解锁后音乐补播；
 *   2. 同 key 限频生效；同时发声不超上限；音效播完节点回收（只剩音乐）；
 *   3. 懒解码晚于补播时限的音效不再响；404 的文件只请求一次（永不重试）；
 *   4. 引擎挂起时 play 先 resume 再发声；
 *   5. 主动 close() 掉引擎模拟假死，触发回前台：重建新引擎，音乐按意图续上；
 *   6. 停掉音乐后活跃节点归零；解码字节进 /perf 水位。
 * iOS 的 interrupted、锁屏与来电只能真机验（见 docs/架构算法/音频.md 的真机清单）。
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import type { AudioHost, SamplePlayer } from "../packages/runtime/src/audio/index.ts";
import type { Perf } from "../packages/runtime/src/perf/index.ts";
import { assertPackagesBuilt, KIT, serve } from "./e2e-lib.ts";

const PORT = Number(process.env.E2E_AUDIO_PORT ?? 4320);
const URL = `http://127.0.0.1:${PORT}/`;
const SITE = join(KIT, ".e2e/e2e-audio-site");
const log = (m: string): void => console.log(`[e2e-audio] ${m}`);

interface Harness {
  host: AudioHost;
  player: SamplePlayer;
  perf: Perf;
}

function expect(cond: boolean, what: string): void {
  if (!cond) throw new Error(`断言失败：${what}`);
  log(`✓ ${what}`);
}

/** 16 位单声道 PCM WAV，正弦 440Hz */
function wav(ms: number): Buffer {
  const rate = 22050;
  const n = Math.round((rate * ms) / 1000);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // 单声道
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>audio e2e</title>
<button id="unlock">开始</button>
<script type="module">
  import { createLogStore } from "./runtime/log/index.js";
  import { createPerf } from "./runtime/perf/index.js";
  import { createLoader } from "./runtime/assets/index.js";
  import { createAudioHost, createSamplePlayer } from "./runtime/audio/index.js";
  const logs = createLogStore({ key: "e2e.log", console: null });
  const perf = createPerf({ prefix: "e2e", store: logs, version: "v0.0.0", build: 0 });
  const host = createAudioHost({ buses: ["music", "sfx"], log: logs.log("audio") });
  const player = createSamplePlayer({
    host, loader: createLoader(), urlOf: (k) => "/snd/" + k + ".wav", maxVoices: 2, perf, log: logs.log("audio"),
  });
  document.getElementById("unlock").addEventListener("click", () => host.unlock());
  window.__t = { host, player, perf, logs };
  document.documentElement.dataset.ready = "1";
</script>`;

const snap = (page: Page) => page.evaluate(() => (window as unknown as { __t: Harness }).__t.player.snapshot());
async function until(page: Page, cond: () => Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`等待超时：${what}`);
}

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
    const hits = new Map<string, number>();
    await page.route(/\/snd\//, async (route) => {
      const name = new globalThis.URL(route.request().url()).pathname
        .split("/")
        .pop()!
        .replace(/\.wav$/, "");
      hits.set(name, (hits.get(name) ?? 0) + 1);
      if (name.endsWith("-404")) return route.fulfill({ status: 404, body: "" });
      if (name.startsWith("slow-")) await new Promise((r) => setTimeout(r, 800));
      const ms = Number(/-(\d+)$/.exec(name)?.[1] ?? 200);
      return route.fulfill({ status: 200, contentType: "audio/wav", body: wav(ms) });
    });
    await page.goto(URL);
    await page.waitForSelector("html[data-ready]");

    // 1. 解锁前
    await page.evaluate(() => {
      const { player } = (window as unknown as { __t: Harness }).__t;
      player.play("beep-120");
      player.playMusic("loop-2000");
    });
    expect((await snap(page)).started === 0 && !hits.has("beep-120"), "解锁前的音效直接丢、不发请求");
    expect(
      (await page.evaluate(() => (window as unknown as { __t: Harness }).__t.player.musicIntent())) === "loop-2000",
      "解锁前点的音乐记下了意图",
    );
    await page.click("#unlock");
    await until(page, async () => (await snap(page)).active === 1, "解锁后音乐补播");
    expect((await snap(page)).unlocked, "真实点击解锁后引擎在 running，音乐补播");

    // 2. 限频、并发上限、回收
    await page.evaluate(() => {
      const { player } = (window as unknown as { __t: Harness }).__t;
      player.warm(["beep-120", "a-300", "b-300", "c-300"], { tier: 0 });
    });
    await until(page, async () => (await snap(page)).buffers >= 5, "预热解码完成");
    const before = (await snap(page)).started;
    await page.evaluate(() => {
      const { player } = (window as unknown as { __t: Harness }).__t;
      player.play("beep-120");
      player.play("beep-120");
      player.play("beep-120");
    });
    await page.waitForTimeout(30);
    expect((await snap(page)).started === before + 1, "同 key 50ms 内连发三次只响一次");
    await page.evaluate(() => {
      const { player } = (window as unknown as { __t: Harness }).__t;
      player.play("a-300", { priority: 0, gain: 0.3 });
      player.play("b-300", { priority: 1 });
      player.play("c-300", { priority: 2 });
    });
    await page.waitForTimeout(30);
    const peak = await snap(page);
    expect(peak.active <= 3, `同时发声不超上限 2（加音乐共 ${peak.active} 个节点）`);
    await until(page, async () => (await snap(page)).active === 1, "音效播完回收", 3_000);
    expect((await snap(page)).active === 1, "音效播完节点回收，只剩音乐");

    // 3. 补播时限与永久失败
    const s3 = (await snap(page)).started;
    await page.evaluate(() => (window as unknown as { __t: Harness }).__t.player.play("slow-100"));
    await page.waitForTimeout(1_200);
    expect((await snap(page)).started === s3, "懒解码晚于 300ms 的音效不再响");
    await page.evaluate(async () => {
      const { player } = (window as unknown as { __t: Harness }).__t;
      player.play("gone-404");
      await new Promise((r) => setTimeout(r, 200));
      player.play("gone-404");
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(hits.get("gone-404") === 1, `404 的文件只请求一次（实际 ${hits.get("gone-404")} 次）`);

    // 4. 挂起后发声：先 resume 再响
    const resumed = await page.evaluate(async () => {
      const { host, player } = (window as unknown as { __t: Harness }).__t;
      await host.context!.suspend();
      const startedBefore = player.snapshot().started;
      player.play("beep-120");
      await new Promise((r) => setTimeout(r, 300));
      return { state: host.context!.state, delta: player.snapshot().started - startedBefore };
    });
    expect(resumed.state === "running" && resumed.delta === 1, "引擎挂起时 play 先 resume 再发声");

    // 5. 引擎假死 → 回前台重建 → 音乐续上
    const rebuilt = await page.evaluate(async () => {
      const { host, player } = (window as unknown as { __t: Harness }).__t;
      const old = host.context!;
      await old.close();
      document.dispatchEvent(new Event("visibilitychange"));
      for (let i = 0; i < 60 && (host.context === old || player.snapshot().active < 1); i++) await new Promise((r) => setTimeout(r, 50));
      return { replaced: host.context !== old, state: host.context?.state, snap: player.snapshot() };
    });
    expect(rebuilt.replaced && rebuilt.state === "running" && rebuilt.snap.rebuilds === 1, "引擎假死后回前台重建了新引擎");
    expect(rebuilt.snap.active === 1, "新引擎上音乐按意图续上");

    // 6. 停音乐归零、水位
    await page.evaluate(() => (window as unknown as { __t: Harness }).__t.player.stopMusic());
    await page.waitForTimeout(100);
    expect((await snap(page)).active === 0, "停掉音乐后活跃节点归零");
    const v = await page.evaluate(() => (window as unknown as { __t: Harness }).__t.perf.sampleNow().v);
    expect(typeof v["audio.decodedMB"] === "number", `水位采样有 audio.decodedMB（${v["audio.decodedMB"]}）`);

    log("通过：解锁补播 → 限频与并发上限 → 节点回收 → 补播时限与永不重试 → 挂起先唤醒 → 假死重建续播 → 指标进水位");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[e2e-audio] 失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
