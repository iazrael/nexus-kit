import { openSync, closeSync, fstatSync, writeFileSync, constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "./validation.js";
// This is a diagnostic hint, never permission to execute or evidence of delivery.
const approvalRequest = /(?:请(?:审阅|确认|批准)[^。\n]{0,40}(?:计划|方案)|(?:确认|批准|审批)(?:通过)?后(?:我将|再|开始)|等待[^。\n]{0,20}(?:批准|确认)|(?:please\s+)?(?:approve|confirm|review)\s+(?:the\s+)?(?:plan|proposal)|wait(?:ing)?\s+for\s+(?:your\s+)?approval)/i;
export function recordRunEnd(controlDir, info, response) {
    info.endReason =
        info.state === "completed"
            ? info.taskStatus === "受阻"
                ? "blocked"
                : "delivered"
            : info.state === "interrupted"
                ? "interrupted"
                : "failed";
    if (info.state === "failed" &&
        info.exitCode === 0 &&
        info.error === "执行器结束但任务没有交付或登记受阻" &&
        response !== undefined &&
        approvalRequest.test(response)) {
        info.endReason = "needs_approval";
        info.endMessage = "执行器疑似停在计划确认；协调者核对已批准范围后用 task resume 原会话续跑，不要重建或误作交付";
    }
    try {
        const file = join(controlDir, "notify.log");
        const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        try {
            if (!fstatSync(fd).isFile())
                throw new Error("notify.log 必须是普通文件");
            writeFileSync(fd, JSON.stringify({
                at: info.endedAt,
                id: info.id,
                run: basename(dirname(info.stdout)),
                state: info.state,
                reason: info.endReason,
                message: info.endMessage,
                error: info.error,
                head: info.lastHead,
                exitCode: info.exitCode,
                signal: info.signal,
            }) + "\n");
        }
        finally {
            closeSync(fd);
        }
    }
    catch (error) {
        info.notificationError = errorMessage(error);
        console.error(`[task] 结束流水写入失败：${info.notificationError}`);
    }
}
