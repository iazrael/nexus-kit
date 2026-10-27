import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudcliSettings, Executor, ExecutorLaunch, ExecutorReceipt } from "./types.ts";
import { atomic } from "./io.ts";
import { check, object, text } from "./validation.ts";

export function parseCloudcliSettings(value: unknown): CloudcliSettings {
  const raw = object(value, "cloudcli 执行器配置");
  const endpoint = text(raw.endpoint, "cloudcli.endpoint");
  const url = new URL(endpoint);
  check(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "cloudcli.endpoint 必须是本机 HTTP 地址");
  check(!url.username && !url.password && !url.search && !url.hash, "cloudcli.endpoint 不能携带凭据、查询参数或片段");
  const tokenEnv = text(raw.tokenEnv, "cloudcli.tokenEnv");
  check(/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv), "cloudcli.tokenEnv 必须为环境变量名");
  const permissionMode = raw.permissionMode;
  check(
    permissionMode === "default" || permissionMode === "bypassPermissions",
    "cloudcli.permissionMode 必须明确为 default 或 bypassPermissions",
  );
  for (const key of ["command", "permissionArgs"])
    check(raw[key] === undefined || (Array.isArray(raw[key]) && raw[key].length === 0), `cloudcli 不接受 ${key}，执行环境归服务端所有`);
  return {
    endpoint: url.href,
    tokenEnv,
    provider: text(raw.provider, "cloudcli.provider"),
    model: text(raw.model, "cloudcli.model"),
    permissionMode,
    command: [],
    permissionArgs: [],
  };
}
function output(stdoutPath: string) {
  return object(JSON.parse(readFileSync(stdoutPath, "utf8")) as unknown, "CloudCLI 执行结果");
}
export const cloudcliExecutor: Executor = {
  parseSettings: parseCloudcliSettings,
  invocation(settings, conversationId, runDir, _stdoutPath, prompt): ExecutorLaunch {
    const requestFile = join(runDir, "cloudcli-request.json");
    const sessionLog = join(runDir, "cloudcli-run.json");
    atomic(requestFile, {
      settings,
      prompt,
      requestId: createHash("sha256").update(runDir).digest("hex"),
      ...(conversationId ? { sessionId: conversationId } : {}),
      sessionLog,
    });
    return {
      exe: process.execPath,
      argv: [
        fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cloudcli-worker.ts" : "./cloudcli-worker.js", import.meta.url)),
        requestFile,
      ],
      sessionLog,
      requestFile,
    };
  },
  sessionScanner(launch, expected) {
    return () => {
      if (!existsSync(launch.sessionLog)) return null;
      const record = object(JSON.parse(readFileSync(launch.sessionLog, "utf8")) as unknown, "CloudCLI 运行记录");
      const id = text(record.sessionId, "CloudCLI 会话");
      check(!expected || id === expected, "CloudCLI 返回了不同的原会话");
      return id;
    };
  },
  progress(launch) {
    if (!existsSync(launch.sessionLog)) return null;
    const record = object(JSON.parse(readFileSync(launch.sessionLog, "utf8")) as unknown, "CloudCLI 运行记录");
    return {
      conversationId: text(record.sessionId, "CloudCLI 会话"),
      state: text(record.state, "CloudCLI 状态"),
      runId: text(record.runId, "CloudCLI runId"),
    };
  },
  receipt(stdoutPath): ExecutorReceipt {
    const result = output(stdoutPath);
    check(result.state === "succeeded" && result.stopConfirmed === true, "CloudCLI 执行未成功或未确认停止");
    return {
      conversationId: text(result.sessionId, "CloudCLI 会话"),
      ...(typeof result.response === "string" ? { response: result.response } : {}),
    };
  },
  salvage(stdoutPath) {
    const result = output(stdoutPath);
    return {
      ...(typeof result.sessionId === "string" ? { conversationId: result.sessionId } : {}),
      ...(typeof result.response === "string" ? { response: result.response } : {}),
      ...(typeof result.error === "string" ? { failure: { type: "cloudcli", message: result.error } } : {}),
    };
  },
  stop: async (launch) => {
    const { stopCloudcli } = await import("./cloudcli-client.ts");
    await stopCloudcli(text(launch.requestFile, "CloudCLI 请求文件"));
  },
};
