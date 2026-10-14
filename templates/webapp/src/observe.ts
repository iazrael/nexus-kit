/**
 * 日志、异常退出取证与白屏兜底（@nexus-kit/runtime）：整个应用一个日志 store，main.tsx 第一行导入本模块，
 * 好让取证、异常捕获与白屏兜底赶在其他模块之前装好——之后入口代码抛错、动态导入失败、界面渲染崩溃都会被兜住
 * （静态导入的模块本身加载失败时整个模块图都不执行，兜不住）。
 * 各模块用 `logs.log("模块名")` 取命名 logger。版本号连点 5 次打开诊断面板（app.tsx）；应用起不来或界面
 * 崩溃时显示整页兜底，同样能导出诊断信息。诊断全文含上次退出判词、未捕获异常与最近 3 个会话的日志。
 */
import {
  captureGlobalErrors,
  diagnosticFileName,
  installCrashFallback,
  openDiagnosticsPanel,
  prefersShare,
  startForensics,
  type PanelTexts,
} from "@nexus-kit/runtime/lifecycle";
import { markBooted } from "@nexus-kit/runtime/boot";
import { createLogStore, defaultEnvLines, truncateExport } from "@nexus-kit/runtime/log";
import { APP_ID } from "../pwa.config.ts";
import { APP_BUILD, APP_VERSION } from "./build-info.ts";

// 主包已开始执行：注入 index.html 的「主包加载失败」兜底就此退出（已经弹出的撤下），之后由下面的 runtime 兜底接管
markBooted();

export const logs = createLogStore({
  key: `${APP_ID}.log`,
  env: () => [`版本：${APP_VERSION}（构建 ${APP_BUILD}）`, ...defaultEnvLines()],
});

export const forensics = startForensics({ prefix: APP_ID, store: logs });

// 未捕获异常与没人处理的 Promise 拒绝进日志（同一条一分钟只记一次，每分钟有总数上限）
captureGlobalErrors(logs);

/**
 * 诊断面板文案。下载拿不到成功信号，只能如实说「已开始」；每条失败提示都给出不绕回原处的退路——微信等应用内
 * 浏览器里分享、下载、复制都可能不灵，最后的路是换到系统浏览器。说明里不做「不含个人数据」之类的承诺：
 * kit 只去掉 URL 查询串，管不了宿主自己写进日志的内容
 */
const IN_APP_ESCAPE = "在微信等应用里，点右上角「···」选「在浏览器打开」后再试。";
const PANEL_TEXTS: PanelTexts = {
  title: "导出诊断信息",
  hint: "把诊断信息发给开发者，帮助排查问题。内容是应用的运行记录，以及浏览器、屏幕尺寸等设备信息。",
  send: prefersShare() ? "发送诊断文件" : "下载诊断文件",
  copy: "复制诊断内容",
  close: "关闭",
  reload: "重新加载",
  checking: "正在检查新版本…",
  updating: "正在下载新版本…",
  results: {
    shared: "已分享",
    downloaded: `已开始下载（文件名以「${APP_ID}-诊断」开头，在「下载」里找）。没找到的话，点「复制诊断内容」粘贴给开发者。`,
    cancelled: "",
    copied: "已复制，粘贴到聊天里发给开发者即可（内容太长时只取了最近的日志）。",
    copyFailed: `复制没成功。${IN_APP_ESCAPE}`,
    failed: `导出没成功。${IN_APP_ESCAPE}`,
  },
};

/** 复制的上限：聊天应用贴不进太长的内容。取值没有对各聊天应用实测，不够再调 */
const COPY_MAX_CHARS = 10_000;

const panelBase = {
  getText: () => logs.exportText(),
  getCopyText: () =>
    truncateExport(logs.exportText(), COPY_MAX_CHARS, {
      note: (n) => `已截取：省略了较早的 ${n} 行日志，完整内容请用「${PANEL_TEXTS.send}」（微信里先在浏览器打开）`,
    }),
  fileName: () => diagnosticFileName(APP_ID, Date.now()),
};

/** 用户主动打开（版本号连点 5 次） */
export function openDiagnostics(): void {
  openDiagnosticsPanel({ ...panelBase, mode: "sheet", texts: PANEL_TEXTS });
}

/**
 * 白屏兜底：应用起不来或界面崩溃时整页显示，可导出诊断、可重新加载。返回关闭函数：慢机上兜底显示后
 * 应用又挂载成功时由 runtime 撤下
 */
export const crashFallback = installCrashFallback({
  store: logs,
  // 页面已有内容就不是白屏：宿主挂载慢于宽限期时，一个无关报错不该把它盖掉
  isBlank: () => (document.getElementById("root")?.childElementCount ?? 0) === 0,
  render: () => {
    const panel = openDiagnosticsPanel({
      ...panelBase,
      mode: "page",
      texts: {
        ...PANEL_TEXTS,
        title: "应用出错了",
        hint: "应用没能正常显示。可以先把诊断信息发给开发者，再点「重新加载」（会先换上已下载好的新版本；刚更新过的话可以再点一次）。还不行就关掉页面重新打开（主屏应用从多任务界面划掉；微信里点右上角「···」选「在浏览器打开」）。",
      },
    });
    return () => panel.close();
  },
});
