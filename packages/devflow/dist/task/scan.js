import { existsSync, openSync, readSync, closeSync, lstatSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { check, errorMessage } from "./validation.js";
/**
 * Incrementally scans an appending log for the session created or resumed by
 * the current invocation. The returned closure is polled while the executor
 * runs; thrown errors carry the ids already identified for failure recovery.
 */
export function sessionLineScanner(path, matchLine, expected) {
    let offset = 0, pending = "", identified = null;
    const decoder = new StringDecoder("utf8");
    return () => {
        if (!existsSync(path))
            return identified;
        const stat = lstatSync(path);
        check(stat.isFile() && !stat.isSymbolicLink(), "执行器会话日志必须为普通文件");
        check(stat.size >= offset, "执行器会话日志被截断，无法确认本次会话");
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
                    const id = matchLine(line.trim());
                    if (!id)
                        continue;
                    check(!expected || id === expected, "会话日志返回了不同会话，保留原会话标识");
                    check(!identified || id === identified, "会话日志报告了多个不同会话");
                    identified = id;
                }
                check(pending.length < 1_048_576, "执行器会话日志单行过长");
            }
        }
        catch (e) {
            throw Object.assign(new Error(errorMessage(e)), { identifiedConversationId: identified });
        }
        finally {
            closeSync(fd);
        }
        return identified;
    };
}
