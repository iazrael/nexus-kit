/**
 * 样本播放器（机制见 docs/架构算法/音频.md）：建在引擎宿主上，管音频文件的解码缓存、音效与音乐。
 *
 * - 解码缓存：按字节预算 LRU（float32 PCM = 采样数 × 声道 × 4，属隐性内存，进 /perf 水位 audio.decodedMB）；
 *   同 key 在途去重；引擎重建时全清（AudioBuffer 跨 context 复用在 WebKit 上不保证），用到时懒解码补回。
 * - 失败分级：HTTP 错误码与解码失败是产物问题，永不重试；fetch 抛错（断网）下次再试；解码途中引擎被换不算失败。
 *   登记为已知缺失的 key 直接静默，不发注定 404 的请求。
 * - 音效 play：同 key 限频（墙钟，引擎重建后照样清账）；同时发声有上限，到顶先停优先级低、音量小的；没解码的
 *   现场解码，补播时限内解完才响，过时即丢（晚到的音比不响更糟）。预热走 /assets 调度器排队给首屏让路，真触发
 *   直接下载；同 key 的预热还在排队就先撤掉它。
 * - 音乐 playMusic / stopMusic：记账「应当在响的曲子」，取号仲裁晚到的解码结果；单次曲自然播完撤销意图；回到
 *   running 与引擎重建后按意图校对重启。
 *
 * 取材 旧项目A load/audio.ts（ThrottleGate、LatestIntentGate、远音让路、补播时效、失败分级、已知缺口）。
 */
import type { Loader, GaugeRegistry, Priority } from "../assets/loader.ts";
import type { Logger } from "../log/store.ts";
import { errText, scrubUrl } from "../util.ts";
import type { AudioHost } from "./host.ts";

export interface SamplePlayerOptions {
  host: AudioHost;
  /** 预热排队用；真触发与音乐不经它 */
  loader: Loader;
  /** key → 文件地址 */
  urlOf: (key: string) => string;
  /** 解码缓存预算 MB，默认 32 */
  budgetMB?: number;
  /** 同时发声上限（不含音乐），默认 8 */
  maxVoices?: number;
  /** 同 key 限频窗口 ms，默认 50 */
  throttleMs?: number;
  /** 懒解码补播时限 ms，默认 300 */
  lateReplayMs?: number;
  /** 音效默认总线，默认 "sfx"；音乐默认总线 "music" */
  sfxBus?: string;
  musicBus?: string;
  /** 墙钟（限频与补播时限用）；默认 performance.now */
  clock?: () => number;
  /** 默认 globalThis.fetch */
  fetch?: (url: string) => Promise<Response>;
  log?: Logger;
  /** 传入时登记 audio.decodedMB */
  perf?: GaugeRegistry;
}

export interface PlayOptions {
  bus?: string;
  /** 0..1，默认 1 */
  gain?: number;
  /** 越大越重要；到顶时先停小的，默认 0 */
  priority?: number;
}

export interface MusicOptions {
  bus?: string;
  /** 默认 true；false 为单次曲，自然播完撤销意图 */
  loop?: boolean;
  gain?: number;
  /** 淡入毫秒，默认 0 */
  fadeMs?: number;
}

export interface SoundHandle {
  /** 淡出后停止；没起播的取消补播。幂等 */
  stop(fadeMs?: number): void;
}

/** 产物问题（HTTP 错误码、解码失败）：永不重试 */
class PermanentAudioError extends Error {}

interface Voice {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  priority: number;
  gain: number;
}

interface Playback {
  cancelled: boolean;
  voice: Voice | null;
}

interface Inflight {
  promise: Promise<AudioBuffer | null>;
  /** 经调度器排队的预热：真触发撞上排队中的它时用来撤回 */
  warm: AbortController | null;
}

const MB = 1024 * 1024;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const bufferBytes = (b: AudioBuffer): number => b.length * b.numberOfChannels * 4;

