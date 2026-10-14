import { check, object, json, text, stringList, command } from "./validation.ts";
import { parseTaskConfig } from "./config.ts";
import { parseSpec } from "./definition.ts";
import type { Snapshot, RunInfo, Verification, Accepted, Review, ReviewItem } from "./types.ts";

function fields(o: Record<string, unknown>, strings: string[], booleans: string[] = []): void {
  for (const k of strings) text(o[k], k);
  for (const k of booleans) check(typeof o[k] === "boolean", `${k} 必须为布尔值`);
}
function nullableText(value: unknown, label: string): void {
  check(value === null || typeof value === "string", `${label} 必须为字符串或 null`);
}
function nullablePid(value: unknown, label: string): void {
  check(value === null || (typeof value === "number" && Number.isInteger(value) && value > 0), `${label} 必须为正整数或 null`);
}
function sha(value: unknown, label: string, size: number): void {
  check(typeof value === "string" && new RegExp(`^[a-f0-9]{${size}}$`).test(value), `${label} 必须为完整指纹`);
}
export function readSnapshot(file: string, root: string): Snapshot {
  const o = object(json(file), "任务快照");
  check(o.version === 2, "任务快照版本不支持；保留旧工具和现场，不自动改写旧定义");
  fields(o, ["base", "sourceRoot", "definition", "configHash", "nexusHash"]);
  sha(o.base, "base", 40);
  sha(o.definition, "definition", 64);
  sha(o.configHash, "configHash", 64);
  sha(o.nexusHash, "nexusHash", 64);
  const cfg = parseTaskConfig(o.config);
  const spec = object(o.spec, "spec");
  parseSpec(spec, root, cfg, text(spec.id, "id"));
  check(Array.isArray(o.rules), "rules 必须为数组");
  for (const rule of o.rules) {
    const r = object(rule, "rule");
    fields(r, ["path", "sha256"]);
    sha(r.sha256, "rule.sha256", 64);
  }
  return o as unknown as Snapshot;
}
export function readRun(file: string): RunInfo {
  const o = object(json(file), "运行记录");
  fields(o, ["id", "state", "startedAt", "sourceRoot", "stdout", "stderr"], ["resume", "budgetReached", "hardTimeout"]);
  check(["starting", "running", "completed", "failed", "interrupted"].includes(text(o.state, "state")), "未知运行状态");
  nullablePid(o.supervisorPid, "supervisorPid");
  nullablePid(o.executorPid, "executorPid");
  nullableText(o.conversationId, "conversationId");
  for (const key of [
    "sessionSource",
    "sessionWarning",
    "progressAt",
    "budgetMessage",
    "lastHead",
    "error",
    "outputError",
    "recordError",
    "reportedConversationId",
    "endedAt",
    "taskStatus",
    "mainWarning",
    "baseWarning",
  ])
    if (o[key] !== undefined) text(o[key], key);
  if (o.exitCode !== undefined)
    check(o.exitCode === null || (typeof o.exitCode === "number" && Number.isInteger(o.exitCode)), "exitCode 不合法");
  if (o.signal !== undefined) nullableText(o.signal, "signal");
  if (o.stopRequested !== undefined) check(typeof o.stopRequested === "boolean", "stopRequested 必须为布尔值");
  return o as unknown as RunInfo;
}
export function readVerification(file: string): Verification {
  const o = object(json(file), "验证材料");
  fields(o, ["id", "startedAt", "definition", "output"], ["passed"]);
  if (o.commit !== undefined) sha(o.commit, "commit", 40);
  for (const key of ["error", "endedAt", "baseWarning"]) if (o[key] !== undefined) text(o[key], key);
  if (o.changed !== undefined) stringList(o.changed, "changed");
  check(Array.isArray(o.commands), "commands 必须为数组");
  for (const value of o.commands) {
    const v = object(value, "验证命令");
    fields(v, ["name", "stdout", "stderr", "stdoutSha256", "stderrSha256"], ["timedOut"]);
    command(v.argv, "argv");
    check(v.exitCode === null || (typeof v.exitCode === "number" && Number.isInteger(v.exitCode)), "验证退出码不合法");
    nullableText(v.signal, "signal");
    nullableText(v.error, "error");
    sha(v.stdoutSha256, "stdoutSha256", 64);
    sha(v.stderrSha256, "stderrSha256", 64);
  }
  if (o.mainAudits !== undefined) {
    check(Array.isArray(o.mainAudits), "mainAudits 必须为数组");
    for (const value of o.mainAudits) {
      const item = object(value, "主仓审计引用");
      text(item.file, "主仓审计文件");
      sha(item.sha256, "主仓审计 sha256", 64);
    }
  }
  if (o.outputs !== undefined) {
    const outputs = object(o.outputs, "outputs");
    for (const v of Object.values(outputs)) sha(v, "output 指纹", 64);
  }
  if (o.passed) {
    check(o.commit !== undefined && o.outputs !== undefined && o.endedAt !== undefined, "通过材料缺少提交、产物或结束时间");
  }
  return o as unknown as Verification;
}
function reviewItem(value: unknown, kind: string): ReviewItem {
  const o = object(value, `独立 ${kind} 审查`);
  fields(o, ["reviewer", "record"], ["passed"]);
  return o as unknown as ReviewItem;
}
export function readReview(file: string): Review {
  const o = object(json(file), "审查记录");
  sha(o.commit, "审查 commit", 40);
  const code = reviewItem(o.code, "code");
  return { commit: text(o.commit, "commit"), code, ...(o.product === undefined ? {} : { product: reviewItem(o.product, "product") }) };
}
export function readAccepted(file: string): Accepted {
  const o = object(json(file), "验收记录");
  fields(o, ["id", "status", "verifiedCommit", "acceptanceCommit", "receipt", "receiptSha256", "reviewSha256", "acceptedAt"]);
  check(o.status === "通过", "验收状态必须为通过");
  if (o.baseWarning !== undefined) text(o.baseWarning, "baseWarning");
  sha(o.verifiedCommit, "verifiedCommit", 40);
  sha(o.acceptanceCommit, "acceptanceCommit", 40);
  sha(o.receiptSha256, "receiptSha256", 64);
  sha(o.reviewSha256, "reviewSha256", 64);
  const r = object(o.review, "review");
  sha(r.commit, "review.commit", 40);
  reviewItem(r.code, "code");
  if (r.product !== undefined) reviewItem(r.product, "product");
  return o as unknown as Accepted;
}
export function readPointer(file: string): { file: string; sha256?: string } {
  const o = object(json(file), "验证索引");
  if (o.sha256 !== undefined) sha(o.sha256, "sha256", 64);
  return { file: text(o.file, "file"), ...(o.sha256 === undefined ? {} : { sha256: text(o.sha256, "sha256") }) };
}
export function readRunPointer(file: string): string {
  const o = object(json(file), "运行索引");
  const d = text(o.directory, "directory");
  check(/^[a-z0-9-]+$/.test(d), "运行目录标识不合法");
  return d;
}
export function readRework(file: string): { defects: string; reproduce: string; criteria: string } {
  const o = object(json(file), "返工说明");
  check(
    Object.keys(o).every((k) => ["defects", "reproduce", "criteria"].includes(k)),
    "返工说明存在未知字段",
  );
  return {
    defects: text(o.defects, "返工说明 defects"),
    reproduce: text(o.reproduce, "返工说明 reproduce"),
    criteria: text(o.criteria, "返工说明 criteria"),
  };
}
