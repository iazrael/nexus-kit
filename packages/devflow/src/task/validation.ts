import { existsSync, realpathSync, readFileSync, lstatSync } from "node:fs";
import { resolve, relative, dirname, isAbsolute, sep } from "node:path";

export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
export function errorCode(e: unknown): unknown {
  return e instanceof Error && "code" in e ? e.code : undefined;
}
export function object(value: unknown, label: string): Record<string, unknown> {
  check(typeof value === "object" && value !== null && !Array.isArray(value), `${label} 必须为对象`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string): string {
  check(typeof value === "string" && value.trim() !== "" && !value.includes("\0"), `${label} 必须是非空字符串`);
  return value;
}
export function stringList(value: unknown, label: string): string[] {
  check(Array.isArray(value) && value.every((v) => typeof v === "string" && !v.includes("\0")), `${label} 必须是字符串数组`);
  return value as string[];
}
export function command(value: unknown, label: string): string[] {
  const args = stringList(value, label);
  check(args.length > 0, `${label} 必须是非空 argv 数组`);
  args.forEach((v) => text(v, label));
  return args;
}
export function number(value: unknown, label: string, minimum = 0): number {
  check(typeof value === "number" && Number.isFinite(value) && value >= minimum, `${label} 必须是大于等于 ${minimum} 的有限数字`);
  return value;
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export function safePath(root: string, name: string): string {
  check(
    typeof name === "string" &&
      name.length > 0 &&
      !isAbsolute(name) &&
      !name.split(/[\\/]/).some((p) => p === ".." || p === "" || p === ".") &&
      !name.includes("\0"),
    `非法仓库相对路径：${name}`,
  );
  check(!name.split(/[\\/]/).includes(".git"), "禁止访问 Git 管理目录");
  root = realpathSync(root);
  const path = resolve(root, name);
  let parent = path;
  while (!existsSync(parent)) {
    try {
      check(!lstatSync(parent).isSymbolicLink(), `悬空软链：${name}`);
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
    }
    parent = dirname(parent);
  }
  check(inside(root, realpathSync(parent)), `路径越界或软链指向仓库外：${name}`);
  return path;
}
export function json(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw new Error(`读取 JSON 失败：${path}：${errorMessage(e)}`, { cause: e });
  }
}