export function createSamplePlayer(options: SamplePlayerOptions) {
  const { host, loader, log } = options;
  const budgetBytes = (options.budgetMB ?? 32) * MB;
  const maxVoices = options.maxVoices ?? 8;
  const throttleMs = options.throttleMs ?? 50;
  const lateReplayMs = options.lateReplayMs ?? 300;
  const sfxBus = options.sfxBus ?? "sfx";
  const musicBus = options.musicBus ?? "music";
  const clock = options.clock ?? (() => performance.now());
  const fetchAudio = options.fetch ?? ((url: string) => globalThis.fetch(url));

  /** 解码缓存；Map 插入顺序即最久没用在前 */
  const cache = new Map<string, AudioBuffer>();
  let cachedBytes = 0;
  const inflight = new Map<string, Inflight>();
  const failed = new Set<string>();
  const knownMissing = new Set<string>();
  const missingLogged = new Set<string>();
  const lastPlayed = new Map<string, number>();
  const voices = new Set<Voice>();
  let started = 0;
  let disposed = false;

  let musicIntent: { key: string; opts: Required<MusicOptions> } | null = null;
  let musicNow: { key: string; source: AudioBufferSourceNode; gainNode: GainNode } | null = null;
  let musicToken = 0;

  // ── 解码缓存 ──
  function remember(key: string, buf: AudioBuffer): void {
    const old = cache.get(key);
    if (old !== undefined) cachedBytes -= bufferBytes(old);
    cache.delete(key);
    cache.set(key, buf);
    cachedBytes += bufferBytes(buf);
    for (const [k, b] of cache) {
      if (cachedBytes <= budgetBytes || k === key) break;
      cache.delete(k);
      cachedBytes -= bufferBytes(b);
    }
  }
  function cached(key: string): AudioBuffer | undefined {
    const b = cache.get(key);
    if (b !== undefined) {
      cache.delete(key); // 摸一下：挪到最近用过
      cache.set(key, b);
    }
    return b;
  }

  async function fetchBytes(url: string): Promise<ArrayBuffer> {
    const res = await fetchAudio(url);
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw new PermanentAudioError(`HTTP ${res.status}`);
    }
    return res.arrayBuffer();
  }

  async function decode(key: string, bytes: Promise<ArrayBuffer>): Promise<AudioBuffer | null> {
    const url = options.urlOf(key);
    // 在等字节之前就记下引擎：下载期间引擎被换，这份结果属于旧引擎，不能到新引擎上解码入缓存
    const ctx = host.context;
    let data: ArrayBuffer;
    try {
      data = await bytes;
    } catch (error) {
      if (error instanceof PermanentAudioError) {
        failed.add(key);
        log?.warn("音频加载失败（永不重试）", { key, url: scrubUrl(url), reason: error.message });
      } else if ((error as { name?: unknown }).name !== "AbortError") {
        log?.warn("音频加载失败（网络，下次再试）", { key, url: scrubUrl(url), error: errText(error) });
      }
      return null;
    }
    if (ctx === null || host.context !== ctx || disposed) return null;
    try {
      const buf = await ctx.decodeAudioData(data);
      if (host.context !== ctx || disposed) return null; // 解码期间引擎被换或已 dispose：结果作废
      remember(key, buf);
      return buf;
    } catch (error) {
      if (host.context !== ctx) {
        log?.info("音频解码被引擎重建打断，下次再试", { key });
        return null;
      }
      failed.add(key);
      log?.warn("音频解码失败（永不重试）", { key, url: scrubUrl(url), error: errText(error) });
      return null;
    }
  }

  /** 取缓冲：缓存命中直接给；mode=warm 经调度器排队，trigger 直接下载（同 key 的排队预热先撤回） */
  function getBuffer(key: string, mode: "warm" | "trigger", priority: Priority = { tier: 3 }): Promise<AudioBuffer | null> {
    if (knownMissing.has(key) || failed.has(key)) return Promise.resolve(null);
    const hit = cached(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const url = options.urlOf(key);
    const running = inflight.get(key);
    if (running !== undefined) {
      if (mode === "warm" || running.warm === null || loader.state(url) !== "queued") return running.promise;
      running.warm.abort(); // 预热还在排队：撤回，改直接下载
    }
    const warm = mode === "warm" ? new AbortController() : null;
    const bytes = warm !== null ? loader.schedule(url, priority, () => fetchBytes(url), { signal: warm.signal }) : fetchBytes(url);
    const entry: Inflight = { warm, promise: decode(key, bytes) };
    inflight.set(key, entry);
    void entry.promise.finally(() => {
      if (inflight.get(key) === entry) inflight.delete(key);
    });
    return entry.promise;
  }

  // ── 音效 ──
  function release(v: Voice): void {
    voices.delete(v);
    v.source.onended = null;
    v.source.disconnect();
    v.gainNode.disconnect();
  }

  /** 腾一个名额：停掉比新音更次要的（优先级低，同优先级音量小）；腾不出返回 false */
  function makeRoom(priority: number, gain: number): boolean {
    if (voices.size < maxVoices) return true;
    let victim: Voice | null = null;
    for (const v of voices) {
      const lower = v.priority < priority || (v.priority === priority && v.gain < gain);
      if (lower && (victim === null || v.priority < victim.priority || (v.priority === victim.priority && v.gain < victim.gain)))
        victim = v;
    }
    if (victim === null) return false;
    try {
      victim.source.stop();
    } catch {
      // 已自然结束：登记表照样清
    }
    release(victim);
    return true;
  }

  function startVoice(key: string, buf: AudioBuffer, o: Required<PlayOptions>, playback: Playback): void {
    void host.whenRunning((ctx) => {
      if (playback.cancelled || disposed) return;
      const bus = host.bus(o.bus);
      if (bus === null) {
        log?.warn("音效总线不存在，丢弃", { key, bus: o.bus });
        return;
      }
      if (!makeRoom(o.priority, o.gain)) {
        log?.info("丢弃：同时发声到顶", { key, active: voices.size });
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = buf;
      const gainNode = ctx.createGain();
      gainNode.gain.value = o.gain;
      source.connect(gainNode);
      gainNode.connect(bus);
      const v: Voice = { source, gainNode, priority: o.priority, gain: o.gain };
      voices.add(v);
      playback.voice = v;
      source.onended = () => release(v);
      started++;
      source.start();
    });
  }

  function stopVoice(playback: Playback, fadeMs: number): void {
    playback.cancelled = true;
    const v = playback.voice;
    const ctx = host.context;
    if (v === null || ctx === null || !voices.has(v)) return;
    try {
      v.gainNode.gain.setTargetAtTime(0, ctx.currentTime, Math.max(fadeMs, 1) / 5000);
      v.source.stop(ctx.currentTime + fadeMs / 1000);
    } catch {
      // 已被抢占或引擎已换：节点已死，登记表已清
    }
  }

  // ── 音乐 ──
  function stopMusicSource(fadeMs: number): void {
    const m = musicNow;
    musicNow = null;
    if (m === null) return;
    m.source.onended = null;
    const ctx = host.context;
    try {
      if (ctx !== null && fadeMs > 0) {
        m.gainNode.gain.setTargetAtTime(0, ctx.currentTime, fadeMs / 5000);
        m.source.stop(ctx.currentTime + fadeMs / 1000);
      } else m.source.stop();
    } catch {
      // 已结束或引擎已换
    }
    if (fadeMs <= 0) {
      m.source.disconnect();
      m.gainNode.disconnect();
    }
  }

  async function startMusic(token: number): Promise<void> {
    const intent = musicIntent;
    if (intent === null || host.context === null || disposed) return;
    stopMusicSource(intent.opts.fadeMs);
    const buf = await getBuffer(intent.key, "trigger");
    if (token !== musicToken || buf === null) return; // 解码期间又换曲 / 停了：最后一次意图为准
    await host.whenRunning((ctx) => {
      if (token !== musicToken || musicIntent === null) return;
      const bus = host.bus(intent.opts.bus);
      if (bus === null) {
        log?.warn("音乐总线不存在，不播", { key: intent.key, bus: intent.opts.bus });
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.loop = intent.opts.loop;
      const gainNode = ctx.createGain();
      if (intent.opts.fadeMs > 0) {
        gainNode.gain.setValueAtTime(0.0001, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(intent.opts.gain, ctx.currentTime + intent.opts.fadeMs / 1000);
      } else gainNode.gain.value = intent.opts.gain;
      source.connect(gainNode);
      gainNode.connect(bus);
      const now = { key: intent.key, source, gainNode };
      musicNow = now;
      source.onended = () => {
        source.onended = null;
        source.disconnect();
        gainNode.disconnect();
        if (musicNow !== now) return;
        musicNow = null;
        // 单次曲自然播完：意图兑现完毕，校对不复活它。循环曲只有被系统掐死才会走到这里，意图保留等校对
        if (!intent.opts.loop && musicIntent?.key === intent.key) musicIntent = null;
      };
      started++;
      source.start();
    });
  }

  /** 校对：意图还在、声源没了、引擎活着 → 重新播（幂等） */
  function reviveMusic(): void {
    if (musicIntent === null || musicNow !== null || host.context?.state !== "running") return;
    log?.info("音乐校对重启（声源丢失后恢复）", { key: musicIntent.key });
    void startMusic(++musicToken);
  }

  const offRunning = host.onRunning(reviveMusic);
  const offRebuild = host.onRebuild(() => {
    // 旧引擎上的一切都作废：缓存、在途解码、活跃节点、限频账；音乐意图保留，新引擎跑起来后校对重启
    cache.clear();
    cachedBytes = 0;
    inflight.clear();
    for (const v of [...voices]) release(v);
    lastPlayed.clear();
    musicNow = null;
    musicToken++;
  });
  const unregister = options.perf ? [options.perf.registerGauge("audio.decodedMB", () => round1(cachedBytes / MB))] : [];

  return {
    /** 登记已知缺失的 key（覆盖式）：命中直接静默，不发请求 */
    setKnownMissing(keys: Iterable<string>): void {
      knownMissing.clear();
      for (const k of keys) knownMissing.add(k);
    },

    /** 预热：经调度器排队下载解码（默认空闲档），不发声；没解锁时跳过 */
    warm(keys: Iterable<string>, priority: Priority = { tier: 3 }): void {
      if (host.context === null || disposed) return;
      for (const k of new Set(keys)) void getBuffer(k, "warm", priority);
    },

    play(key: string, opts: PlayOptions = {}): SoundHandle {
      const playback: Playback = { cancelled: false, voice: null };
      const handle: SoundHandle = { stop: (fadeMs = 250) => stopVoice(playback, fadeMs) };
      if (knownMissing.has(key)) {
        if (missingLogged.has(key)) log?.debug("丢弃：已知缺失（重复）", { key });
        else {
          missingLogged.add(key);
          log?.info("丢弃：已知缺失", { key });
        }
        return handle;
      }
      if (host.context === null || disposed) {
        log?.debug(disposed ? "丢弃：播放器已 dispose" : "丢弃：音频未解锁", { key });
        return handle;
      }
      const now = clock();
      const last = lastPlayed.get(key);
      if (last !== undefined && now - last < throttleMs) return handle; // 限频：正常降噪，不记日志
      lastPlayed.set(key, now);
      const o: Required<PlayOptions> = { bus: opts.bus ?? sfxBus, gain: opts.gain ?? 1, priority: opts.priority ?? 0 };
      const buf = cached(key);
      if (buf !== undefined) {
        startVoice(key, buf, o, playback);
        return handle;
      }
      void getBuffer(key, "trigger").then((b) => {
        if (b === null || playback.cancelled) return;
        const lateMs = Math.round(clock() - now);
        if (lateMs > lateReplayMs) {
          log?.info("补播过期丢弃", { key, lateMs });
          return;
        }
        startVoice(key, b, o, playback);
      });
      return handle;
    },

    /** 切音乐（同曲在播不重起）；未解锁先记下意图，解锁后补播 */
    playMusic(key: string, opts: MusicOptions = {}): void {
      if (disposed) return;
      const full: Required<MusicOptions> = {
        bus: opts.bus ?? musicBus,
        loop: opts.loop ?? true,
        gain: opts.gain ?? 1,
        fadeMs: opts.fadeMs ?? 0,
      };
      musicIntent = { key, opts: full };
      if (musicNow?.key === key) {
        musicToken++; // 已在播：作废在途的旧解码
        return;
      }
      void startMusic(++musicToken);
    },

    stopMusic(fadeMs = 0): void {
      musicIntent = null;
      musicToken++;
      stopMusicSource(fadeMs);
    },

    musicIntent: (): string | null => musicIntent?.key ?? null,

    /** E2E 探针：累计调度数、活跃节点数（含音乐）、解码缓存、引擎状态 */
    snapshot() {
      const h = host.snapshot();
      return {
        started,
        active: voices.size + (musicNow === null ? 0 : 1),
        buffers: cache.size,
        decodedMB: round1(cachedBytes / MB),
        unlocked: h.unlocked,
        rebuilds: h.rebuilds,
      };
    },

    /** 停掉全部声音、清缓存、注销指标与引擎订阅；之后 play / playMusic / warm 不再工作，在飞的结果作废 */
    dispose(): void {
      disposed = true;
      for (const f of inflight.values()) f.warm?.abort(); // 排队中的预热不再下载
      inflight.clear();
      musicIntent = null;
      musicToken++;
      stopMusicSource(0);
      for (const v of [...voices]) {
        try {
          v.source.stop();
        } catch {
          // 已结束
        }
        release(v);
      }
      cache.clear();
      cachedBytes = 0;
      offRunning();
      offRebuild();
      for (const off of unregister.splice(0)) off();
    },
  };
}

export type SamplePlayer = ReturnType<typeof createSamplePlayer>;
