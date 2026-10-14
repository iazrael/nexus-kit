/**
 * 日志与异常退出取证（@nexus-kit/runtime）：整个应用一个日志 store，在 main.tsx 渲染之前初始化，
 * 好让取证尽早写下本局的开启标记。各模块用 `logs.log("模块名")` 取命名 logger。
 * 版本号连点 5 次导出诊断文件（app.tsx），文件里有上次退出判词、未捕获异常与最近 3 个会话的日志。
 */
import { captureGlobalErrors, deliverTextFile, diagnosticFileName, startForensics, type DeliverResult } from "@nexus-kit/runtime/lifecycle";
import { createLogStore, defaultEnvLines } from "@nexus-kit/runtime/log";
import { APP_ID } from "../pwa.config.ts";
import { APP_BUILD, APP_VERSION } from "./build-info.ts";

export const logs = createLogStore({
  key: `${APP_ID}.log`,
  env: () => [`版本：${APP_VERSION}（构建 ${APP_BUILD}）`, ...defaultEnvLines()],
});

export const forensics = startForensics({ prefix: APP_ID, store: logs });

// 未捕获异常与没人处理的 Promise 拒绝进日志（同一条一分钟只记一次，每分钟有总数上限）
captureGlobalErrors(logs);

export function exportDiagnostics(): Promise<DeliverResult> {
  return deliverTextFile(diagnosticFileName(APP_ID, Date.now()), logs.exportText());
}
