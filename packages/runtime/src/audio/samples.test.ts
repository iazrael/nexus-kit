// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLoader } from "../assets/loader.ts";
import { createAudioHost } from "./host.ts";
import { createSamplePlayer, type SamplePlayerOptions } from "./samples.ts";
import { asCtx, FakeContext, flush } from "./fake-audio.test-util.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

beforeEach(() => {
  FakeContext.created = [];
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

function rig(over: Partial<SamplePlayerOptions> = {}) {
  let now = 1000;
  const fetched: string[] = [];
  const holds = new Map<string, () => void>();
  const logs: string[] = [];
  const gauges = new Map<string, () => number | null>();
  const log = {
    debug: (m: string) => logs.push(`debug ${m}`),
    info: (m: string, d?: unknown) => logs.push(`info ${m} ${JSON.stringify(d)}`),
    warn: (m: string, d?: unknown) => logs.push(`warn ${m} ${JSON.stringify(d)}`),
    error: (m: string) => logs.push(`error ${m}`),
  };
  const host = createAudioHost({ buses: ["music", "sfx"], createContext: () => asCtx(new FakeContext()), log });
  const loader = createLoader();
  const player = createSamplePlayer({
    host,
    loader,
    urlOf: (key) => `/sound/${key}.m4a`,
    clock: () => now,
    log,
    perf: { registerGauge: (n, r) => (gauges.set(n, r), () => gauges.delete(n)) },
    fetch: async (url: string) => {
      fetched.push(url);
      if (url.includes("hold")) await new Promise<void>((r) => holds.set(url, r));
      if (url.includes("net")) throw new TypeError("Failed to fetch");
      if (url.includes("404")) return new Response("", { status: 404 });
      return new Response(url);
    },
    ...over,
  });
  disposers.push(
    () => player.dispose(),
    () => host.dispose(),
  );
  const ctx = () => FakeContext.created.at(-1)!;
  const live = () => ctx().sources.filter((s) => s.started && s.onended !== null);
  return { host, loader, player, fetched, holds, logs, gauges, ctx, live, tick: (ms: number) => (now += ms) };
}

async function unlocked(r: ReturnType<typeof rig>) {
  r.host.unlock();
  await flush();
}

describe("createSamplePlayer · 音效", () => {
  it("解锁前的音效直接丢；解锁后懒解码、补播时限内解完就响；同 key 50ms 内只响一次；播完节点回收", async () => {
    const r = rig();
    r.player.play("hit");
    expect(r.fetched).toEqual([]);
    await unlocked(r);
    r.player.play("hit");
    await flush();
    expect(r.player.snapshot()).toMatchObject({ started: 1, active: 1 });
    r.tick(10);
    r.player.play("hit"); // 限频窗内
    await flush();
    expect(r.player.snapshot().started).toBe(1);
    r.tick(50);
    r.player.play("hit"); // 已解码，直接响
    await flush();
    expect(r.player.snapshot()).toMatchObject({ started: 2, active: 2 });
    expect(r.fetched).toEqual(["/sound/hit.m4a"]);
    for (const s of r.live()) s.end();
    expect(r.player.snapshot().active).toBe(0);
    expect(r.ctx().sources.every((s) => s.connections.length === 0)).toBe(true);
  });

  it("补播过时即丢：解码晚于 300ms 不再响，并记日志", async () => {
    const r = rig();
    await unlocked(r);
    r.player.play("hold-levelup");
    await flush();
    r.tick(400);
    r.holds.get("/sound/hold-levelup.m4a")!();
    await flush();
    expect(r.player.snapshot().started).toBe(0);
    expect(r.logs.some((l) => /补播过期丢弃/.test(l))).toBe(true);
  });

  it("同时发声到上限：先停优先级低的、同优先级先停音量小的；腾不出名额就丢新音", async () => {
    const r = rig({ maxVoices: 2 });
    await unlocked(r);
    for (const k of ["a", "b", "c", "d"]) {
      r.player.play(k); // 先把四个都解码进缓存
      await flush();
      r.tick(100);
    }
    for (const s of r.live()) s.end();
    r.player.play("a", { priority: 0, gain: 0.5 });
    r.player.play("b", { priority: 0, gain: 1 });
    await flush();
    r.player.play("c", { priority: 1 });
    await flush();
    const tags = () => r.live().map((s) => (s.buffer as { tag: string }).tag);
    expect(tags().sort()).toEqual(["/sound/b.m4a", "/sound/c.m4a"]);
    r.player.play("d", { priority: 0, gain: 0.3 });
    await flush();
    expect(tags()).not.toContain("/sound/d.m4a");
    expect(r.logs.some((l) => /同时发声到顶/.test(l))).toBe(true);
  });

  it("句柄：解码完成前 stop 就不再起播；起播后 stop 淡出停止", async () => {
    const r = rig();
    await unlocked(r);
    const h = r.player.play("hold-x");
    await flush();
    h.stop();
    r.holds.get("/sound/hold-x.m4a")!();
    await flush();
    expect(r.player.snapshot().started).toBe(0);
    r.tick(100);
    const h2 = r.player.play("hold-x");
    await flush();
    h2.stop(200);
    expect(r.live()[0]!.stoppedAt).not.toBeNull();
  });

  it("已知缺失：不发请求，第一次 info 之后降 debug；404 与解码失败永不重试；网络错下次再试", async () => {
    const r = rig();
    await unlocked(r);
    r.player.setKnownMissing(["gone"]);
    r.player.play("gone");
    r.tick(100);
    r.player.play("gone");
    expect(r.fetched).toEqual([]);
    expect(r.logs.filter((l) => /info .*已知缺失/.test(l))).toHaveLength(1);

    r.player.play("x404");
    await flush();
    r.tick(100);
    r.player.play("x404");
    await flush();
    expect(r.fetched.filter((u) => u.includes("x404"))).toHaveLength(1);

    r.ctx().decoder = () => null;
    r.player.play("broken");
    await flush();
    r.tick(100);
    r.player.play("broken");
    await flush();
    expect(r.fetched.filter((u) => u.includes("broken"))).toHaveLength(1);

    r.player.play("net-1");
    await flush();
    r.tick(100);
    r.player.play("net-1");
    await flush();
    expect(r.fetched.filter((u) => u.includes("net-1"))).toHaveLength(2);
  });

  it("解码字节按预算 LRU 淘汰并进水位；预热排队时真触发撤掉预热、直接下载", async () => {
    // 每个缓冲 = 字节数 × 100 × 2 声道 × 4：/sound/aa.m4a 13 字节 → 10400 字节；预算放得下两个
    const r = rig({ budgetMB: 25_000 / 1024 / 1024 });
    await unlocked(r);
    r.player.play("aa");
    await flush();
    r.tick(100);
    r.player.play("bb");
    await flush();
    expect(r.player.snapshot().buffers).toBe(2);
    expect(r.gauges.get("audio.decodedMB")!()).toBe(0); // 2 万字节按 0.1MB 取整

    r.tick(100);
    r.player.play("cc"); // 三个超预算 → 淘汰最久没用的 aa
    await flush();
    r.tick(100);
    r.player.play("aa");
    await flush();
    expect(r.fetched.filter((u) => u.endsWith("/aa.m4a"))).toHaveLength(2);

    r.loader.hold(new Promise(() => undefined), 60_000); // 闸门压住档位 3 的预热
    r.player.warm(["dd"]);
    await flush();
    expect(r.fetched.some((u) => u.endsWith("/dd.m4a"))).toBe(false);
    r.player.play("dd");
    await flush();
    expect(r.fetched.filter((u) => u.endsWith("/dd.m4a"))).toHaveLength(1);
    expect(r.player.snapshot().started).toBeGreaterThan(0);
    expect(r.loader.has("/sound/dd.m4a")).toBe(false);
  });
});

describe("createSamplePlayer · 音乐与重建", () => {
  it("解锁前点的音乐记下来，解锁后补播；同曲在播再点不重起；解码途中换曲以最后一次为准", async () => {
    const r = rig();
    r.player.playMusic("title");
    expect(r.player.musicIntent()).toBe("title");
    await unlocked(r);
    await flush();
    const loops = () => r.live().filter((s) => s.loop);
    expect(loops()).toHaveLength(1);
    r.player.playMusic("title");
    await flush();
    expect(r.ctx().sources.filter((s) => s.loop)).toHaveLength(1);
    r.player.playMusic("hold-town");
    await flush();
    r.player.playMusic("field");
    await flush();
    r.holds.get("/sound/hold-town.m4a")!();
    await flush();
    const playing = loops().map((s) => (s.buffer as { tag: string }).tag);
    expect(playing).toEqual(["/sound/field.m4a"]);
  });

  it("循环曲被系统掐死：回到 running 时按意图重播；单次曲自然播完撤销意图，不会被复活；stopMusic 撤销意图", async () => {
    const r = rig();
    await unlocked(r);
    r.player.playMusic("field");
    await flush();
    r.live()
      .find((s) => s.loop)!
      .end(); // 系统掐死
    r.ctx().setState("interrupted");
    r.ctx().setState("running");
    await flush();
    expect(r.live().filter((s) => s.loop)).toHaveLength(1);

    r.player.playMusic("gameover", { loop: false });
    await flush();
    r.live()
      .find((s) => (s.buffer as { tag: string }).tag.includes("gameover"))!
      .end();
    expect(r.player.musicIntent()).toBeNull();
    r.ctx().setState("interrupted");
    r.ctx().setState("running");
    await flush();
    expect(r.live()).toHaveLength(0);

    r.player.playMusic("field");
    await flush();
    r.player.stopMusic();
    expect(r.player.musicIntent()).toBeNull();
  });

  it("引擎重建：缓存与活跃节点清零、限频账清掉，新引擎上音乐按意图续上", async () => {
    const r = rig();
    await unlocked(r);
    r.player.playMusic("field");
    r.player.play("hit");
    await flush();
    const old = r.ctx();
    old.state = "interrupted";
    old.resumeMode = "stays";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(8);
    expect(r.ctx()).not.toBe(old);
    expect(r.player.snapshot()).toMatchObject({ rebuilds: 1, active: 1 }); // 只剩新引擎上的音乐
    expect(r.live().filter((s) => s.loop)).toHaveLength(1);
    r.player.play("hit"); // 旧引擎的限频账已清，立刻能响（重新解码）
    await flush();
    expect(r.live().some((s) => !s.loop)).toBe(true);
    expect(r.fetched.filter((u) => u.endsWith("/hit.m4a"))).toHaveLength(2);
  });

  it("重建时还在下载的旧解码：作废，不进新缓存；同 key 重复入缓存不重复计字节", async () => {
    const r = rig();
    await unlocked(r);
    r.player.play("hold-a");
    await flush();
    const old = r.ctx();
    old.state = "interrupted";
    old.resumeMode = "stays";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(8);
    expect(r.ctx()).not.toBe(old);
    r.holds.get("/sound/hold-a.m4a")!(); // 旧下载这时才到
    await flush();
    expect(r.player.snapshot().buffers).toBe(0);
    r.tick(100);
    r.player.play("hold-a");
    await flush();
    r.holds.get("/sound/hold-a.m4a")!();
    await flush();
    const once = r.player.snapshot();
    r.player.warm(["hold-a"]); // 已在缓存，不再下载
    expect(once.buffers).toBe(1);
    expect(r.gauges.get("audio.decodedMB")!()).toBe(Math.round((((15 + 2) * 100 * 2 * 4) / 1024 / 1024) * 10) / 10);
  });

  it("dispose 之后：在飞的音效不再起播，play / playMusic 不再工作", async () => {
    const r = rig();
    await unlocked(r);
    r.player.play("hold-late");
    await flush();
    r.player.dispose();
    r.holds.get("/sound/hold-late.m4a")!();
    await flush();
    r.player.play("hit");
    r.player.playMusic("field");
    await flush();
    expect(r.player.snapshot()).toMatchObject({ started: 0, active: 0, buffers: 0 });
    expect(r.player.musicIntent()).toBeNull();
  });

  it("dispose：停掉全部声音、注销水位指标", async () => {
    const r = rig();
    await unlocked(r);
    r.player.playMusic("field");
    r.player.play("hit");
    await flush();
    r.player.dispose();
    expect(r.ctx().sources.every((s) => s.stoppedAt !== null)).toBe(true);
    expect(r.gauges.size).toBe(0);
  });
});
