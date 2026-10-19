import { check, text } from "./validation.js";
import { agyExecutor } from "./executor-agy.js";
import { opencodeExecutor } from "./executor-opencode.js";
const registry = { agy: agyExecutor, opencode: opencodeExecutor };
export function executorByName(name) {
    const clean = text(name, "执行器名");
    check(clean in registry, `未知执行器：${clean}；可用执行器：${Object.keys(registry).join("、")}`);
    return registry[clean];
}
export function parseExecutorSettings(name, value) {
    return executorByName(name).parseSettings(value);
}
