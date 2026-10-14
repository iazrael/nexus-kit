import { basename, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { check, object, text, command, number, safePath, stringList, maxMinutes } from "./validation.js";
export const efforts = ["low", "medium", "high", "xhigh", "max"];
export const modes = ["accept-edits", "auto", "plan"];
/** hardTimeoutMinutes 0 means no hard limit; the other durations must be positive. */
export function minutes(value, label) {
    return number(value, label, label === "hardTimeoutMinutes" ? 0 : 0.001, maxMinutes);
}
export function parseTaskConfig(value) {
    const cfg = object(value, "task 配置");
    check(cfg.version === 1, "task.version 必须为 1");
    const agy = object(cfg.agy, "task.agy");
    const effort = text(agy.effort, "task.agy.effort");
    const mode = text(agy.mode, "task.agy.mode");
    check(efforts.includes(effort), "agy.effort 不合法");
    check(modes.includes(mode), "agy.mode 不合法");
    const rules = stringList(cfg.rules, "task.rules");
    check(rules.length > 0, "rules 必须列出公共规则");
    const worktreeDir = cfg.worktreeDir === null ? null : text(cfg.worktreeDir ?? ".worktrees", "task.worktreeDir");
    const postCreate = cfg.postCreate ?? [];
    check(Array.isArray(postCreate), "task.postCreate 必须是命令数组");
    return {
        version: 1,
        tasksDir: text(cfg.tasksDir, "task.tasksDir"),
        controlDir: text(cfg.controlDir, "task.controlDir"),
        rules,
        agy: {
            command: command(agy.command, "agy.command"),
            model: text(agy.model, "agy.model"),
            effort,
            mode,
            permissionArgs: stringList(agy.permissionArgs, "agy.permissionArgs"),
        },
        worktreeDir,
        postCreate: postCreate.map((v) => command(v, "task.postCreate")),
        budgetMinutes: minutes(cfg.budgetMinutes, "budgetMinutes"),
        progressMinutes: minutes(cfg.progressMinutes, "progressMinutes"),
        hardTimeoutMinutes: minutes(cfg.hardTimeoutMinutes, "hardTimeoutMinutes"),
    };
}
export function validateTaskPaths(root, cfg) {
    for (const path of [cfg.tasksDir, cfg.controlDir, ...cfg.rules])
        safePath(root, path);
    if (cfg.worktreeDir !== null)
        safePath(root, cfg.worktreeDir);
}
export function mainRootOf(root) {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
    check(common.endsWith("/.git"), "仅支持常规非 bare Git 仓库");
    return dirname(common);
}
export function taskWorktree(mainRoot, cfg, id) {
    return cfg.worktreeDir === null
        ? safePath(dirname(mainRoot), `${basename(mainRoot)}-worktrees/${id}`)
        : safePath(mainRoot, `${cfg.worktreeDir}/${id}`);
}
export function taskWorktreeName(root, cfg, id) {
    const main = mainRootOf(root);
    return relative(main, taskWorktree(main, cfg, id));
}
