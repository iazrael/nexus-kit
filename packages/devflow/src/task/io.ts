import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { nonce } from "./definition.ts";

export function gitOutput(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
export function git(root: string, ...args: string[]) {
  return gitOutput(root, ...args).trim();
}
export function atomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${nonce()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  renameSync(temporary, path);
}
