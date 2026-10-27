import { runCloudcli } from "./cloudcli-client.ts";
import { text } from "./validation.ts";

try {
  process.exitCode = await runCloudcli(text(process.argv[2], "CloudCLI 请求文件"));
} catch (error) {
  console.error(`[task] CloudCLI 执行失败：${error instanceof Error ? error.message : "未知错误"}`);
  process.exitCode = 1;
}
