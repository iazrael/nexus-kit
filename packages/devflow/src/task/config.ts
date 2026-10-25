import { basename, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import type { TaskConfig } from "./types.ts";
import { check, object, text, command, number, safePath, stringList, maxMinutes } from "./validation.ts";
import { parseExecutorSettings } from "./executor.ts";
import { efforts, modes } from "./executor-agy.ts";

export { efforts, modes };
/** hardTimeoutMinutes 0 means no hard limit; the other durations must be positive. */
export function minutes(value: unknown, label: "budgetMinutes" | "progressMinutes" | "hardTimeoutMinutes"): number {
  return number(value, label, label === "hardTimeoutMinutes" ? 0 : 0.001, maxMinutes);
}

export function parseTaskConfig(value: unknown): TaskConfig {
  const cfg = object(value, "task 配置");
  check(cfg.version === 1, "task.version 必须为 1");
  // A config that only has the legacy task.agy section reads as the single agy
  // executor, so snapshots frozen before executors existed keep loading. The
  // public nexus-devflow also still reads task.agy, so a config may carry both
  // shapes; the executors section wins.
  const legacy = cfg.executors === undefined;
  if (legacy && cfg.executor !== undefined)
    throw new Error("task 配置混用新旧形状：写了 executor 却没有 executors 段，请补全 executors 或去掉 executor");
  const executor = legacy ? "agy" : text(cfg.executor, "task.executor");
  const rawExecutors = legacy ? { agy: cfg.agy } : object(cfg.executors, "task.executors");
  const executors: TaskConfig["executors"] = {};
  for (const [name, section] of Object.entries(rawExecutors)) executors[name] = parseExecutorSettings(name, section);
  check(executor in executors, `默认执行器 ${executor} 缺少配置段`);
  const executorEnvDeny = stringList(cfg.executorEnvDeny ?? [], "task.executorEnvDeny");
  check(new Set(executorEnvDeny).size === executorEnvDeny.length, "task.executorEnvDeny 有重复变量名");
  const rules = stringList(cfg.rules, "task.rules");
  check(rules.length > 0, "rules 必须列出公共规则");
  const worktreeDir = cfg.worktreeDir === null ? null : text(cfg.worktreeDir ?? ".worktrees", "task.worktreeDir");
  const postCreate = cfg.postCreate ?? [];
  check(Array.isArray(postCreate), "task.postCreate 必须是命令数组");
  const preflight = cfg.preflight ?? [];
  check(Array.isArray(preflight), "task.preflight 必须是命令数组");
  return {
    version: 1,
    tasksDir: text(cfg.tasksDir, "task.tasksDir"),
    controlDir: text(cfg.controlDir, "task.controlDir"),
    rules,
    executor,
    executors,
    executorEnvDeny,
    worktreeDir,
    postCreate: postCreate.map((v) => command(v, "task.postCreate")),
    budgetMinutes: minutes(cfg.budgetMinutes, "budgetMinutes"),
    progressMinutes: minutes(cfg.progressMinutes, "progressMinutes"),
    hardTimeoutMinutes: minutes(cfg.hardTimeoutMinutes, "hardTimeoutMinutes"),
    ...(preflight.length ? { preflight: preflight.map((v) => command(v, "task.preflight")) } : {}),
  };
}

/**
 * The config exactly as 0.7.0 parsed and hashed it, or null when the config
 * uses anything 0.7.0 could not express (another executor, env deny list, preflight).
 * Lets snapshots frozen before executors existed pass the config check.
 */
export function legacyTaskConfig(cfg: TaskConfig): Record<string, unknown> | null {
  const names = Object.keys(cfg.executors);
  if (cfg.executor !== "agy" || names.length !== 1 || cfg.executorEnvDeny.length || cfg.preflight) return null;
  return {
    version: cfg.version,
    tasksDir: cfg.tasksDir,
    controlDir: cfg.controlDir,
    rules: cfg.rules,
    agy: cfg.executors.agy,
    worktreeDir: cfg.worktreeDir,
    postCreate: cfg.postCreate,
    budgetMinutes: cfg.budgetMinutes,
    progressMinutes: cfg.progressMinutes,
    hardTimeoutMinutes: cfg.hardTimeoutMinutes,
  };
}

export function validateTaskPaths(root: string, cfg: TaskConfig): void {
  for (const path of [cfg.tasksDir, cfg.controlDir, ...cfg.rules]) safePath(root, path);
  if (cfg.worktreeDir !== null) safePath(root, cfg.worktreeDir);
}

export function mainRootOf(root: string): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
  check(common.endsWith("/.git"), "仅支持常规非 bare Git 仓库");
  return dirname(common);
}

export function taskWorktree(mainRoot: string, cfg: TaskConfig, id: string): string {
  return cfg.worktreeDir === null
    ? safePath(dirname(mainRoot), `${basename(mainRoot)}-worktrees/${id}`)
    : safePath(mainRoot, `${cfg.worktreeDir}/${id}`);
}
export function taskWorktreeName(root: string, cfg: TaskConfig, id: string): string {
  const main = mainRootOf(root);
  return relative(main, taskWorktree(main, cfg, id));
}
