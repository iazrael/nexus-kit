/**
 * 建立或修复 nexus-devflow 全局命令：pnpm install-cli [--bin-dir <目录>]
 *
 * - 软链永远指向 kit 主仓库的 packages/devflow/dist/cli.js，在工作树里执行也一样；
 * - 默认放到 ~/.local/bin；同名软链替换，同名普通文件拒绝；
 * - 目录不在 PATH 里或被前面的同名命令遮住时，打印处理办法并以非零退出；
 * - 最后执行一次 nexus-devflow --help 自检。
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cliTarget, findOnPath, installLink, mainRepoRoot, pathAdvice } from "./install-cli-lib.ts";

const { values } = parseArgs({ options: { "bin-dir": { type: "string" } } });
const binDir = resolve(values["bin-dir"] ?? join(homedir(), ".local/bin"));
const link = join(binDir, "nexus-devflow");

try {
  const target = cliTarget(mainRepoRoot(import.meta.dirname));
  const { action, previous } = installLink(link, target);
  const verb = { create: "已建立", replace: "已替换", keep: "已是最新" }[action];
  console.log(`[install-cli] ${verb}：${link} -> ${target}${action === "replace" ? `（原指向 ${previous}）` : ""}`);
  const selfTest = spawnSync(link, ["--help"], { encoding: "utf8" });
  if (selfTest.status !== 0 || !selfTest.stdout.includes("用法：nexus-devflow")) {
    const restore = action === "replace" ? `\n软链已改动；要恢复原指向：ln -sfn ${JSON.stringify(previous)} ${JSON.stringify(link)}` : "";
    console.error(
      `[install-cli] 自检失败：${link} --help 退出码 ${selfTest.status ?? selfTest.error?.message}\n${selfTest.stderr}${restore}`,
    );
    process.exit(1);
  }
  const pathEnv = process.env.PATH ?? "";
  const advice = pathAdvice(pathEnv, binDir, findOnPath(pathEnv, "nexus-devflow"), link);
  if (!advice.ok) {
    console.error(`[install-cli] ${advice.message}`);
    process.exit(1);
  }
  const viaPath = spawnSync("nexus-devflow", ["--help"], { encoding: "utf8" });
  if (viaPath.status !== 0) {
    console.error(`[install-cli] 经 PATH 执行 nexus-devflow --help 失败：退出码 ${viaPath.status ?? viaPath.error?.message}`);
    process.exit(1);
  }
  console.log("[install-cli] 自检通过：PATH 上的 nexus-devflow 可用");
} catch (error) {
  console.error(`[install-cli] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
