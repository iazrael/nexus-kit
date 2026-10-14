/**
 * 加载调度器（机制见 docs/架构算法/图像资源.md）：管「什么时候发请求」。
 *
 * - 任务带档位（0 挡门 / 1 可见 / 2 附近 / 3 空闲），同档按次序值、再按提交先后；只给还没发出的任务排序，
 *   在飞的请求不打断（打断会白白浪费已下的字节）。
 * - 同一个 key 在排队或在飞时，后来的调用复用同一个结果，不发第二次；排队中的取更急的档位。
 *   key 必须唯一标识一份资源（通常就是 URL）：后来者的 run 不会被执行。
 * - 每个调用可带 AbortSignal：取消只拒绝它自己；全部调用方都取消、且任务还在排队时才出队、不发请求。
 * - hold(关键Promise, 封顶毫秒)：关键资源有结论（成或败）或时限到之前，档位 2、3 不发。新的 hold 取代旧闸门。
 *
 * 取材 旧项目A load/asset-scheduler.ts 与 critical-gate.ts。时钟可注入，单测不碰真定时器。
 */
import type { Logger } from "../log/store.ts";

export type Tier = 0 | 1 | 2 | 3;

export interface Priority {
  /** 0 挡门 / 1 可见 / 2 附近 / 3 空闲 */
  tier: Tier;
  /** 同档次序值，小的先发（例如与视口中心的距离）；默认 0 */
  order?: number;
}

/** 只用到 /perf 的登记接口：kit 内各子路径之间不互相 import 实现 */
export interface GaugeRegistry {
  registerGauge(name: string, read: () => number | null): () => void;
}

export interface LoaderOptions {
  /** 同时在飞的上限，默认 6（旧项目A 高延迟真机实测值，也是 HTTP/1.1 每域连接数的惯例） */
  concurrency?: number;
  /** 闸门封顶用的定时器，返回撤销函数；默认 setTimeout / clearTimeout */
  setTimer?: (fn: () => void, ms: number) => () => void;
  log?: Logger;
  /** 传入时登记 assets.queued / assets.running 两个水位指标 */
  perf?: GaugeRegistry;
}

