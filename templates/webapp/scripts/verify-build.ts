/** 构建后门禁（pnpm build 第二步）：PWA 壳、升级链合同、预算。预算是回归闸，调数要和交付说明一起走 */
import { verifyPwaBuild } from "@nexus-kit/vite";
import { APP_ID, APP_NAME, RUNTIME_PARTITIONS } from "../pwa.config.ts";

const report = verifyPwaBuild({
  root: new URL("..", import.meta.url).pathname,
  appId: APP_ID,
  manifestName: APP_NAME,
  runtimePartitions: RUNTIME_PARTITIONS,
  budgets: { precacheKB: 1500, criticalKB: 300 },
});
console.log(
  `[verify-build] v${report.version} build ${report.build}：预缓存 ${report.precacheEntries} 条 ${report.precacheKB}KB，首屏关键路径（压缩后）${report.criticalKB}KB`,
);
