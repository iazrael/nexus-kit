// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogStore } from "../log/store.ts";
import { installCrashFallback } from "./fallback.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const store = createLogStore({ key: "f.log", storage: null, sessionStorage: null, console: null, env: () => [] });
  const flush = vi.spyOn(store, "flush");
  const render = vi.fn();
  const fb = installCrashFallback({ store, render, graceMs: 1500 });
  disposers.push(
    () => fb.dispose(),
    () => store.dispose(),
  );
  return { store, render, fb, flush };
}

const fireError = (message: string): void => void window.dispatchEvent(new ErrorEvent("error", { message, error: new Error(message) }));

describe("installCrashFallback", () => {
  it("挂载前出异常、宽限期满仍没挂载：显示兜底一次，先落盘日志", () => {
    const { render, store, flush } = setup();
    fireError("模块加载失败");
    fireError("第二个错误");
    expect(render).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]![0]).toMatch(/启动失败：模块加载失败/);
    expect(flush).toHaveBeenCalled();
    expect(store.entries().some((e) => e.lv === "error" && /应用没能启动/.test(e.msg))).toBe(true);
  });

  it("宽限期到了但页面不是白的（宿主慢慢挂载、已有内容）：不显示兜底", () => {
    vi.useFakeTimers();
    const store = createLogStore({ key: "f2.log", storage: null, sessionStorage: null, console: null, env: () => [] });
    const render = vi.fn();
    let blank = false;
    const fb = installCrashFallback({ store, render, graceMs: 1500, isBlank: () => blank });
    disposers.push(
      () => fb.dispose(),
      () => store.dispose(),
    );
    fireError("微信注入脚本报错");
    vi.advanceTimersByTime(1500);
    expect(render).not.toHaveBeenCalled();
    blank = true;
    fb.report(new Error("渲染崩溃不看是否白屏"));
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("挂载前出了无关的小错误、随后正常挂载：不显示兜底", () => {
    const { render, fb } = setup();
    fireError("扩展脚本报错");
    fb.markMounted();
    vi.advanceTimersByTime(5000);
    expect(render).not.toHaveBeenCalled();
  });

  it("挂载后的异常不触发兜底（交给错误边界与日志）；宿主报告渲染崩溃则立即显示", () => {
    const { render, fb, store } = setup();
    fb.markMounted();
    fireError("点按钮报错");
    vi.advanceTimersByTime(5000);
    expect(render).not.toHaveBeenCalled();
    fb.report(new TypeError("读不到 x"));
    expect(render).toHaveBeenCalledWith(expect.stringMatching(/渲染崩溃：读不到 x/));
    expect(store.entries().some((e) => /界面渲染崩溃/.test(e.msg))).toBe(true);
    fb.report(new Error("再来一次"));
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("宽限期满显示了兜底、之后应用其实挂载成功：撤下兜底，不永久盖住正常页面", () => {
    const { render, fb, store } = setup();
    const hide = vi.fn();
    render.mockReturnValue(hide);
    fireError("慢机上的无关报错");
    vi.advanceTimersByTime(1500);
    expect(render).toHaveBeenCalledTimes(1);
    fb.markMounted();
    expect(hide).toHaveBeenCalledTimes(1);
    expect(store.entries().some((e) => /撤下兜底/.test(e.msg))).toBe(true);
    // 撤下之后真正的渲染崩溃仍要能显示兜底
    fb.report(new Error("之后真崩了"));
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1]![0]).toMatch(/渲染崩溃：之后真崩了/);
  });

  it("渲染崩溃显示的兜底不会因为 markMounted 撤下（StrictMode 下边界可能重复挂载）", () => {
    const { render, fb } = setup();
    const hide = vi.fn();
    render.mockReturnValue(hide);
    fb.report(new Error("渲染崩溃"));
    fb.markMounted();
    expect(hide).not.toHaveBeenCalled();
  });

  it("挂载前没人处理的 Promise 拒绝（动态导入失败）同样触发；跨域脚本的 Script error. 给出可读原因；组件栈进日志", () => {
    const { render, fb, store } = setup();
    const ev = new Event("unhandledrejection");
    Object.defineProperty(ev, "reason", { value: new TypeError("Failed to fetch dynamically imported module") });
    window.dispatchEvent(ev);
    vi.advanceTimersByTime(1500);
    expect(render.mock.calls[0]![0]).toMatch(/启动失败：.*dynamically imported module/);

    const second = setup();
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    vi.advanceTimersByTime(1500);
    expect(second.render.mock.calls[0]![0]).toMatch(/跨域脚本报错/);

    fb.dispose();
    const third = setup();
    third.fb.report(new Error("炸了"), "\n    at Boom\n    at App");
    expect(third.store.entries().find((e) => /界面渲染崩溃/.test(e.msg))!.data).toMatchObject({
      componentStack: expect.stringContaining("at Boom"),
    });
    expect(store).toBeTruthy();
  });

  it("兜底界面自己抛错：不递归、不抛出，记日志", () => {
    const { render, fb, store } = setup();
    render.mockImplementation(() => {
      throw new Error("兜底也挂了");
    });
    expect(() => fb.report(new Error("x"))).not.toThrow();
    expect(store.entries().some((e) => /兜底界面显示失败/.test(e.msg))).toBe(true);
  });
});
