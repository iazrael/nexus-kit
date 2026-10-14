import { check, text, command, number, safePath, json, object, stringList, maxSeconds } from "./validation.js";
import { parseTaskConfig, validateTaskPaths, taskWorktreeName, efforts, modes, minutes } from "./config.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { relative, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
export const states = ["待认领", "执行中", "待验收", "返工", "通过", "中断", "受阻"];
export { check, text, command, number, safePath, inside, json } from "./validation.js";
export function idOf(id) {
    check(typeof id === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) && id.length <= 64, "任务标识须为小写字母、数字和连字符，最长 64 字符");
    return id;
}
export function sha(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function fingerprint(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function config(root) {
    const value = object(json(safePath(root, "nexus.config.json")), "nexus.config.json");
    check(value.task !== undefined, "nexus.config.json 缺少 task 段，请按任务协作接入规范配置");
    const cfg = parseTaskConfig(value.task);
    validateTaskPaths(root, cfg);
    return cfg;
}
export function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
export function taskFile(root, cfg, id) {
    return safePath(root, `${cfg.tasksDir}/${idOf(id)}.md`);
}
export function taskText(root, cfg, id) {
    return readFileSync(taskFile(root, cfg, id), "utf8");
}
export function header(content, name) {
    const lines = content.split("\n").filter((line) => line.startsWith(`> ${name}：`));
    check(lines.length === 1, `任务头部必须有且只有一个 ${name}`);
    return lines[0].slice(name.length + 3).trim();
}
export function setHeader(content, name, value) {
    header(content, name);
    return content
        .split("\n")
        .map((line) => (line.startsWith(`> ${name}：`) ? `> ${name}：${value}` : line))
        .join("\n");
}
export function record(content, message) {
    return content + `\n- ${new Date().toISOString()} ${message}\n`;
}
export function newTask(root, cfg, id, title) {
    idOf(id);
    text(title, "标题");
    check(!/[\r\n]/.test(title), "标题不能含换行");
    const file = taskFile(root, cfg, id);
    check(!existsSync(file), `任务已存在：${id}`);
    const spec = {
        version: 1,
        id,
        branch: `task/${id}`,
        worktree: taskWorktreeName(root, cfg, id),
        goal: "",
        scope: "",
        inputs: [],
        dependencies: [],
        writable: [`${cfg.tasksDir}/${id}.md`],
        verify: [],
        productReviewRequired: false,
    };
    const content = `# ${title}\n\n> 基准：${new Date().toISOString().slice(0, 10)}\n> 状态：待认领\n> 负责人：未认领\n> 开始时间：未开始\n\n## 任务配置\n\n目标、范围、输入、白名单和验证命令在下面填写；空目标或空验证不能派发。模型与预算未指定时使用项目配置。命令是 argv 数组，不经过 shell。验证命令中的 {output} 是工具预先创建的空目录，探针必须接受空目录，不限定父目录，拒绝复用非空旧目录。探索任务可以登记尚未实现的探针，由执行者实现后交付；派发前确定命令接口和通过标准，不预设研究结论。\n\n<!-- task-config -->\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n<!-- /task-config -->\n\n## 执行记录\n\n每阶段登记命令、结果、失败和提交。\n\n## 中断恢复\n\n登记现场路径、最后失败命令和下一步。\n\n## 交付与验收记录\n\n执行者只标待验收；协调者独立验证后填写通过。\n`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { flag: "wx" });
    return { task: relative(root, file), id, status: "待认领" };
}
export function nonce() {
    return `${Date.now()}-${randomUUID()}`;
}
export function readTask(root, cfg, id, complete = true) {
    const content = taskText(root, cfg, id);
    const matches = [...content.matchAll(/<!-- task-config -->\s*```json\n([\s\S]*?)\n```\s*<!-- \/task-config -->/g)];
    check(matches.length === 1, `任务 ${id} 缺少唯一 task-config，旧任务只能查看状态`);
    let raw;
    try {
        raw = JSON.parse(matches[0][1]);
    }
    catch (e) {
        throw new Error(`任务配置 JSON 错误：${String(e)}`, { cause: e });
    }
    const spec = parseSpec(raw, root, cfg, id);
    if (complete) {
        text(spec.goal, "goal");
        text(spec.scope, "scope");
        check(spec.verify.length > 0, "任务必须有验证命令");
    }
    check(states.includes(header(content, "状态")), "非法任务状态");
    // parseSpec has already validated every execution field.
    const effective = structuredClone(cfg);
    const { model, effort, mode, ...timing } = spec.execution ?? {};
    Object.assign(effective, timing);
    Object.assign(effective.agy, { ...(model && { model }), ...(effort && { effort }), ...(mode && { mode }) });
    return { spec, content, status: header(content, "状态"), definition: sha(JSON.stringify(spec)), effective };
}
export function parseSpec(raw, root, cfg, id) {
    const s = object(raw, "任务配置");
    check(s.version === 1 && s.id === idOf(id), "任务 version 或 id 不匹配");
    const branch = text(s.branch, "branch");
    check(!branch.startsWith("-") && !branch.includes("\n"), "非法分支");
    const worktree = text(s.worktree, "worktree");
    check(worktree === taskWorktreeName(root, cfg, id), "工作树必须与任务隔离配置的位置一致");
    const writable = stringList(s.writable, "writable");
    writable.forEach((p) => {
        safePath(root, p);
        check(!p.startsWith(".worktrees") && !p.startsWith(cfg.controlDir), `禁止写入：${p}`);
    });
    check(writable.includes(`${cfg.tasksDir}/${id}.md`), "白名单必须包含自己的任务文件");
    check(Array.isArray(s.inputs), "inputs 必须是数组");
    const inputs = s.inputs.map((value) => {
        const v = object(value, "input");
        const path = text(v.path, "input.path");
        safePath(root, path);
        const sha256 = text(v.sha256, "input.sha256");
        check(/^[a-f0-9]{64}$/.test(sha256), `输入 ${path} 缺少 SHA-256`);
        return { path, sha256, ...(v.source === undefined ? {} : { source: relative(root, safePath(root, text(v.source, "input.source"))) }) };
    });
    check(Array.isArray(s.dependencies), "dependencies 必须是数组");
    const dependencies = s.dependencies.map((value) => {
        const v = object(value, "dependency");
        const dep = idOf(v.id);
        check(dep !== id, "任务不能依赖自身");
        const commit = v.commit === undefined ? undefined : text(v.commit, "dependency.commit");
        check(commit === undefined || /^[a-f0-9]{40}$/.test(commit), "依赖提交必须为完整 SHA");
        return { id: dep, ...(commit === undefined ? {} : { commit }) };
    });
    check(Array.isArray(s.verify), "verify 必须是数组");
    const verify = s.verify.map((value) => {
        const v = object(value, "verify");
        return {
            name: text(v.name, "验证名称"),
            argv: command(v.argv, "验证命令"),
            ...(v.timeoutSeconds === undefined ? {} : { timeoutSeconds: number(v.timeoutSeconds, "验证期限", 0.001, maxSeconds) }),
        };
    });
    check(s.productReviewRequired === undefined || typeof s.productReviewRequired === "boolean", "productReviewRequired 必须是布尔值");
    const spec = {
        version: 1,
        id,
        branch,
        worktree,
        goal: typeof s.goal === "string" ? s.goal : "",
        scope: typeof s.scope === "string" ? s.scope : "",
        writable,
        inputs,
        dependencies,
        verify,
        ...(s.productReviewRequired === undefined ? {} : { productReviewRequired: s.productReviewRequired }),
    };
    if (s.execution !== undefined) {
        const ex = object(s.execution, "execution");
        const execution = {};
        for (const [k, v] of Object.entries(ex)) {
            if (k === "budgetMinutes" || k === "progressMinutes" || k === "hardTimeoutMinutes")
                execution[k] = minutes(v, k);
            else if (k === "model" || k === "mode" || k === "effort")
                execution[k] = text(v, k);
            else
                throw new Error(`未知 execution 字段：${k}`);
        }
        check(execution.effort === undefined || efforts.includes(execution.effort), "execution.effort 不合法");
        check(execution.mode === undefined || modes.includes(execution.mode), "execution.mode 不合法");
        spec.execution = execution;
    }
    return spec;
}
