// @vitest-environment happy-dom
import type { PwaController, PwaSnapshot, UpgradeHandlers } from "@nexus-kit/pwa";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateDialog } from "./UpdateDialog.tsx";

afterEach(cleanup);

function fake(initial: Partial<PwaSnapshot>) {
  let snapshot: PwaSnapshot = { needRefresh: true, promptOpen: true, pending: null, remoteVersion: "", stage: "idle", ...initial };
  const listeners = new Set<() => void>();
  let handlers: UpgradeHandlers | undefined;
  const ctl = {
    getSnapshot: () => snapshot,
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    dismissPrompt: vi.fn(() => set({ promptOpen: false })),
    manualCheck: vi.fn(),
    forceUpgrade: vi.fn(async () => "started" as const),
    beginUpgrade: vi.fn((h?: UpgradeHandlers) => {
      handlers = h;
      set({ promptOpen: false, stage: "downloading" });
    }),
  };
  function set(patch: Partial<PwaSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const l of [...listeners]) l();
  }
  return {
    ctl: ctl as unknown as PwaController,
    raw: ctl,
    set,
    fail: (r: "downloading-stuck") => (set({ stage: "idle" }), handlers?.onFail?.(r)),
  };
}

describe("UpdateDialog", () => {
  it("保存失败：如实提示，按钮恢复可重试", async () => {
    const f = fake({});
    render(<UpdateDialog controller={f.ctl} beforeUpgrade={async () => false} />);
    fireEvent.click(screen.getByRole("button", { name: "立即更新" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/进度没保存成功/));
    expect((screen.getByRole("button", { name: "立即更新" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("关闭态不渲染", () => {
    const f = fake({ promptOpen: false });
    const { container } = render(<UpdateDialog controller={f.ctl} />);
    expect(container.innerHTML).toBe("");
  });

  it("副标题给出「当前 → 最新」；最新版展开、更早版本折叠并计入隐藏数；同版本修复与拿不到说明各有如实文案", () => {
    const f = fake({
      remoteVersion: "1.2.0",
      pending: {
        kind: "upgrade",
        hiddenCount: 2,
        releases: [
          { version: "1.2.0", date: "2026-10-13", notes: ["新增：A"] },
          { version: "1.1.0", date: "2026-10-01", notes: ["修复：B"] },
        ],
      },
    });
    render(<UpdateDialog controller={f.ctl} />);
    expect(screen.getByText("当前 v0.0.0-test → 最新 v1.2.0")).toBeTruthy();
    expect(screen.getByText("新增：A")).toBeTruthy();
    expect(screen.getByText("你错过的更早版本（3 个，已一并包含）")).toBeTruthy();
    expect(screen.getByText("更新会刷新一次页面，你的数据不受影响。")).toBeTruthy();
    act(() => f.set({ pending: { kind: "hotfix", hiddenCount: 0, releases: [] } }));
    expect(screen.getByText("v1.2.0 · 问题修复更新")).toBeTruthy();
    expect(screen.getByText("修复了一些问题，体验更稳定。")).toBeTruthy();
    act(() => f.set({ pending: null }));
    expect(screen.getByText("检测到新版本，但暂时拿不到更新说明。")).toBeTruthy();
  });

  it("立即更新 → 保存后开跑，进度文案跟随阶段，卡死给原因", async () => {
    const f = fake({});
    const save = vi.fn(async () => true);
    render(<UpdateDialog controller={f.ctl} beforeUpgrade={save} />);
    fireEvent.click(screen.getByRole("button", { name: "立即更新" }));
    await waitFor(() => expect(f.raw.beginUpgrade).toHaveBeenCalled());
    expect(save).toHaveBeenCalled();
    expect(screen.getByText("正在下载新版本，通常十几秒，请别关掉应用…")).toBeTruthy();
    act(() => f.set({ stage: "switching" }));
    expect(screen.getByText("正在切换到新版本…")).toBeTruthy();
    act(() => f.fail("downloading-stuck"));
    expect(screen.getByRole("alert").textContent).toMatch(/网络有点慢/);
  });

  it("稍后 → dismissPrompt，弹窗关闭", () => {
    const f = fake({});
    render(<UpdateDialog controller={f.ctl} />);
    fireEvent.click(screen.getByRole("button", { name: "稍后" }));
    expect(f.raw.dismissPrompt).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
