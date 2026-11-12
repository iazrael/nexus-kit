/**
 * 引擎宿主（机制见 docs/架构算法/音频.md）：只管 AudioContext 的生命周期，合成类宿主（振荡器）与样本播放器共用。
 *
 * - 惰性创建；unlock() 由宿主在用户手势里调（幂等），老 Safari 退 webkitAudioContext。
 * - 回前台：同时听 visibilitychange 与 statechange（iOS 上前者会漏）；不在 running 一律 resume——iOS 切后台/锁屏的
 *   interrupted 是标准外的第四种状态，只判 suspended 永远唤不醒。回到 running 通知 onRunning，供播放器校对被系统
 *   掐死的声源（通知可能重复，订阅方的校对必须幂等）。
 * - resume 落地仍不 running 或被拒：关旧 context 换新的（上限 maxRebuilds，超过放弃并记 warn），广播 onRebuild。
 * - 总线：master + 宿主声明的分轨，增益 = 偏好音量 × 下潜系数；下潜按来源登记，多源取最深，全撤才回升。
 * - whenRunning(fn)：发声前置门，引擎挂着时先 resume、落地 running 才执行，不把音符排在冻结的时间轴上。
 * - resetSession()：iOS 停麦后输出被压到极轻而 state 仍是 running，挂起 120ms 再恢复逼系统重建会话。
 *
 * 取材自旧项目A与旧项目B的音频引擎实现。
 */
import type { Logger } from "../log/store.ts";
import { errText } from "../util.ts";
import { defaultVolumePrefs, type VolumePrefs } from "./prefs.ts";

export interface AudioHostOptions {
  /** 分轨总线名，如 ["music", "sfx", "voice"] */
  buses: readonly string[];
  /** 初始音量偏好；默认全 1、未静音 */
  prefs?: VolumePrefs;
  /** 假死重建上限（整个会话不复位），默认 3 */
  maxRebuilds?: number;
  /** 切后台时淡出并挂起 context（省电），回前台恢复；默认 false */
  suspendWhenHidden?: boolean;
  /** 建 context；返回 null 表示环境不支持。默认 AudioContext / webkitAudioContext */
  createContext?: () => AudioContext | null;
  log?: Logger;
}

/** 增益下限：exponentialRamp 与淡出都不能落到 0 */
const GAIN_FLOOR = 0.0001;
const HIDE_FADE_S = 0.3;
const HIDE_SUSPEND_MS = 350;
const RESET_GAP_MS = 120;

function defaultCreateContext(): AudioContext | null {
  const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return Ctor === undefined ? null : new Ctor();
}

