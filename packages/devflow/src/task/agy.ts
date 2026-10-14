import type { AgyConfig } from "./types.ts";
import { object, errorMessage } from "./validation.ts";
import { existsSync, openSync, readSync, closeSync, lstatSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { check, json, text } from "./definition.ts";

// Only these records identify the session created/resumed by this invocation.
const sessionLine =
  /\b(?:Created conversation|Print mode: resuming conversation) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i;
export function agySessions(path: string, expected: string | null = null) {
  let offset = 0,
    pending = "",
    identified: string | null = null;
  const decoder = new StringDecoder("utf8");
  return () => {
    if (!existsSync(path)) return identified;
    const stat = lstatSync(path);
    check(stat.isFile() && !stat.isSymbolicLink(), "agy 启动日志必须为普通文件");
    check(stat.size >= offset, "agy 启动日志被截断，无法确认本次会话");
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(16_384);
      let size;
      while ((size = readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
        offset += size;
        pending += decoder.write(buffer.subarray(0, size));
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const match = line.trim().match(sessionLine);
          if (!match) continue;
          const id = match[1]!.toLowerCase();
          check(!expected || id === expected, "启动日志返回了不同会话，保留原会话标识");
          check(!identified || id === identified, "启动日志报告了多个不同会话");
          identified = id;
        }
        check(pending.length < 1_048_576, "agy 启动日志单行过长");
      }
    } catch (e) {
      throw Object.assign(new Error(errorMessage(e)), { identifiedConversationId: identified });
    } finally {
      closeSync(fd);
    }
    return identified;
  };
}
export function agyResult(path: string) {
  const result = object(json(path), "执行器结果");
  const conversation_id = text(result.conversation_id, "执行器 conversation_id");
  check(!/[\s\0]/.test(conversation_id), "执行器 conversation_id 不合法");
  check(typeof result.status === "string" && result.status.toUpperCase() === "SUCCESS", "执行器没有报告 SUCCESS");
  return { ...result, conversation_id };
}

/** 当前唯一执行器的启动合同：命令、会话、模型、权限和输出格式。 */
export function agyInvocation(
  config: AgyConfig,
  conversation: string | null,
  logFile: string,
  prompt: string,
): { exe: string; argv: string[] } {
  const [exe, ...prefix] = config.command;
  return {
    exe: text(exe, "执行器命令"),
    argv: [
      ...prefix,
      ...(conversation ? ["--conversation", conversation] : ["--new-project"]),
      "--model",
      config.model,
      "--effort",
      config.effort,
      "--mode",
      config.mode,
      ...config.permissionArgs,
      "--output-format",
      "json",
      "--log-file",
      logFile,
      "--print",
      prompt,
    ],
  };
}
