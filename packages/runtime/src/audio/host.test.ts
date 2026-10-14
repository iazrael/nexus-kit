// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAudioHost, type AudioHostOptions } from "./host.ts";
import { asCtx, FakeContext, FakeGain, flush } from "./fake-audio.test-util.ts";

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  FakeContext.created = [];
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
const hosts: Array<{ dispose(): void }> = [];
afterEach(() => {
  // 每个 host 都在 document 上挂 visibilitychange：不摘掉会串到后面的用例
  for (const h of hosts.splice(0)) h.dispose();
  vi.useRealTimers();
});

function setVisible(v: DocumentVisibilityState): void {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

function rig(over: Partial<AudioHostOptions> = {}) {
  const logs: string[] = [];
  const host = createAudioHost({
    buses: ["music", "sfx"],
    createContext: () => asCtx(new FakeContext()),
    log: {
      debug: () => undefined,
      info: (m) => logs.push(`info ${m}`),
      warn: (m, d) => logs.push(`warn ${m} ${JSON.stringify(d)}`),
      error: (m) => logs.push(`error ${m}`),
    },
    ...over,
  });
  hosts.push(host);
  const ctx = (i = -1) => FakeContext.created.at(i)!;
  return { host, logs, ctx };
}

describe("createAudioHost", () => {
  it("惰性创建：unlock 前没有 context；unlock 建 context 与总线、按偏好设增益；再次 unlock 不重建", async () => {
    const { host, ctx } = rig({ prefs: { master: 0.8, muted: false, buses: { music: 0.5, sfx: 1 } } });
    expect(host.context).toBeNull();
    expect(host.bus("music")).toBeNull();
    host.unlock();
    await flush();
    expect(FakeContext.created).toHaveLength(1);
    expect(host.snapshot()).toMatchObject({ unlocked: true, state: "running", rebuilds: 0 });
    expect((host.bus("music") as unknown as FakeGain).gain.value).toBe(0.5);
    expect((host.master as unknown as FakeGain).gain.value).toBe(0.8);
    expect(host.bus("voice")).toBeNull();
    host.unlock();
    expect(FakeContext.created).toHaveLength(1);
    expect(ctx().resumeCalls).toBe(1); // 已 running 不再 resume
  });

  it("没有 Web Audio 的环境：unlock 静默降级，只记一次日志", () => {
    const { host, logs } = rig({ createContext: () => null });
    host.unlock();
    host.unlock();
    expect(host.context).toBeNull();
    expect(logs.filter((l) => /不支持/.test(l))).toHaveLength(1);
  });

  it("静音、音量与下潜：多个下潜来源取最深一档，全撤才回升", async () => {
    const { host } = rig();
    host.unlock();
    await flush();
    const music = host.bus("music") as unknown as FakeGain;
    host.setPrefs({ master: 1, muted: true, buses: { music: 0.6, sfx: 1 } });
    expect((host.master as unknown as FakeGain).gain.value).toBe(0);
    expect(music.gain.value).toBe(0.6);
    host.duck("music", "倒计时", 0.75);
    host.duck("music", "开麦", 0.5);
    expect(music.gain.value).toBeCloseTo(0.3);
    host.duck("music", "开麦", null);
    expect(music.gain.value).toBeCloseTo(0.45);
    host.duck("music", "倒计时", null);
    expect(music.gain.value).toBeCloseTo(0.6);
    expect(host.prefs.buses.music).toBe(0.6);
  });

  it("回前台：iOS 的 interrupted 也去 resume，回到 running 就通知（供音乐校对）", async () => {
    const { host, ctx } = rig();
    const running = vi.fn();
    host.onRunning(running);
    host.unlock();
    await flush();
    running.mockClear();
    ctx().state = "interrupted";
    setVisible("visible");
    await flush();
    expect(ctx().resumeCalls).toBe(2);
    expect(running).toHaveBeenCalled(); // statechange 与 resume 落地可能各通知一次：订阅方的校对必须幂等
    running.mockClear();
    // 回前台时已经 running（WebKit 自己恢复了）：也通知，让播放器校对被掐死的声源
    setVisible("visible");
    expect(running).toHaveBeenCalledOnce();
  });

  it("statechange 回到 running 也通知（visibilitychange 在 iOS 上会漏）", async () => {
    const { host, ctx } = rig();
    const running = vi.fn();
    host.onRunning(running);
    host.unlock();
    await flush();
    running.mockClear();
    ctx().setState("interrupted");
    ctx().setState("running");
    expect(running).toHaveBeenCalledOnce();
  });

  it("resume 落地仍不 running 或被拒：关旧 context 换新的，广播 onRebuild；上限 3 次，超过放弃并记 warn", async () => {
    const { host, ctx, logs } = rig();
    const rebuilt = vi.fn();
    host.onRebuild(rebuilt);
    host.unlock();
    await flush();
    const first = ctx();
    first.state = "interrupted";
    first.resumeMode = "stays";
    setVisible("visible");
    await flush();
    expect(first.closed).toBe(true);
    expect(first.listenerCount()).toBe(0);
    expect(FakeContext.created).toHaveLength(2);
    expect(host.context).toBe(asCtx(ctx()));
    expect(rebuilt).toHaveBeenCalledWith(asCtx(ctx()));
    for (let i = 0; i < 3; i++) {
      const c = ctx();
      c.state = "interrupted";
      c.resumeMode = "reject";
      setVisible("visible");
      await flush();
    }
    expect(host.snapshot().rebuilds).toBe(3);
    expect(FakeContext.created).toHaveLength(4);
    expect(logs.some((l) => /重建放弃/.test(l))).toBe(true);
  });

  it("whenRunning：running 立即执行；挂起时先 resume 再执行；落地前引擎已换新则不执行", async () => {
    const { host, ctx } = rig();
    expect(await host.whenRunning(() => undefined)).toBe(false); // 没解锁
    host.unlock();
    await flush();
    const fn = vi.fn();
    expect(await host.whenRunning(fn)).toBe(true);
    expect(fn).toHaveBeenCalledWith(asCtx(ctx()));
    ctx().state = "suspended";
    const fn2 = vi.fn();
    const p = host.whenRunning(fn2);
    expect(fn2).not.toHaveBeenCalled(); // 不排在冻结的时间轴上
    expect(await p).toBe(true);
    expect(fn2).toHaveBeenCalledOnce();
    ctx().state = "suspended";
    ctx().resumeMode = "stays";
    const fn3 = vi.fn();
    expect(await host.whenRunning(fn3)).toBe(false);
    expect(fn3).not.toHaveBeenCalled();
  });

  it("suspendWhenHidden：切后台先淡出再挂起；挂起前回前台则取消", async () => {
    vi.useFakeTimers();
    const { host, ctx } = rig({ suspendWhenHidden: true });
    host.unlock();
    await vi.advanceTimersByTimeAsync(0);
    setVisible("hidden");
    expect((host.master as unknown as FakeGain).gain.value).toBeLessThan(0.01);
    await vi.advanceTimersByTimeAsync(350);
    expect(ctx().state).toBe("suspended");
    setVisible("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx().state).toBe("running");
    expect((host.master as unknown as FakeGain).gain.value).toBe(1);
    expect(FakeContext.created).toHaveLength(1); // 自己挂起的不算假死
    // 0.3 秒内切回来：引擎没被挂起，但淡出渐变还在时间线上，必须撤掉，否则恢复的音量又被拉回静音
    setVisible("hidden");
    setVisible("visible");
    await vi.advanceTimersByTimeAsync(400);
    expect(ctx().state).toBe("running");
    expect((host.master as unknown as { gain: { scheduled: number[] } }).gain.scheduled).toEqual([]);
  });

  it("whenRunning：resume 被拒记日志；fn 抛错不外泄，记 warn 并返回 false", async () => {
    const { host, ctx, logs } = rig();
    host.unlock();
    await flush();
    expect(
      await host.whenRunning(() => {
        throw new Error("节点已死");
      }),
    ).toBe(false);
    expect(logs.some((l) => /warn .*发声失败.*节点已死/.test(l))).toBe(true);
    ctx().state = "suspended";
    ctx().resumeMode = "reject";
    expect(await host.whenRunning(() => undefined)).toBe(false);
    expect(logs.some((l) => /唤醒被拒/.test(l))).toBe(true);
  });

  it("首次 resume 被拒、之后手势唤醒成功：记为已解锁；到达重建上限后只记一次放弃", async () => {
    // 建好的 context 第一次 resume 被拒（不在手势里）
    const { host, ctx, logs } = rig({
      maxRebuilds: 0,
      createContext: () => {
        const c = new FakeContext();
        c.resumeMode = "reject";
        return asCtx(c);
      },
    });
    host.unlock();
    await flush();
    expect(host.snapshot().unlocked).toBe(false);
    ctx().resumeMode = "running";
    ctx().state = "suspended";
    host.unlock();
    await flush();
    expect(host.snapshot().unlocked).toBe(true);
    for (let i = 0; i < 3; i++) {
      ctx().state = "interrupted";
      ctx().resumeMode = "stays";
      setVisible("visible");
      await flush();
    }
    expect(logs.filter((l) => /重建放弃/.test(l))).toHaveLength(1);
  });

  it("resetSession：挂起 120ms 再恢复（iOS 停麦后输出被压低）；dispose 关 context、摘监听", async () => {
    vi.useFakeTimers();
    const { host, ctx } = rig();
    host.unlock();
    await vi.advanceTimersByTimeAsync(0);
    host.resetSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx().state).toBe("suspended");
    await vi.advanceTimersByTimeAsync(120);
    expect(ctx().state).toBe("running");
    const c = ctx();
    host.dispose();
    expect(c.closed).toBe(true);
    expect(c.listenerCount()).toBe(0);
    expect(host.context).toBeNull();
  });
});