interface Task {
  key: string;
  tier: Tier;
  order: number;
  seq: number;
  state: "queued" | "running";
  callers: number;
  run: () => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new DOMException("已取消", "AbortError");

function validate(key: string, p: Priority): void {
  if (key === "") throw new Error("加载任务的 key 不得为空");
  if (!Number.isInteger(p.tier) || p.tier < 0 || p.tier > 3) throw new RangeError(`加载档位须为 0..3：${String(p.tier)}`);
  if (p.order !== undefined && !Number.isFinite(p.order)) throw new RangeError(`加载次序值须为有限数：${String(p.order)}`);
}

/** a 比 b 更急 */
const before = (a: Task, b: Task): boolean =>
  a.tier !== b.tier ? a.tier < b.tier : a.order !== b.order ? a.order < b.order : a.seq < b.seq;

export function createLoader(options: LoaderOptions = {}) {
  const concurrency = options.concurrency ?? 6;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`并发上限须为正整数：${String(concurrency)}`);
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    });
  const log = options.log;
  const tasks = new Map<string, Task>();
  let running = 0;
  let seq = 0;
  let gate = { open: true };

  const queued = (): Task[] => [...tasks.values()].filter((t) => t.state === "queued");
  const eligible = (t: Task): boolean => gate.open || t.tier < 2;

  function start(task: Task): void {
    task.state = "running";
    running++;
    let pending: Promise<unknown>;
    try {
      pending = task.run();
    } catch (error) {
      pending = Promise.reject(error);
    }
    void Promise.resolve(pending)
      .then(task.resolve, task.reject)
      .finally(() => {
        running--;
        if (tasks.get(task.key) === task) tasks.delete(task.key);
        pump();
      });
  }

  function pump(): void {
    while (running < concurrency) {
      let best: Task | null = null;
      for (const t of tasks.values()) if (t.state === "queued" && eligible(t) && (best === null || before(t, best))) best = t;
      if (best === null) return;
      start(best);
    }
  }

  /** 一个调用方放弃：全部放弃且还在排队就出队 */
  function detach(task: Task, reason: unknown): void {
    task.callers--;
    if (task.callers > 0 || task.state !== "queued" || tasks.get(task.key) !== task) return;
    tasks.delete(task.key);
    task.reject(reason);
  }

  const unregister = options.perf
    ? [options.perf.registerGauge("assets.queued", () => queued().length), options.perf.registerGauge("assets.running", () => running)]
    : [];

  return {
    schedule<T>(key: string, priority: Priority, run: () => Promise<T>, opts: { signal?: AbortSignal } = {}): Promise<T> {
      validate(key, priority);
      const { signal } = opts;
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      const order = priority.order ?? 0;
      let task = tasks.get(key);
      if (task === undefined) {
        let resolve!: (v: unknown) => void;
        let reject!: (e: unknown) => void;
        const promise = new Promise<unknown>((y, n) => ((resolve = y), (reject = n)));
        // 全部调用方都取消后共享结果被拒绝，此时已没人在等：挂空处理，不报未处理的拒绝
        promise.catch(() => undefined);
        task = { key, tier: priority.tier, order, seq: seq++, state: "queued", callers: 0, run, promise, resolve, reject };
        tasks.set(key, task);
      } else if (task.state === "queued" && (priority.tier < task.tier || (priority.tier === task.tier && order < task.order))) {
        task.tier = priority.tier;
        task.order = order;
      }
      task.callers++;
      const shared = task.promise as Promise<T>;
      const own = task;
      const out =
        signal === undefined
          ? shared
          : new Promise<T>((resolve, reject) => {
              const onAbort = (): void => {
                const reason = abortReason(signal);
                reject(reason);
                detach(own, reason);
              };
              signal.addEventListener("abort", onAbort, { once: true });
              shared.then(
                (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
                (e: unknown) => (signal.removeEventListener("abort", onAbort), reject(e)),
              );
            });
      pump();
      return out;
    },

    /** 改排队中任务的优先级（可升可降）；在飞或不存在返回 false */
    reprioritize(key: string, priority: Priority): boolean {
      validate(key, priority);
      const task = tasks.get(key);
      if (task === undefined || task.state !== "queued") return false;
      task.tier = priority.tier;
      task.order = priority.order ?? 0;
      pump();
      return true;
    },

    /** 关键闸门：critical 有结论或 capMs 到期前，档位 2、3 不发。新的 hold 取代旧闸门 */
    hold(critical: Promise<unknown>, capMs: number): void {
      if (!Number.isFinite(capMs) || capMs < 0) throw new RangeError(`闸门封顶时限须为非负有限数：${String(capMs)}`);
      const g = { open: false };
      gate = g;
      let cancelCap = (): void => undefined;
      const release = (by: "settled" | "cap"): void => {
        if (g.open) return;
        g.open = true;
        cancelCap(); // 有结论了就撤掉封顶定时器，不让它拖住进程退出
        if (gate !== g) return; // 已被新闸门取代
        log?.info("关键闸门放行", { by, held: queued().filter((t) => t.tier >= 2).length });
        pump();
      };
      cancelCap = setTimer(() => release("cap"), capMs);
      critical.then(
        () => release("settled"),
        () => release("settled"),
      );
    },

    has: (key: string): boolean => tasks.has(key),

    snapshot(): { running: string[]; queued: string[]; gateOpen: boolean } {
      return {
        running: [...tasks.values()].filter((t) => t.state === "running").map((t) => t.key),
        queued: queued()
          .sort((a, b) => (before(a, b) ? -1 : 1))
          .map((t) => t.key),
        gateOpen: gate.open,
      };
    },

    /** 注销水位指标（排队与在飞的任务不受影响） */
    dispose(): void {
      for (const off of unregister.splice(0)) off();
    },
  };
}

export type Loader = ReturnType<typeof createLoader>;
