/**
 * 主包加载失败兜底的 ES5 门禁（pnpm check 在 pnpm build 之后跑）：宿主构建时用的是 packages/runtime/dist 里的
 * bootGuardScript，它靠 Function.prototype.toString 取编译后的函数源码拼成内联脚本。单测只校验了源码经 vitest 转换的
 * 结果；这里校验 dist 产物——tsc 版本或 tsconfig 一变，产物可能悄悄带上 ES2017+ 语法，而这段脚本要兜住的恰恰包括
 * 解析不了新语法的旧浏览器。
 */
import { parse } from "espree";
import { bootGuardScript } from "../packages/runtime/dist/boot/index.js";

const script = bootGuardScript({ title: "t", hint: "h", reload: "r", checking: "c", updating: "u" });
try {
  parse(script, { ecmaVersion: 5 });
} catch (error) {
  console.error(`[boot-es5] dist 生成的内联兜底脚本不是 ES5：${String(error)}`);
  process.exit(1);
}
console.log(`[boot-es5] dist 生成的内联兜底脚本是 ES5（${script.length} 字符）`);
