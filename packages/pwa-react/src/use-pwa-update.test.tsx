// @vitest-environment happy-dom
import type { PwaController, PwaSnapshot, UpgradeHandlers } from "@nexus-kit/pwa";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePwaUpdate } from "./use-pwa-update.ts";

function fakeController() {
  let snapshot: PwaSnapshot = { needRefresh: false, promptOpen: false, pending: null, remoteVersion: "", stage: "idle" };
  const listeners = new Set<() => void>();
  let lastHandlers: UpgradeHandlers | undefined;
  const ctl = {
    getSnapshot: () => snapshot,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    dismissPrompt: vi.fn(),
    reopenPrompt: vi.fn(),
    manualCheck: vi.fn(async () => "latest" as const),
    forceUpgrade: vi.fn(async (opts?: { beforeReload?: () => Promise<void>; onFail?: (r: string) => void }) => {
      await opts?.beforeReload?.();
      return "started" as const;
    }),
    beginUpgrade: vi.fn((h?: UpgradeHandlers) => {
      lastHandlers = h;
    }),
  };
  return {
    ctl: ctl as unknown as PwaController,
    raw: ctl,
    emit(patch: Partial<PwaSnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const l of [...listeners]) l();
    },
    fail(reason: "no-install" | "switching-stuck" | "downloading-stuck") {
      lastHandlers?.onFail?.(reason);
    },
  };
}

describe("usePwaUpdate", () => {
  it("保存卡住：超时按失败处理，不把用户锁在弹窗里", async () => {
    const f = fakeController();
    const { result } = renderHook(() => usePwaUpdate(f.ctl, { saveTimeoutMs: 20 }));
    act(() => result.current.confirm(() => new Promise<boolean>(() => {})));
    expect(result.current.saving).toBe(true);
    await waitFor(() => expect(result.current.failReason).toBe("save-failed"));
    expect(result.current.saving).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(f.raw.beginUpgrade).not.toHaveBeenCalled();
  });

  it("保存期间点「稍后」：取消本次升级，保存落地后也不开跑；之后可再次确认", async () => {
    const f = fakeController();
    const { result } = renderHook(() => usePwaUpdate(f.ctl));
    let finish: (ok: boolean) => void = () => {};
    act(() => result.current.confirm(() => new Promise<boolean>((r) => (finish = r))));
    act(() => result.current.dismiss());
    expect(f.raw.dismissPrompt).toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
    await act(async () => finish(true));
    expect(f.raw.beginUpgrade).not.toHaveBeenCalled();
    act(() => result.current.confirm());
    await waitFor(() => expect(f.raw.beginUpgrade).toHaveBeenCalledTimes(1));
  });

  it("已进入下载/切换：「稍后」无效（用户已授权刷新）", () => {
    const f = fakeController();
    const { result } = renderHook(() => usePwaUpdate(f.ctl));
    act(() => f.emit({ stage: "downloading" }));
    act(() => result.current.dismiss());
    expect(f.raw.dismissPrompt).not.toHaveBeenCalled();
  });

  it("reopen / forceUpgrade 转交控制器；强制更新带上保存钩子", async () => {
    const f = fakeController();
    const { result } = renderHook(() => usePwaUpdate(f.ctl));
    result.current.reopen();
    expect(f.raw.reopenPrompt).toHaveBeenCalled();
    const save = vi.fn(async () => true);
    await act(async () => void (await result.current.forceUpgrade(save)));
    expect(save).toHaveBeenCalled();
    expect(f.raw.forceUpgrade).toHaveBeenCalledWith(expect.objectContaining({ saveTimeoutMs: 5000 }));
    await act(async () => void (await result.current.forceUpgrade()));
    const onFail = (f.raw.forceUpgrade.mock.calls.at(-1)![0] as { onFail: (r: string) => void }).onFail;
    act(() => onFail("no-install"));
    expect(result.current.failReason).toBe("no-install");
  });

  it("快照随控制器变化重渲染", () => {
    const f = fakeController();
    const { result } = renderHook(() => usePwaUpdate(f.ctl));
    expect(result.current.snapshot.promptOpen).toBe(false);
    act(() => f.emit({ promptOpen: true, remoteVersion: "1.1.0" }));
    expect(result.current.snapshot.promptOpen).toBe(true);
    expect(result.current.snapshot.remoteVersion).toBe("1.1.0");
  });

  it("confirm：保存成功才开跑；双击只跑一次；卡死后复位并给出原因、可重试", async () => {
    const f = fakeController();
    const { result } = renderHook(() => usePwaUpdate(f.ctl));
    const save = vi.fn(async () => true);
    act(() => {
      result.current.confirm(save);
      result.current.confirm(save);
    });
    await waitFor(() => expect(f.raw.beginUpgrade).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);
    act(() => f.fail("switching-stuck"));
    expect(result.current.failReason).toBe("switching-stuck");
    expect(result.current.busy).toBe(false);
    act(() => result.current.confirm());
    await waitFor(() => expect(f.raw.beginUpgrade).toHaveBeenCalledTimes(2));
    expect(result.current.failReason).toBeNull();
  });

  it("保存失败或抛错：不开跑，给出 save-failed，闸门放开可重试", async () => {
    const f = fakeController();
    const { result } = renderHook(() => usePwaUpdate(f.ctl));
    act(() => result.current.confirm(async () => false));
    await waitFor(() => expect(result.current.failReason).toBe("save-failed"));
    expect(result.current.busy).toBe(false);
    act(() => result.current.confirm(async () => Promise.reject(new Error("db"))));
    await waitFor(() => expect(result.current.failReason).toBe("save-failed"));
    expect(f.raw.beginUpgrade).not.toHaveBeenCalled();
    act(() => result.current.confirm(async () => true));
    await waitFor(() => expect(f.raw.beginUpgrade).toHaveBeenCalledTimes(1));
  });

  it("dismiss / manualCheck 转交控制器；dismiss 清掉卡死原因", async () => {
    const f = fakeController();
    const { result } = renderHook(() => usePwaUpdate(f.ctl));
    act(() => result.current.confirm());
    await waitFor(() => expect(f.raw.beginUpgrade).toHaveBeenCalled());
    act(() => f.fail("no-install"));
    expect(result.current.failReason).toBe("no-install");
    act(() => result.current.dismiss());
    expect(result.current.failReason).toBeNull();
    expect(f.raw.dismissPrompt).toHaveBeenCalled();
    await expect(result.current.manualCheck()).resolves.toBe("latest");
  });
});
