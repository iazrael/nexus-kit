import { check, command, object, stringList, text, json } from "./validation.js";
import { sessionLineScanner } from "./scan.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
export const efforts = ["low", "medium", "high", "xhigh", "max"];
export const modes = ["accept-edits", "auto", "plan"];
// Only these records identify the session created/resumed by this invocation.
const sessionLine = /\b(?:Created conversation|Print mode: resuming conversation) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i;
const matchSessionLine = (line) => line.match(sessionLine)?.[1]?.toLowerCase() ?? null;
export function parseAgySettings(value) {
    const raw = object(value, "agy 执行器配置");
    const effort = text(raw.effort, "agy.effort");
    const mode = text(raw.mode, "agy.mode");
    check(efforts.includes(effort), "agy.effort 不合法");
    check(modes.includes(mode), "agy.mode 不合法");
    return {
        command: command(raw.command, "agy.command"),
        model: text(raw.model, "agy.model"),
        effort,
        mode,
        permissionArgs: stringList(raw.permissionArgs, "agy.permissionArgs"),
    };
}
function parseReceipt(stdoutPath) {
    const result = object(json(stdoutPath), "执行器结果");
    const conversationId = text(result.conversation_id, "执行器 conversation_id");
    check(!/[\s\0]/.test(conversationId), "执行器 conversation_id 不合法");
    check(typeof result.status === "string" && result.status.toUpperCase() === "SUCCESS", "执行器没有报告 SUCCESS");
    return {
        conversationId,
        ...(typeof result.response === "string" && result.response ? { response: result.response } : {}),
    };
}
export const agyExecutor = {
    parseSettings: parseAgySettings,
    invocation(settings, conversationId, runDir, _stdoutPath, prompt) {
        const agy = settings;
        const [exe, ...prefix] = agy.command;
        const sessionLog = join(runDir, "agy.debug.log");
        return {
            exe: text(exe, "执行器命令"),
            argv: [
                ...prefix,
                ...(conversationId ? ["--conversation", conversationId] : ["--new-project"]),
                "--model",
                agy.model,
                "--effort",
                agy.effort,
                "--mode",
                agy.mode,
                ...agy.permissionArgs,
                "--output-format",
                "json",
                "--log-file",
                sessionLog,
                "--print",
                prompt,
            ],
            sessionLog,
        };
    },
    sessionScanner(launch, expected) {
        return sessionLineScanner(launch.sessionLog, matchSessionLine, expected);
    },
    receipt: parseReceipt,
    salvage(stdoutPath) {
        // A failed output can still carry the session identifier needed for recovery.
        // Parse failures propagate so the run record keeps the outputError diagnostic.
        const result = JSON.parse(readFileSync(stdoutPath, "utf8"));
        if (typeof result === "object" &&
            result !== null &&
            "conversation_id" in result &&
            typeof result.conversation_id === "string" &&
            result.conversation_id &&
            !/[\s\0]/.test(result.conversation_id))
            return {
                conversationId: result.conversation_id,
                ...(typeof result.response === "string" && result.response
                    ? { response: result.response }
                    : {}),
            };
        return {};
    },
};