export function createAudioHost(options: AudioHostOptions) {
  const { log } = options;
  const maxRebuilds = options.maxRebuilds ?? 3;
  const createContext = options.createContext ?? defaultCreateContext;
  let prefs: VolumePrefs = options.prefs ?? defaultVolumePrefs(options.buses);
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  const buses = new Map<string, GainNode>();
  /** 总线 → 来源 → 下潜系数 */
  const ducks = new Map<string, Map<string, number>>();
  const runningListeners = new Set<() => void>();
  const rebuildListeners = new Set<(ctx: AudioContext) => void>();
  let unlocked = false;
  let rebuilds = 0;
  let unsupportedLogged = false;
  let gaveUpLogged = false;
  /** 已记过「发声前唤醒被拒」的引擎：引擎挂着时每个音效都会撞上，同一个引擎只记一次 */
  const resumeRejectLogged = new WeakSet<AudioContext>();
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const duckFactor = (bus: string): number => {
    let f = 1;
    for (const v of ducks.get(bus)?.values() ?? []) f = Math.min(f, v);
    return f;
  };

  function applyGains(): void {
    if (master !== null) {
      // 先撤掉时间线上还没执行的渐变（切后台的淡出）：直接赋值挡不住它们，恢复的音量会又被拉回静音
      if (ctx !== null) master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.value = prefs.muted ? 0 : prefs.master;
    }
    for (const [name, node] of buses) node.gain.value = (prefs.buses[name] ?? 1) * duckFactor(name);
  }

  function emit<T>(listeners: Set<(arg: T) => void>, arg: T, what: string): void {
    for (const fn of [...listeners]) {
      try {
        fn(arg);
      } catch (error) {
        log?.warn(`${what}的订阅方出错（不影响其他订阅方）`, { error: errText(error) });
      }
    }
  }
  const notifyRunning = (): void => emit(runningListeners as Set<(a: undefined) => void>, undefined, "回到 running 通知");

  const onStateChange = (): void => {
    log?.info("音频引擎状态变化", { state: ctx?.state });
    if (ctx?.state === "running") notifyRunning();
  };

  /** resume 一次；落地仍不 running 或被拒就重建 */
  function resumeOrRebuild(reason: string): void {
    const c = ctx;
    if (c === null) return;
    c.resume().then(
      () => {
        if (ctx !== c) return; // 落地前已被并发路径重建：旧引擎不再管
        if (c.state === "running") {
          unlocked = true;
          applyGains();
          notifyRunning();
        } else rebuild(`${reason}：resume 落地仍不 running（${c.state}）`);
      },
      (error: unknown) => {
        if (ctx !== c) return;
        rebuild(`${reason}：resume 被拒（${errText(error)}）`);
      },
    );
  }

  const onVisibility = (): void => {
    if (ctx === null || typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      if (!options.suspendWhenHidden || master === null) return;
      const c = ctx;
      const g = master.gain;
      g.cancelScheduledValues(c.currentTime);
      g.setValueAtTime(Math.max(GAIN_FLOOR, g.value), c.currentTime);
      g.linearRampToValueAtTime(GAIN_FLOOR, c.currentTime + HIDE_FADE_S);
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (ctx === c && document.visibilityState === "hidden") {
          c.suspend().catch((error: unknown) => log?.debug("切后台挂起被拒", { error: errText(error) }));
        }
      }, HIDE_SUSPEND_MS);
      return;
    }
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (ctx.state === "running") {
      // WebKit 已自行恢复：后台期间声源可能已被掐死，照样通知校对
      applyGains();
      notifyRunning();
      return;
    }
    resumeOrRebuild("回前台");
  };

  function build(): AudioContext | null {
    let c: AudioContext | null;
    try {
      c = createContext();
    } catch (error) {
      log?.warn("创建音频引擎失败（全静默降级）", { error: errText(error) });
      return null;
    }
    if (c === null) {
      if (!unsupportedLogged) log?.info("当前环境不支持 Web Audio（全静默降级）");
      unsupportedLogged = true;
      return null;
    }
    ctx = c;
    master = c.createGain();
    master.connect(c.destination);
    buses.clear();
    for (const name of options.buses) {
      const node = c.createGain();
      node.connect(master);
      buses.set(name, node);
    }
    applyGains();
    c.addEventListener("statechange", onStateChange);
    log?.info("音频引擎已创建", { state: c.state, sampleRate: c.sampleRate });
    return c;
  }

  function startUp(c: AudioContext): void {
    c.resume().then(
      () => {
        if (ctx !== c || c.state !== "running") return; // 没唤醒：等 statechange 或下一次手势
        unlocked = true;
        notifyRunning();
      },
      (error: unknown) => log?.debug("resume 被拒（不在手势里），等下一次手势", { error: errText(error) }),
    );
  }

  function teardown(): void {
    const c = ctx;
    if (c === null) return;
    c.removeEventListener("statechange", onStateChange);
    try {
      c.close().catch(() => undefined); // 已死的 context 关闭再失败无事可做
    } catch {
      // 部分实现对已关闭的 context 同步抛错：同上
    }
    ctx = null;
    master = null;
    buses.clear();
  }

  function rebuild(reason: string): void {
    if (ctx === null) return;
    if (rebuilds >= maxRebuilds) {
      // 之后每次回前台都会走到这里：只记一次
      if (!gaveUpLogged) log?.warn("音频引擎重建放弃：已达上限，之后不再重建", { reason, rebuilds });
      gaveUpLogged = true;
      return;
    }
    rebuilds++;
    log?.warn("音频引擎假死，重建", { reason, attempt: rebuilds });
    teardown();
    const c = build();
    if (c === null) return;
    emit(rebuildListeners, c, "引擎重建通知");
    startUp(c);
  }

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  return {
    get context(): AudioContext | null {
      return ctx;
    },
    get master(): GainNode | null {
      return master;
    },
    /** 分轨总线节点；没解锁或未声明的总线返回 null */
    bus(name: string): GainNode | null {
      return buses.get(name) ?? null;
    },

    /** 在用户手势里调（幂等）：首次创建引擎；已有引擎但不在 running 就 resume，落地仍不行就重建 */
    unlock(): void {
      if (disposed) return;
      if (ctx === null) {
        const c = build();
        if (c !== null) startUp(c);
        return;
      }
      if (ctx.state !== "running") resumeOrRebuild("手势");
    },

    get prefs(): VolumePrefs {
      return { ...prefs, buses: { ...prefs.buses } };
    },
    setPrefs(next: VolumePrefs): void {
      prefs = { ...next, buses: { ...next.buses } };
      applyGains();
    },
    /** 下潜：level 为 0..1 的系数，null 撤销该来源 */
    duck(bus: string, source: string, level: number | null): void {
      let m = ducks.get(bus);
      if (m === undefined) ducks.set(bus, (m = new Map()));
      if (level === null) m.delete(source);
      else m.set(source, Math.min(1, Math.max(0, level)));
      applyGains();
    },

    /**
     * 发声前置门：running 立即执行；挂起时先 resume，落地 running 且引擎没换才执行。返回是否执行了。
     * fn 抛错（节点所在的引擎刚被关）不外泄：记 warn 返回 false，调用方 void 掉返回值也不会出未处理的拒绝
     */
    whenRunning(fn: (ctx: AudioContext) => void): Promise<boolean> {
      const run = (c: AudioContext): boolean => {
        try {
          fn(c);
          return true;
        } catch (error) {
          log?.warn("发声失败（引擎可能刚被换掉）", { error: errText(error) });
          return false;
        }
      };
      const c = ctx;
      if (c === null) return Promise.resolve(false);
      if (c.state === "running") return Promise.resolve(run(c));
      return c.resume().then(
        () => (ctx === c && c.state === "running" ? run(c) : false),
        (error: unknown) => {
          if (!resumeRejectLogged.has(c)) log?.info("发声前唤醒被拒，引擎恢复前不发声（同一引擎只记一次）", { error: errText(error) });
          resumeRejectLogged.add(c);
          return false;
        },
      );
    },

    onRunning(fn: () => void): () => void {
      runningListeners.add(fn);
      return () => runningListeners.delete(fn);
    },
    onRebuild(fn: (ctx: AudioContext) => void): () => void {
      rebuildListeners.add(fn);
      return () => rebuildListeners.delete(fn);
    },

    /** iOS 停麦后输出被压低：挂起 120ms 再恢复，逼系统以播放类别重建会话 */
    resetSession(): void {
      const c = ctx;
      if (c === null || c.state !== "running") return;
      log?.info("重建音频会话：挂起后恢复");
      c.suspend().then(
        () =>
          setTimeout(() => {
            if (ctx === c) resumeOrRebuild("重建会话");
          }, RESET_GAP_MS),
        (error: unknown) => log?.warn("重建音频会话：挂起被拒", { error: errText(error) }),
      );
    },

    snapshot(): { state: string | null; unlocked: boolean; rebuilds: number } {
      return { state: ctx?.state ?? null, unlocked, rebuilds };
    },

    dispose(): void {
      disposed = true;
      if (hideTimer !== null) clearTimeout(hideTimer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      teardown();
      runningListeners.clear();
      rebuildListeners.clear();
    },
  };
}

export type AudioHost = ReturnType<typeof createAudioHost>;
