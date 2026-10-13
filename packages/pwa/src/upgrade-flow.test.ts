import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUpgradeFlow,
  createUpgradeGate,
  subscribeNewSwActivated,
  type SwContainerLike,
  type SwRegistrationLike,
  type SwWorkerLike,
  type UpgradeFlowDeps,
  type UpgradeStage,
} from "./upgrade-flow.ts";

/** 可编排的假依赖：registration 状态/各副作用钩子都是可变槽，用例按需拨动 */
function makeDeps(): UpgradeFlowDeps & {
  setReg: (reg: { waiting: boolean; installing?: boolean } | undefined) => void;
  fireActivated: () => void;
  calls: { probe: number; skipWaiting: number; reload: number };
} {
  const calls = { probe: 0, skipWaiting: 0, reload: 0 };
  let reg: { waiting: boolean; installing: boolean } | undefined = undefined;
  let activatedListener: (() => void) | null = null;
  return {
    calls,
    setReg: (next) => {
      reg = next === undefined ? undefined : { installing: false, ...next };
    },
    fireActivated: () => activatedListener?.(),
    probe: async () => {
      calls.probe += 1;
    },
    getRegistration: () => reg,
    skipWaiting: () => {
      calls.skipWaiting += 1;
    },
    reload: () => {
      calls.reload += 1;
    },
    onNewSwActivated: (listener) => {
      activatedListener = listener;
      return () => {
        activatedListener = null;
      };
    },
  };
}

const TIMINGS = { pollMs: 100, noInstallGiveUpMs: 1000, switchingUnlockMs: 2000, absoluteUnlockMs: 10_000 };

