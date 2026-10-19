/**
 * install-cli 的判断与落盘：nexus-devflow 全局命令是一条软链，永远指向 kit 主仓库的 dist/cli.js。
 * 判断逻辑是纯函数；真改文件系统的只有 installLink，测试在临时目录里跑。
 */
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

export type Existing = { kind: "missing" } | { kind: "symlink"; target: string } | { kind: "other" };
export type LinkAction = "create" | "keep" | "replace" | "refuse";

export function planLink(existing: Existing, target: string): { action: LinkAction } {
  if (existing.kind === "missing") return { action: "create" };
  if (existing.kind === "other") return { action: "refuse" };
  return { action: existing.target === target ? "keep" : "replace" };
}

export function pathAdvice(
  pathEnv: string,
  binDir: string,
  firstHit: string | null,
  linkPath: string,
): { ok: true } | { ok: false; message: string } {
  const dirs = pathEnv
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => canonical(dir));
  if (!dirs.includes(canonical(binDir)))
    return {
      ok: false,
      message: `${binDir} 不在 PATH 里。把下面这行加进 shell 配置（如 ~/.zshrc），再开新终端：\nexport PATH="${binDir}:$PATH"`,
    };
  if (firstHit !== null && entryPath(firstHit) !== entryPath(linkPath))
    return { ok: false, message: `PATH 里排在前面的 ${firstHit} 遮住了 ${linkPath}；删掉它或调整 PATH 顺序` };
  return { ok: true };
}

/** 目录按真实路径比较：bin 目录本身是软链、或 PATH 写的是它的另一个名字时也能认出。 */
function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(dir);
    throw error;
  }
}
/** 命令项只解析所在目录，不跟随命令本身的软链。 */
function entryPath(path: string): string {
  return join(canonical(dirname(path)), basename(path));
}

/** 和 shell 一样，只认可执行的普通文件；同名目录、无执行位文件、悬空软链都跳过。 */
export function findOnPath(pathEnv: string, name: string): string | null {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 不存在、悬空或不可执行：shell 也会跳过它继续往后找。
    }
  }
  return null;
}

/** lstat 判存在：悬空软链也算占位。 */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function inspect(path: string): Existing {
  if (!exists(path)) return { kind: "missing" };
  return lstatSync(path).isSymbolicLink() ? { kind: "symlink", target: readlinkSync(path) } : { kind: "other" };
}

export function installLink(linkPath: string, target: string): { action: Exclude<LinkAction, "refuse">; previous: string | null } {
  const existing = inspect(linkPath);
  const { action } = planLink(existing, target);
  if (action === "refuse") throw new Error(`${linkPath} 已存在且不是软链，拒绝覆盖；确认无用后自行删除再执行`);
  const previous = existing.kind === "symlink" ? existing.target : null;
  if (action === "keep") return { action, previous };
  mkdirSync(dirname(linkPath), { recursive: true });
  // 先建临时链再 rename 覆盖：任何一步失败，原来能用的软链都还在。
  const temp = `${linkPath}.install-${process.pid}`;
  symlinkSync(target, temp);
  renameSync(temp, linkPath);
  return { action, previous };
}

/** 在工作树里执行也返回主仓库根，否则工作树回收后软链悬空。 */
export function mainRepoRoot(cwd: string): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
  if (!common.endsWith("/.git")) throw new Error(`仅支持常规非 bare 仓库：${common}`);
  return realpathSync(dirname(common));
}

export function cliTarget(mainRoot: string): string {
  const target = join(mainRoot, "packages/devflow/dist/cli.js");
  if (!existsSync(target)) throw new Error(`${target} 不存在；先在 kit 主仓库执行 pnpm build`);
  return target;
}
