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
export declare function installCrashFallback(options: CrashFallbackOptions): CrashFallback;