describe("createUpgradeFlow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("start 后进入 downloading 并触发探测，waiting 出现后进入 switching 并 SKIP_WAITING，激活即刷新", async () => {
    const deps = makeDeps();
    const stages: UpgradeStage[] = [];
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: (s) => stages.push(s) });
    flow.start();
    expect(stages).toEqual(["downloading"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.calls.probe).toBe(1);
    // registration 还没有 waiting：继续轮询、不 SKIP_WAITING
    await vi.advanceTimersByTimeAsync(TIMINGS.pollMs * 2);
    expect(deps.calls.skipWaiting).toBe(0);
    // waiting 就绪：下一拍进入 switching + SKIP_WAITING
    deps.setReg({ waiting: true });
    await vi.advanceTimersByTimeAsync(TIMINGS.pollMs);
    expect(stages).toEqual(["downloading", "switching"]);
    expect(deps.calls.skipWaiting).toBe(1);
    // 新 SW 激活（statechange 路径）：reload（用户已确认的更新终点）
    deps.fireActivated();
    expect(deps.calls.reload).toBe(1);
    expect(flow.stage()).toBe("idle"); // 终局即复位
  });

  it("downloading 阶段收到激活信号（他签先发接管令）同样刷新收尾", async () => {
    const deps = makeDeps();
    const onFail = vi.fn();
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: () => {}, onFail });
    flow.start();
    await vi.advanceTimersByTimeAsync(0);
    deps.fireActivated();
    expect(deps.calls.reload).toBe(1);
    expect(flow.stage()).toBe("idle");
    expect(onFail).not.toHaveBeenCalled();
  });

  it("start 前激活信号不触发任何动作（首次安装也会 fire，不能误刷新）", () => {
    const deps = makeDeps();
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: () => {} });
    deps.fireActivated();
    expect(deps.calls.reload).toBe(0);
    expect(flow.stage()).toBe("idle");
  });

  it("激活信号双发只刷一次（statechange+controllerchange 双线补防）", async () => {
    const deps = makeDeps();
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: () => {} });
    flow.start();
    await vi.advanceTimersByTimeAsync(0);
    deps.setReg({ waiting: true });
    await vi.advanceTimersByTimeAsync(TIMINGS.pollMs);
    deps.fireActivated();
    deps.fireActivated();
    expect(deps.calls.reload).toBe(1);
  });

  it("switching 后超时未刷新：onFail 兜底并复位（门有得关，不把玩家锁在幕后）", async () => {
    const deps = makeDeps();
    const stages: UpgradeStage[] = [];
    const onFail = vi.fn();
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: (s) => stages.push(s), onFail });
    flow.start();
    await vi.advanceTimersByTimeAsync(0);
    deps.setReg({ waiting: true });
    await vi.advanceTimersByTimeAsync(TIMINGS.pollMs);
    expect(flow.stage()).toBe("switching");
    await vi.advanceTimersByTimeAsync(TIMINGS.switchingUnlockMs);
    expect(onFail).toHaveBeenCalledWith("switching-stuck");
    expect(flow.stage()).toBe("idle");
    expect(deps.calls.reload).toBe(0);
  });

  it("安装一直在跑却始终等不到 waiting：绝对超时 onFail 兜底", async () => {
    const deps = makeDeps();
    deps.setReg({ waiting: false, installing: true });
    const onFail = vi.fn();
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: () => {}, onFail });
    flow.start();
    await vi.advanceTimersByTimeAsync(TIMINGS.absoluteUnlockMs + TIMINGS.pollMs);
    expect(onFail).toHaveBeenCalledWith("downloading-stuck");
    expect(flow.stage()).toBe("idle");
  });

  it("探测 reject 不断链：轮询照常、waiting 出现仍能走完 switching", async () => {
    const deps = makeDeps();
    deps.probe = async () => {
      throw new Error("网络断");
    };
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: () => {} });
    flow.start();
    await vi.advanceTimersByTimeAsync(0);
    deps.setReg({ waiting: true });
    await vi.advanceTimersByTimeAsync(TIMINGS.pollMs);
    expect(flow.stage()).toBe("switching");
    deps.fireActivated();
    expect(deps.calls.reload).toBe(1);
  });

  it("无 SW 环境（getRegistration 恒 undefined）：探测落地后按 no-install 提前收口，轮询不抛错", async () => {
    const deps = makeDeps();
    deps.getRegistration = () => undefined;
    const onFail = vi.fn();
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: () => {}, onFail });
    flow.start();
    await vi.advanceTimersByTimeAsync(TIMINGS.noInstallGiveUpMs);
    expect(onFail).toHaveBeenCalledWith("no-install");
    expect(flow.stage()).toBe("idle");
  });

  it("探测落地后既无 installing 也无 waiting：no-install 提前收口，不陪跑到绝对兜底", async () => {
    const deps = makeDeps();
    deps.setReg({ waiting: false });
    const onFail = vi.fn();
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: () => {}, onFail });
    flow.start();
    await vi.advanceTimersByTimeAsync(TIMINGS.noInstallGiveUpMs - 1);
    expect(onFail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFail).toHaveBeenCalledWith("no-install");
    expect(deps.calls.reload).toBe(0);
  });

  it("收口计时从探测落地起算：慢探测期间不误收口", async () => {
    const deps = makeDeps();
    deps.setReg({ waiting: false });
    let settle: () => void = () => {};
    deps.probe = () => new Promise<void>((resolve) => (settle = resolve));
    const onFail = vi.fn();
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: () => {}, onFail });
    flow.start();
    await vi.advanceTimersByTimeAsync(TIMINGS.noInstallGiveUpMs * 3);
    expect(onFail).not.toHaveBeenCalled();
    settle();
    await vi.advanceTimersByTimeAsync(TIMINGS.noInstallGiveUpMs);
    expect(onFail).toHaveBeenCalledWith("no-install");
  });

  it("安装在跑时不收口；安装失败变回空态后下一轮收口", async () => {
    const deps = makeDeps();
    deps.setReg({ waiting: false, installing: true });
    const onFail = vi.fn();
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: () => {}, onFail });
    flow.start();
    await vi.advanceTimersByTimeAsync(TIMINGS.noInstallGiveUpMs * 2);
    expect(onFail).not.toHaveBeenCalled();
    expect(flow.stage()).toBe("downloading");
    deps.setReg({ waiting: false, installing: false });
    await vi.advanceTimersByTimeAsync(TIMINGS.noInstallGiveUpMs);
    expect(onFail).toHaveBeenCalledWith("no-install");
  });

  it("安装在跑、随后装好进 waiting：照常 switching 并在激活后刷新", async () => {
    const deps = makeDeps();
    deps.setReg({ waiting: false, installing: true });
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: () => {} });
    flow.start();
    await vi.advanceTimersByTimeAsync(TIMINGS.noInstallGiveUpMs * 2);
    deps.setReg({ waiting: true });
    await vi.advanceTimersByTimeAsync(TIMINGS.pollMs);
    expect(flow.stage()).toBe("switching");
    deps.fireActivated();
    expect(deps.calls.reload).toBe(1);
  });

  it("终局后 start 可重入（上一次失败的升级不污染下一次）", async () => {
    const deps = makeDeps();
    deps.setReg({ waiting: false, installing: true });
    const stages: UpgradeStage[] = [];
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: (s) => stages.push(s), onFail: () => {} });
    flow.start();
    await vi.advanceTimersByTimeAsync(TIMINGS.absoluteUnlockMs + TIMINGS.pollMs);
    expect(flow.stage()).toBe("idle");
    flow.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(stages.at(-1)).toBe("downloading");
    deps.setReg({ waiting: true });
    await vi.advanceTimersByTimeAsync(TIMINGS.pollMs);
    expect(flow.stage()).toBe("switching");
  });

  it("激活信号在订阅时同步到达：刷新一次后不再留下轮询与兜底定时器", async () => {
    const deps = makeDeps();
    deps.onNewSwActivated = (listener) => {
      listener();
      return () => {};
    };
    deps.setReg({ waiting: true });
    const onFail = vi.fn();
    const stages: UpgradeStage[] = [];
    const flow = createUpgradeFlow(deps, { timings: TIMINGS, onStage: (s) => stages.push(s), onFail });
    flow.start();
    expect(deps.calls.reload).toBe(1);
    await vi.advanceTimersByTimeAsync(TIMINGS.absoluteUnlockMs + TIMINGS.pollMs);
    // 终局后轮询不得再发接管令/切阶段，兜底不得误报
    expect(deps.calls.skipWaiting).toBe(0);
    expect(stages).toEqual(["downloading", "idle"]);
    expect(onFail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** 假 worker / registration / container：真 EventTarget + 可拨的状态槽 */
function fakeWorker(state: string): SwWorkerLike & EventTarget & { setState(next: string): void } {
  const target = new EventTarget() as SwWorkerLike & EventTarget & { setState(next: string): void };
  let current = state;
  Object.defineProperty(target, "state", { get: () => current });
  target.setState = (next) => {
    current = next;
    target.dispatchEvent(new Event("statechange"));
  };
  return target;
}

function fakeRegistration(slots: {
  waiting?: SwWorkerLike | null;
  installing?: SwWorkerLike | null;
  active?: SwWorkerLike | null;
}): SwRegistrationLike & EventTarget & { installing: SwWorkerLike | null } {
  const target = new EventTarget() as SwRegistrationLike & EventTarget & { installing: SwWorkerLike | null };
  return Object.assign(target, { waiting: null, installing: null, active: null, ...slots });
}

function fakeContainer(controller: SwWorkerLike | null): SwContainerLike & EventTarget {
  return Object.assign(new EventTarget(), { controller }) as SwContainerLike & EventTarget;
}

describe("subscribeNewSwActivated", () => {
  it("本页已被新 SW 接管（clientsClaim：他签确认升级后新 SW 激活并接管同源全部页面）：控制者不再是加载时那个 → 立即接管刷新", () => {
    const old = fakeWorker("redundant");
    const fresh = fakeWorker("activated");
    const reg = fakeRegistration({ active: fresh });
    const listener = vi.fn();
    subscribeNewSwActivated(reg, fakeContainer(fresh), listener, old);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("控制者仍是加载时那个（新 SW 还没下来）：不触发", () => {
    const current = fakeWorker("activated");
    const reg = fakeRegistration({ active: current });
    const listener = vi.fn();
    subscribeNewSwActivated(reg, fakeContainer(current), listener, current);
    expect(listener).not.toHaveBeenCalled();
  });

  it("waiting/installing 皆空、active 就是本页 controller（新 SW 还没下来）：不得触发接管", () => {
    const current = fakeWorker("activated");
    const reg = fakeRegistration({ active: current });
    const listener = vi.fn();
    subscribeNewSwActivated(reg, fakeContainer(current), listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("waiting/installing 皆空、active 不是本页 controller（他签已激活新 SW）：立即接管", () => {
    const reg = fakeRegistration({ active: fakeWorker("activated") });
    const listener = vi.fn();
    subscribeNewSwActivated(reg, fakeContainer(fakeWorker("redundant")), listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("waiting worker 进入 activated：触发接管；退订后不再触发", () => {
    const current = fakeWorker("activated");
    const waiting = fakeWorker("installed");
    const reg = fakeRegistration({ waiting, active: current });
    const listener = vi.fn();
    const unsub = subscribeNewSwActivated(reg, fakeContainer(current), listener);
    waiting.setState("activating");
    expect(listener).not.toHaveBeenCalled();
    waiting.setState("activated");
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    waiting.setState("activated");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("订阅时新 SW 还没出生：updatefound 后挂上新 installing，激活即接管；退订连带摘掉", () => {
    const current = fakeWorker("activated");
    const reg = fakeRegistration({ active: current });
    const listener = vi.fn();
    const unsub = subscribeNewSwActivated(reg, fakeContainer(current), listener);
    const fresh = fakeWorker("installing");
    reg.installing = fresh;
    reg.dispatchEvent(new Event("updatefound"));
    fresh.setState("installed");
    fresh.setState("activated");
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    fresh.setState("activated");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("controllerchange 补线：触发接管", () => {
    const current = fakeWorker("activated");
    const container = fakeContainer(current);
    const listener = vi.fn();
    subscribeNewSwActivated(fakeRegistration({ waiting: fakeWorker("installed"), active: current }), container, listener);
    container.dispatchEvent(new Event("controllerchange"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("createUpgradeGate", () => {
  it("存档失败：闸门放开，玩家可在弹窗上重试", async () => {
    const gate = createUpgradeGate();
    const run = vi.fn(async () => false);
    gate.begin(run);
    expect(gate.busy()).toBe(true);
    await vi.waitFor(() => expect(gate.busy()).toBe(false));
    gate.begin(run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("存档抛错同样放开闸门（不静默卡死）", async () => {
    const gate = createUpgradeGate();
    gate.begin(async () => {
      throw new Error("IndexedDB 挂了");
    });
    await vi.waitFor(() => expect(gate.busy()).toBe(false));
  });

  it("进行中重复确认只跑一次；成功后保持占用，直到卡死兜底 release", async () => {
    const gate = createUpgradeGate();
    const run = vi.fn(async () => true);
    gate.begin(run);
    gate.begin(run);
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(gate.busy()).toBe(true);
    gate.release();
    expect(gate.busy()).toBe(false);
  });
});
