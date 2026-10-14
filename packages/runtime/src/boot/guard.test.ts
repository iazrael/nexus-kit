// @vitest-environment happy-dom
import { parse } from "espree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootGuard, bootGuardScript, markBooted, reloadLatest, type BootGuardTexts, type SwLike } from "./guard.ts";

const TEXTS: BootGuardTexts = { title: "加载失败", hint: "说明", reload: "重新加载", checking: "正在检查…", updating: "正在更新…" };

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-boot");
  vi.useRealTimers();
});

/** 假 SW：可配置 waiting/installing 与 update 的结果；收到 SKIP_WAITING 后按 activates 触发 controllerchange */
function fakeSw(o: {
  waiting?: boolean;
  installing?: boolean;
  installDoneAfter?: number;
  updateAfter?: number;
  updateFindsNew?: boolean;
  activates?: boolean;
  controller?: boolean;
  noReg?: boolean;
  regHangs?: boolean;
  updateHangs?: boolean;
}) {
  const posted: unknown[] = [];
  const listeners = new Set<() => void>();
  const mk = (name: string) => ({
    name,
    postMessage: (m: unknown) => (
      posted.push({ to: name, m }),
      o.activates !== false && setTimeout(() => listeners.forEach((l) => l()), 10)
    ),
  });
  const reg: { waiting: ReturnType<typeof mk> | null; installing: object | null; update: () => Promise<void> } = {
    waiting: o.waiting === true ? mk("old-waiting") : null,
    installing: o.installing === true ? {} : null,
    update: () =>
      o.updateHangs === true
        ? new Promise(() => undefined)
        : new Promise((r) =>
            setTimeout(() => {
              if (o.updateFindsNew === true) {
                reg.installing = {};
                setTimeout(() => {
                  reg.installing = null;
                  reg.waiting = mk("new-waiting");
                }, o.installDoneAfter ?? 30);
              }
              r();
            }, o.updateAfter ?? 5),
          ),
  };
  if (o.installing === true)
    setTimeout(() => {
      reg.installing = null;
      reg.waiting = mk("new-waiting");
    }, o.installDoneAfter ?? 30);
  const sw: SwLike = {
    controller: o.controller === false ? null : {},
    getRegistration: () => (o.regHangs === true ? new Promise(() => undefined) : Promise.resolve(o.noReg === true ? undefined : reg)),
    addEventListener: (_t, l) => void listeners.add(l),
  };
  return { sw, posted };
}

function run(sw: SwLike | null, timeoutMs = 2000): Promise<{ ms: number; progress: string[] }> {
  const started = Date.now();
  const progress: string[] = [];
  return new Promise((done) =>
    reloadLatest({ sw, timeoutMs, onProgress: (s) => progress.push(s), reload: () => done({ ms: Date.now() - started, progress }) }),
  );
}

describe("reloadLatest", () => {
  it("已有等待中的新版本：激活后刷新", async () => {
    const { sw, posted } = fakeSw({ waiting: true });
    await run(sw);
    expect(posted).toEqual([{ to: "old-waiting", m: { type: "SKIP_WAITING" } }]);
  });

  it("没有新版本：检查更新一结束就刷新，不白等时限", async () => {
    const { ms } = await run(fakeSw({}).sw, 2000);
    expect(ms).toBeLessThan(500);
  });

  it("检查更新时发现新版本在下载：报「正在更新」，等它装好再激活新的", async () => {
    const { sw, posted } = fakeSw({ updateFindsNew: true, installDoneAfter: 100 });
    const { progress } = await run(sw);
    expect(progress).toContain("updating");
    expect(posted).toEqual([{ to: "new-waiting", m: { type: "SKIP_WAITING" } }]);
  });

  it("已有旧的等待版本、同时更新的在下载：等下载完激活更新的那个", async () => {
    const { sw, posted } = fakeSw({ waiting: true, installing: true, installDoneAfter: 100 });
    await run(sw);
    expect(posted).toEqual([{ to: "new-waiting", m: { type: "SKIP_WAITING" } }]);
  });

  it("已有旧的等待版本、检查更新还在途：不抢先激活旧的，等检查发现更新的版本后激活它", async () => {
    const { sw, posted } = fakeSw({ waiting: true, updateFindsNew: true, updateAfter: 80, installDoneAfter: 60 });
    await run(sw);
    expect(posted).toEqual([{ to: "new-waiting", m: { type: "SKIP_WAITING" } }]);
  });

  it("检查更新一直不返回（离线）：单独的检查时限到了就当检查完成，不在「正在检查」停满总时限", async () => {
    const { ms } = await run(fakeSw({ updateHangs: true }).sw, 30_000);
    expect(ms).toBeLessThan(7_000);
  }, 10_000);

  it("时限边缘才激活：激活后至少等 1 秒再刷新，不在接管之前刷新回旧版", async () => {
    const { ms } = await run(fakeSw({ waiting: true, updateHangs: true, activates: false }).sw, 200);
    expect(ms).toBeGreaterThanOrEqual(1_150);
  }, 10_000);

  it("取注册信息永远不返回（iOS 偶发）：到绝对时限也刷新，按钮不会卡死", async () => {
    const { ms } = await run(fakeSw({ regHangs: true }).sw, 200);
    expect(ms).toBeGreaterThanOrEqual(200);
    expect(ms).toBeLessThan(2000);
  });

  it("没有 SW、没有注册、接管信号不来、页面没被 SW 控制：都会刷新，且只刷新一次", async () => {
    for (const sw of [
      null,
      fakeSw({ noReg: true }).sw,
      fakeSw({ waiting: true, activates: false }).sw,
      fakeSw({ waiting: true, controller: false }).sw,
    ]) {
      let n = 0;
      await new Promise<void>((done) =>
        reloadLatest({
          sw,
          timeoutMs: 200,
          reload: () => {
            n++;
            setTimeout(done, 1500); // 等过绝对时限，确认不会刷新第二次
          },
        }),
      );
      expect(n).toBe(1);
    }
  }, 15_000);
});

