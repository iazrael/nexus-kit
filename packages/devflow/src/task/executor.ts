import type { Executor } from "./types.ts";
import { check, text } from "./validation.ts";
import { agyExecutor } from "./executor-agy.ts";
import { opencodeExecutor } from "./executor-opencode.ts";

const registry: Record<string, Executor> = { agy: agyExecutor, opencode: opencodeExecutor };

export function executorByName(name: string): Executor {
  const clean = text(name, "执行器名");
  check(clean in registry, `未知执行器：${clean}；可用执行器：${Object.keys(registry).join("、")}`);
  return registry[clean]!;
}

export function parseExecutorSettings(name: string, value: unknown) {
  return executorByName(name).parseSettings(value);
}
