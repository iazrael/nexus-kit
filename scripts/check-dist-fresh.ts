/**
 * dist 新鲜度门禁（pnpm check 在 pnpm build 之后跑）：packages/*\/dist 入库供 git 依赖直接消费，
 * 源码改了而 dist 没重建提交，消费方装到的就是旧实现。构建后 dist 有未暂存或未跟踪的变化即失败——
 * 流程是「构建 → git add → pnpm check → 提交」，已暂存的 dist 改动随本次提交入库，放行。
 */
import { execFileSync } from "node:child_process";

const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ":(glob)packages/*/dist/**"], {
  encoding: "utf8",
});
// porcelain 第二列 = 工作区相对暂存区的状态；"??" = 未跟踪
const dirty = out.split("\n").filter((line) => line.length > 2 && (line[1] !== " " || line.startsWith("??")));
if (dirty.length > 0) {
  console.error("[dist] packages/*/dist 有未暂存的变化——重建后的 dist 必须 git add 并与源码同提交：\n" + dirty.join("\n"));
  process.exit(1);
}
console.log("[dist] packages/*/dist 与暂存区一致");
