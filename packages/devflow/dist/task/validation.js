import { existsSync, realpathSync, readFileSync, lstatSync } from "node:fs";
import { resolve, relative, dirname, isAbsolute, sep } from "node:path";
export function check(ok, message) {
    if (!ok)
        throw new Error(message);
}
export function errorMessage(e) {
    return e instanceof Error ? e.message : String(e);
}
export function errorCode(e) {
    return e instanceof Error && "code" in e ? e.code : undefined;
}
export function object(value, label) {
    check(typeof value === "object" && value !== null && !Array.isArray(value), `${label} 必须为对象`);
    return value;
}
export function text(value, label) {
    check(typeof value === "string" && value.trim() !== "" && !value.includes("\0"), `${label} 必须是非空字符串`);
    return value;
}
export function stringList(value, label) {
    check(Array.isArray(value) && value.every((v) => typeof v === "string" && !v.includes("\0")), `${label} 必须是字符串数组`);
    return value;
}
export function command(value, label) {
    const args = stringList(value, label);
    check(args.length > 0, `${label} 必须是非空 argv 数组`);
    args.forEach((v) => text(v, label));
    return args;
}
export function number(value, label, minimum = 0) {
    check(typeof value === "number" && Number.isFinite(value) && value >= minimum, `${label} 必须是大于等于 ${minimum} 的有限数字`);
    return value;
}
export function inside(root, path) {
    const rel = relative(root, path);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export function safePath(root, name) {
    check(typeof name === "string" &&
        name.length > 0 &&
        !isAbsolute(name) &&
        !name.split(/[\\/]/).some((p) => p === ".." || p === "" || p === ".") &&
        !name.includes("\0"), `非法仓库相对路径：${name}`);
    check(!name.split(/[\\/]/).includes(".git"), "禁止访问 Git 管理目录");
    root = realpathSync(root);
    const path = resolve(root, name);
    let parent = path;
    while (!existsSync(parent)) {
        try {
            check(!lstatSync(parent).isSymbolicLink(), `悬空软链：${name}`);
        }
        catch (e) {
            if (errorCode(e) !== "ENOENT")
                throw e;
        }
        parent = dirname(parent);
    }
    check(inside(root, realpathSync(parent)), `路径越界或软链指向仓库外：${name}`);
    return path;
}
export function json(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch (e) {
        throw new Error(`读取 JSON 失败：${path}：${errorMessage(e)}`, { cause: e });
    }
}