const dialog = (): Element | null => document.querySelector('[role="alertdialog"]');

describe("bootGuard", () => {
  function guard() {
    const reload = vi.fn();
    bootGuard(window, (o) => reload(o), TEXTS, 15000);
    return { reload };
  }

  it("模块脚本加载失败：立即显示加载失败页；点重新加载走 reloadLatest 并显示正在更新", () => {
    const { reload } = guard();
    const script = document.createElement("script");
    script.type = "module";
    document.head.append(script);
    script.dispatchEvent(new Event("error"));
    expect(dialog()?.textContent).toContain("加载失败");
    const btn = dialog()!.querySelector("button")!;
    btn.click();
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("正在检查…");
    expect(btn.style.opacity).toBe("0.6");
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mock.calls[0]![0].onProgress("updating");
    expect(btn.textContent).toBe("正在更新…");
  });

  it("图片、样式表、普通脚本加载失败：不算主包失败，不显示", () => {
    vi.useFakeTimers();
    guard();
    for (const tag of ["img", "link"]) {
      const el = document.createElement(tag);
      document.head.append(el);
      el.dispatchEvent(new Event("error"));
    }
    const classic = document.createElement("script");
    document.head.append(classic);
    classic.dispatchEvent(new Event("error"));
    vi.advanceTimersByTime(3000);
    expect(dialog()).toBeNull();
  });

  it("页面级未捕获错误：2 秒后主包仍没启动才显示；15 秒没启动也显示", () => {
    vi.useFakeTimers();
    guard();
    window.dispatchEvent(new ErrorEvent("error", { message: "SyntaxError" }));
    vi.advanceTimersByTime(1900);
    expect(dialog()).toBeNull();
    vi.advanceTimersByTime(200);
    expect(dialog()).not.toBeNull();
    document.body.innerHTML = "";
    const second = document.createElement("div");
    document.body.append(second);
  });

  it("主包启动后（markBooted）：不再显示；已经显示的自动撤下", async () => {
    vi.useFakeTimers();
    guard();
    vi.advanceTimersByTime(15000);
    expect(dialog()).not.toBeNull();
    markBooted();
    expect(dialog()).toBeNull();
    window.dispatchEvent(new ErrorEvent("error", { message: "x" }));
    vi.advanceTimersByTime(20000);
    expect(dialog()).toBeNull();
  });
});

describe("bootGuardScript", () => {
  it("生成的内联脚本只含 ES5 语法（旧浏览器正是它要兜住的对象）", () => {
    const script = bootGuardScript(TEXTS);
    expect(() => parse(script, { ecmaVersion: 5 })).not.toThrow();
    expect(script).toContain("SKIP_WAITING");
  });

  it("生成的脚本能独立运行：主包加载失败时显示加载失败页", () => {
    new Function(bootGuardScript(TEXTS))();
    const script = document.createElement("script");
    script.type = "module";
    document.head.append(script);
    script.dispatchEvent(new Event("error"));
    expect(dialog()?.textContent).toContain("加载失败");
  });
});
