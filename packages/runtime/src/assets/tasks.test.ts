import { afterEach, describe, expect, it, vi } from "vitest";
import { mapLimit, whenIdle } from "./tasks.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mapLimit", () => {
  it("同时最多 limit 个，结果按输入顺序；任一失败整体拒绝", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([30, 10, 20, 5, 1], 2, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    await expect(mapLimit([1, 2], 2, async (x) => (x === 2 ? Promise.reject(new Error("坏")) : x))).rejects.toThrow("坏");
    expect(await mapLimit([], 3, async (x) => x)).toEqual([]);
  });

  it("一项失败后不再取新项（与串行同语义）；并发数非法直接抛", async () => {
    const calls: number[] = [];
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5], 2, async (x) => {
        calls.push(x);
        await new Promise((r) => setTimeout(r, 1));
        if (x === 0) throw new Error("坏");
        return x;
      }),
    ).rejects.toThrow("坏");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBeLessThanOrEqual(3); // 失败那一刻在飞的另一项会跑完，之后不再取
    await expect(mapLimit([1, 2], Number.NaN, async (x) => x)).rejects.toThrow(RangeError);
    await expect(mapLimit([1, 2], 0, async (x) => x)).rejects.toThrow(RangeError);
  });
});

describe("whenIdle", () => {
  it("有 requestIdleCallback 用它（带封顶时限）；没有退到定时器；可取消", () => {
    vi.useFakeTimers();
    const ric = vi.fn((_cb: () => void, _o?: { timeout: number }) => 7);
    const cic = vi.fn();
    vi.stubGlobal("requestIdleCallback", ric);
    vi.stubGlobal("cancelIdleCallback", cic);
    const fn = vi.fn();
    const cancel = whenIdle(fn);
    expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: 3000 });
    cancel();
    expect(cic).toHaveBeenCalledWith(7);

    vi.stubGlobal("requestIdleCallback", undefined);
    const fn2 = vi.fn();
    const cancel2 = whenIdle(fn2);
    vi.advanceTimersByTime(1499);
    expect(fn2).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn2).toHaveBeenCalledOnce();
    const fn3 = vi.fn();
    whenIdle(fn3)();
    vi.advanceTimersByTime(2000);
    expect(fn3).not.toHaveBeenCalled();
    void cancel2;
  });
});
