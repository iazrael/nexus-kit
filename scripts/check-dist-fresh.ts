/**
 * dist 新鲜度门禁（pnpm check 在 pnpm build 之后跑）：packages/*\/dist 入库供 git 依赖直接消费，
 * 源码改了而 dist 没重建提交，消费方装到的就是旧实现。构建后 dist 与 git 记录不一致即失败。
 */
import { execFileSync } from "node:child_process";

const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "packages/*/dist"], { encoding: "utf8" }).trim();
if (out !== "") {
  console.error("[dist] packages/*/dist 与提交不一致——源码改动后重建的 dist 必须同提交：\n" + out);
  process.exit(1);
}
console.log("[dist] packages/*/dist 与提交一致");
