import { appendFileSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { atomic } from "./io.js";
import { check, object, text } from "./validation.js";
import { parseCloudcliSettings } from "./executor-cloudcli.js";
class CloudcliOperationError extends Error {
}
function request(path) {
    const raw = object(JSON.parse(readFileSync(path, "utf8")), "CloudCLI 请求");
    return {
        settings: parseCloudcliSettings(raw.settings),
        prompt: text(raw.prompt, "提示词"),
        requestId: text(raw.requestId, "requestId"),
        sessionId: raw.sessionId,
        sessionLog: text(raw.sessionLog, "运行记录"),
    };
}
async function connection(settings) {
    const token = text(process.env[settings.tokenEnv], `环境变量 ${settings.tokenEnv}`);
    check(token.length >= 32, "CloudCLI 执行令牌至少需要 32 字符");
    const client = new Client({ name: "nexus-devflow", version: "1.0.0" });
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL(settings.endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }), { timeout: 5000 });
        return client;
    }
    catch (error) {
        await client.close();
        throw error;
    }
}
async function call(client, name, input) {
    const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 5000 });
    if (result.isError) {
        const content = Array.isArray(result.content) ? result.content : [];
        throw new CloudcliOperationError(content.map((entry) => (typeof entry === "object" && entry !== null && "text" in entry ? String(entry.text) : "")).join("\n") ||
            "CloudCLI 操作失败");
    }
    try {
        return object(result.structuredContent, "CloudCLI 工具结果");
    }
    catch (error) {
        throw new CloudcliOperationError(error instanceof Error ? error.message : "CloudCLI 工具结果无效");
    }
}
function argumentsOf(input, cwd) {
    return {
        requestId: input.requestId,
        provider: input.settings.provider,
        model: input.settings.model,
        permissionMode: input.settings.permissionMode,
        prompt: input.prompt,
        cwd,
        ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
    };
}
async function start(client, input) {
    const result = await call(client, typeof input.sessionId === "string" ? "execution_continue" : "execution_start", argumentsOf(input, process.cwd()));
    text(result.runId, "CloudCLI runId");
    text(result.sessionId, "CloudCLI sessionId");
    check(input.sessionId === undefined || result.sessionId === input.sessionId, "CloudCLI 续跑返回了不同的原会话");
    atomic(input.sessionLog, result);
    return result;
}
/** 桥接进程向 stdout 写统一回执，增量事件保存在独立日志。 */
export async function runCloudcli(requestFile) {
    const input = request(requestFile);
    const client = await connection(input.settings);
    try {
        // 请求标识固定在请求文件中；派发应答丢失后，监督进程按同一标识取消。
        let result = await start(client, input);
        let cursor = 0;
        let disconnected = false;
        for (;;) {
            let page;
            try {
                page = await call(client, "execution_get", { runId: result.runId, cursor });
            }
            catch (error) {
                const retryable = error instanceof StreamableHTTPError
                    ? (error.code ?? 0) >= 500 || error.code === 408
                    : error instanceof McpError
                        ? error.code === ErrorCode.RequestTimeout || error.code === ErrorCode.ConnectionClosed
                        : error instanceof TypeError && /fetch failed|network/i.test(error.message);
                if (!retryable)
                    throw error;
                if (!disconnected)
                    process.stderr.write(`CloudCLI 查询失败，等待重新连接：${error instanceof Error ? error.message : "未知错误"}\n`);
                disconnected = true;
                await new Promise((resolve) => setTimeout(resolve, 500));
                continue;
            }
            // 身份、游标或本地持久化出错必须退出并取消，不能当成网络失联无限重试。
            check(page.runId === result.runId && page.sessionId === result.sessionId, "CloudCLI 查询返回了不同运行或会话");
            check(typeof page.cursor === "number" && Number.isSafeInteger(page.cursor) && page.cursor >= cursor, "CloudCLI 输出游标无效");
            check(Array.isArray(page.events), "CloudCLI 事件列表无效");
            for (const event of page.events)
                appendFileSync(`${input.sessionLog}.events.jsonl`, `${JSON.stringify(event)}\n`);
            cursor = page.cursor;
            atomic(input.sessionLog, page);
            result = page;
            disconnected = false;
            if (page.hasMore !== true && ["succeeded", "failed", "cancelled", "interrupted"].includes(String(page.state))) {
                console.log(JSON.stringify(page));
                return page.state === "succeeded" && page.stopConfirmed === true ? 0 : 1;
            }
            await new Promise((resolve) => setTimeout(resolve, result.hasMore === true ? 0 : 500));
        }
    }
    finally {
        await client.close();
    }
}
/** 监督进程在桥接退出后调用；只有服务端确认停止才允许审计和提交中断记录。 */
export async function stopCloudcli(requestFile) {
    const input = request(requestFile);
    const client = await connection(input.settings);
    try {
        // 按请求取消不会启动引擎；服务端为尚未启动的请求保存取消墓碑。
        const deadline = Date.now() + 30_000;
        let confirmed = false;
        do {
            const result = await call(client, "execution_cancel", { requestId: input.requestId });
            check(result.requestId === input.requestId, "CloudCLI 取消返回了不同请求");
            if (typeof input.sessionId === "string" && typeof result.sessionId === "string")
                check(result.sessionId === input.sessionId, "CloudCLI 取消返回了不同原会话");
            if (typeof result.sessionId === "string")
                atomic(input.sessionLog, result);
            confirmed = result.stopConfirmed === true;
            if (!confirmed)
                await new Promise((resolve) => setTimeout(resolve, 500));
        } while (!confirmed && Date.now() < deadline);
        check(confirmed, "CloudCLI 未确认执行停止，保留主仓审计和任务树现场");
    }
    finally {
        await client.close();
    }
}
