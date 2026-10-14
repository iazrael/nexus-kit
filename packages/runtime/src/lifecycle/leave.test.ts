import { describe, expect, it, vi } from "vitest";
import { leaveAfterSave } from "./leave.ts";

describe("leaveAfterSave", () => {
  it("保存完成才离开", async () => {
    const order: string[] = [];
    await leaveAfterSave(
      async () => void order.push("save"),
      () => void order.push("leave"),
    );
    expect(order).toEqual(["save", "leave"]);
  });

  it("保存失败或超时都不离开，错误抛给调用方提示重试", async () => {
    const leave = vi.fn();
    await expect(leaveAfterSave(() => Promise.reject(new Error("写盘失败")), leave)).rejects.toThrow("写盘失败");
    vi.useFakeTimers();
    const pending = leaveAfterSave(() => new Promise<void>(() => undefined), leave, { timeoutMs: 5000 });
    const assertion = expect(pending).rejects.toThrow(/5000ms 未完成/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    vi.useRealTimers();
    expect(leave).not.toHaveBeenCalled();
  });
});
