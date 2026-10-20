import { check, command, errorCode, object, stringList, text } from "./validation.js";
import { sessionLineScanner } from "./scan.js";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
export function parseOpencodeSettings(value) {
    const raw = object(value, "opencode 执行器配置");
    const model = text(raw.model, "opencode.model");
    check(/^[^\s]+\/[^\s]+$/.test(model), "opencode.model 必须是 厂商/模型 形状，如 opencode/deepseek-v4.1-flash-free");
    return {
        command: command(raw.command, "opencode.command"),
        model,
        permissionArgs: stringList(raw.permissionArgs, "opencode.permissionArgs"),
    };
}
/** Only whole-line JSON events count; the session id must sit on the event itself. */
function eventSession(line) {
    if (!line.startsWith("{"))
        return null;
    try {
        const event = JSON.parse(line);
        if (typeof event === "object" && event !== null) {
            const id = event.sessionID;
            if (typeof id === "string" && id)
                return id;
        }
    }
    catch {
        // 非整行 JSON 的行不是执行器事件。
    }
    return null;
}
function eventText(line) {
    if (!line.startsWith("{"))
        return null;
    try {
        const event = JSON.parse(line);
        if (typeof event !== "object" || event === null)
            return null;
        const part = event.part;
        if (typeof part === "object" &&
            part !== null &&
            part.type === "text" &&
            typeof part.text === "string" &&
            part.text)
            return part.text;
    }
    catch {
        // 非整行 JSON 的行不是执行器事件。
    }
    return null;
}
/** `{"type":"error","error":{"type":"provider.quota","message":"..."}}` — opencode's own failure report. */
function eventFailure(line) {
    if (!line.startsWith("{"))
        return null;
    try {
        const event = JSON.parse(line);
        if (typeof event !== "object" || event === null || event.type !== "error")
            return null;
        const error = event.error;
        if (typeof error !== "object" || error === null)
            return null;
        const { type, message } = error;
        return { type: typeof type === "string" ? type : "unknown", message: typeof message === "string" ? message : "" };
    }
    catch {
        // 非整行 JSON 的行不是执行器事件。
    }
    return null;
}
// Long runs stream their whole transcript; beyond this cap only the tail is
// read, which always contains the final reply.
const maxReceiptBytes = 33_554_432;
function readOutputTail(stdoutPath) {
    try {
        const size = lstatSync(stdoutPath).size;
        const start = size > maxReceiptBytes ? size - maxReceiptBytes : 0;
        const fd = openSync(stdoutPath, "r");
        try {
            const buffer = Buffer.alloc(size - start);
            readSync(fd, buffer, 0, buffer.length, start);
            return buffer.toString("utf8");
        }
        finally {
            closeSync(fd);
        }
    }
    catch (error) {
        // A run that died before writing any output has nothing to read; other read failures must surface.
        if (errorCode(error) === "ENOENT")
            return "";
        throw error;
    }
}
/** `opencode run --format json` streams one JSON event per line; text parts carry the final reply. */
function parseOutput(stdoutPath) {
    const sessionIds = [];
    const texts = [];
    let failure;
    for (const line of readOutputTail(stdoutPath).split("\n")) {
        const trimmed = line.trim();
        const session = eventSession(trimmed);
        if (session)
            sessionIds.push(session);
        const text = eventText(trimmed);
        if (text)
            texts.push(text);
        failure = eventFailure(trimmed) ?? failure;
    }
    return {
        ...(sessionIds.length ? { conversationId: sessionIds[sessionIds.length - 1] } : {}),
        ...(texts.length ? { response: texts.join("\n") } : {}),
        ...(failure ? { failure } : {}),
    };
}
export const opencodeExecutor = {
    parseSettings: parseOpencodeSettings,
    invocation(settings, conversationId, _runDir, stdoutPath, prompt) {
        const [exe, ...prefix] = settings.command;
        return {
            exe: text(exe, "执行器命令"),
            argv: [
                ...prefix,
                "run",
                ...(conversationId ? ["--session", conversationId] : []),
                "--model",
                settings.model,
                ...settings.permissionArgs,
                "--format",
                "json",
                prompt,
            ],
            sessionLog: stdoutPath,
        };
    },
    sessionScanner(launch, expected) {
        return sessionLineScanner(launch.sessionLog, eventSession, expected);
    },
    receipt(stdoutPath) {
        // opencode has no explicit status record; a successful turn is one that
        // streamed events for a session and ended with a reply.
        const parsed = parseOutput(stdoutPath);
        check(parsed.conversationId !== undefined, "执行器最终输出没有会话标识");
        check(parsed.response !== undefined, "执行器最终输出没有回复文本");
        return parsed;
    },
    salvage: parseOutput,
};
