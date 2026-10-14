// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionBadge } from "./VersionBadge.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("VersionBadge", () => {
  it("显示版本与构建号", () => {
    render(<VersionBadge version="v1.2.0" build={7} onExport={vi.fn()} onProgress={vi.fn()} />);
    expect(screen.getByTestId("app-version").textContent).toBe("版本 1.2.0（构建 7）");
  });

  it("2 秒内连点 5 次才导出一次；间隔过长重新计数；第 3、4 下报剩余次数", () => {
    vi.useFakeTimers();
    const onExport = vi.fn();
    const onProgress = vi.fn();
    render(<VersionBadge version="v1.2.0" build={7} onExport={onExport} onProgress={onProgress} />);
    const badge = screen.getByTestId("app-version");
    for (let i = 0; i < 4; i++) fireEvent.click(badge);
    expect(onProgress.mock.calls).toEqual([[2], [1]]);
    act(() => void vi.advanceTimersByTime(2100));
    fireEvent.click(badge);
    expect(onExport).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) fireEvent.click(badge);
    expect(onExport).toHaveBeenCalledTimes(1);
    fireEvent.click(badge);
    expect(onExport).toHaveBeenCalledTimes(1);
  });
});
