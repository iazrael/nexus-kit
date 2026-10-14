/**
 * 白屏兜底：应用起不来或界面崩溃时，用户看到的不能是一片白，而是一个能把诊断信息发出去的页面——
 * 「一打开就白屏」正是最需要诊断文件、却最导不出来的情况。
 *
 * 两条触发路：
 * - 挂载前出现未捕获异常或没人处理的 Promise 拒绝（入口代码抛错、动态导入的模块加载失败）：给 graceMs 宽限，
 *   期满仍没 markMounted、且页面确实是白的（isBlank）才显示——浏览器扩展、微信注入脚本之类的无关报错不该
 *   把正常起来的页面盖掉。若显示之后应用其实挂载
 *   成功了（慢机上挂载超过宽限期），markMounted 撤下兜底，不永久盖住正常页面；
 * - 宿主报告界面渲染崩溃（React 错误边界里调 report）：立即显示，不会被撤下。
 * 挂载后的普通异常不触发兜底，由 captureGlobalErrors 记进日志即可（挂载前的异常两边各记一条：captureGlobalErrors
 * 记原始异常，这里记「应用没能启动」，两条同源）。
 *
 * 覆盖不到的：静态导入的模块本身加载失败（404、断网）时整个模块图都不执行，本模块也没装上；要兜住这种情况
 * 只能在 index.html 里放不依赖打包产物的内联脚本。
 *
 * 只显示一次；显示前先把日志落盘，用户随后刷新或关掉也不丢现场。界面由宿主的 render 画（通常是
 * openDiagnosticsPanel 的 page 模式），可返回撤下函数；render 自己抛错时只记日志，不递归。
 */
import type { LogStore } from "../log/store.ts";
import { errText } from "../util.ts";

export interface CrashFallbackOptions {
  store: LogStore;
  /** 画兜底界面；reason 是一行说明（「启动失败：…」「渲染崩溃：…」）。可返回撤下函数 */
  render: (reason: string) => void | (() => void);
  /** 挂载前异常的宽限期，默认 1500ms */
  graceMs?: number;
  /**
   * 页面此刻是不是白的（宽限期到时检查；默认视为是）。宿主先读存档再挂载时可能慢于宽限期，期间一个无关报错
   * 不该把已经有内容的页面盖掉。模板传「#root 没有子元素」
   */
  isBlank?: () => boolean;
}

export interface CrashFallback {
  /** 应用已挂载：之后的普通异常不再触发兜底；宽限期满显示的兜底就此撤下 */
  markMounted(): void;
  /** 报告界面渲染崩溃：立即显示兜底。componentStack 是 React 给的组件栈，进日志 */
  report(error: unknown, componentStack?: string | null): void;
  dispose(): void;
}

const COMPONENT_STACK_MAX = 2000;

/** 跨域脚本报错时浏览器只给「Script error.」，换成能看懂的说明 */
function readable(message: string): string {
  return message === "Script error." ? "跨域脚本报错（浏览器不提供详情）" : message;
}

export function installCrashFallback(options: CrashFallbackOptions): CrashFallback {
  const log = options.store.log("lifecycle");
  const graceMs = options.graceMs ?? 1500;
  let mounted = false;
  let shown: "timeout" | "report" | null = null;
  let hide: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const show = (reason: string, by: "timeout" | "report"): void => {
    if (shown !== null) return;
    shown = by;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    options.store.flush();
    try {
      hide = options.render(reason) ?? null;
    } catch (error) {
      log.error("兜底界面显示失败", { error: errText(error) });
    }
  };

  const premount = (message: string): void => {
    if (mounted || shown !== null || timer !== null) return;
    log.error("应用没能启动：挂载前出现未捕获异常", { message });
    timer = setTimeout(() => {
      timer = null;
      if (mounted) return;
      let blank = true;
      try {
        blank = options.isBlank?.() ?? true;
      } catch {
        // 宿主的白屏判定自己抛错：按白屏处理——宁可多显示一次兜底，也不让真白屏漏掉
      }
      if (blank) show(`启动失败：${message}`, "timeout");
      else log.warn("挂载前的报错没有造成白屏（页面已有内容），不显示兜底", { message });
    }, graceMs);
  };
  const onError = (event: ErrorEvent): void => premount(readable(event.message || errText(event.error)));
  const onRejection = (event: PromiseRejectionEvent): void => premount(errText(event.reason));
  if (typeof window !== "undefined") {
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
  }

  return {
    markMounted() {
      mounted = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (shown === "timeout" && hide !== null) {
        hide();
        hide = null;
        shown = null; // 撤下后之后真正的渲染崩溃仍要能显示兜底；挂载前路径靠 mounted 挡住，不会再触发
        log.warn("兜底显示后应用挂载成功，已撤下兜底（挂载前的报错没有阻止启动）");
      }
    },
    report(error, componentStack) {
      log.error("界面渲染崩溃", {
        error,
        ...(componentStack ? { componentStack: componentStack.slice(0, COMPONENT_STACK_MAX) } : {}),
      });
      show(`渲染崩溃：${error instanceof Error ? error.message : String(error)}`, "report");
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (typeof window !== "undefined") {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      }
    },
  };
}
