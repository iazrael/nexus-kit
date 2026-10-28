import { recordRunEnd } from "./run-end.ts";
import { readNote, indentNote, formatSummary, checkAcceptance, clearSelfChecks } from "./deliver.ts";
import { git, atomic } from "./io.ts";
import type {
  ExecutorFailure,
  ExecutorLaunch,
  TaskContext,
  Snapshot,
  TaskSpec,
  LaunchResult,
  RunOptions,
  RunInfo,
  CommandExit,
  Verification,
  Accepted,
  TaskStatus,
  VerificationStatus,
  AcceptanceStatus,
} from "./types.ts";
import type { ChildProcess } from "node:child_process";
import { loadNexusConfig, loadNexusConfigAt } from "../config/config.ts";
import { worktreeNew } from "../worktree/worktree.ts";
import { systemProcessProbe } from "../worktree/worktree-procs.ts";
import { legacyTaskConfig, taskWorktree } from "./config.ts";
import {
  assertMainClean,
  beginMainAudit,
  finishMainAudit,
  reviewMainAudits,
  assertMainAuditsReviewed,
  mainAuditManifest,
  mainAuditWarnings,
} from "./main-audit.ts";
import { errorMessage, errorCode, printable, checkFingerprint } from "./validation.ts";
import { readSnapshot, readRun, readVerification, readAccepted, readReview, readPointer, readRunPointer, readRework } from "./records.ts";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { executorByName } from "./executor.ts";
import type { Executor } from "./types.ts";
import {
  existsSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  cpSync,
  openSync,
  closeSync,
  chmodSync,
  lstatSync,
  copyFileSync,
  constants,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  check,
  config,
  safePath,
  readTask,
  taskFile,
  header,
  setHeader,
  record,
  sha,
  fingerprint,
  nonce,
  text,
  inside,
} from "./definition.ts";

function toolCli(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../cli.ts" : "../cli.js", import.meta.url));
}

export { git } from "./io.ts";
export function context(cwd = process.cwd()): TaskContext {
  const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
  const common = realpathSync(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  check(common.endsWith("/.git"), "本批仅支持常规非 bare Git 仓库");
  return { root, mainRoot: dirname(common), cfg: config(root), backend: loadNexusConfig(root).worktree };
}
function inputFile(ctx: TaskContext, path: string) {
  return safePath(ctx.root, relative(ctx.root, realpathSync(resolve(ctx.root, path))));
}
function control(ctx: TaskContext, id: string) {
  return safePath(ctx.mainRoot, `${ctx.cfg.controlDir}/${id}`);
}
function snapshotPath(ctx: TaskContext, id: string) {
  return join(control(ctx, id), "definition.json");
}
function loadSnapshot(ctx: TaskContext, id: string) {
  const file = snapshotPath(ctx, id);
  check(existsSync(file), "缺少派发或建树记录");
  return readSnapshot(file, ctx.root);
}
function worktree(ctx: TaskContext, snap: Snapshot) {
  return taskWorktree(ctx.mainRoot, snap.config, snap.spec.id);
}
// -z avoids core.quotepath escaping of non-ASCII names; literal pathspecs keep * and [ as plain characters.
function tracked(root: string, path: string) {
  return execFileSync("git", ["--literal-pathspecs", "ls-files", "-z", "--", path], { cwd: root, encoding: "utf8" })
    .split("\0")
    .includes(path);
}
function inHead(root: string, path: string) {
  return spawnSync("git", ["cat-file", "-e", `HEAD:${path}`], { cwd: root }).status === 0;
}
function assertCommitted(root: string, paths: string[]) {
  for (const path of paths) {
    check(tracked(root, path), `输入或任务未提交：${path}`);
    check(git(root, "--literal-pathspecs", "status", "--porcelain", "--", path) === "", `输入或任务有未提交改动：${path}`);
  }
}
function checkInputs(root: string, spec: TaskSpec, source = false) {
  for (const input of spec.inputs) {
    const file = safePath(root, source ? (input.source ?? input.path) : input.path);
    check(existsSync(file), `缺少输入：${input.path}`);
    checkFingerprint(input.sha256, fingerprint(file), `输入指纹不符：${input.path}`);
  }
}
function checkDefinition(ctx: TaskContext, snap: Snapshot, root: string) {
  const task = readTask(root, ctx.cfg, snap.spec.id);
  checkFingerprint(snap.definition, task.definition, "任务定义已变化，需要重新派发或重新确认");
  checkFingerprint(snap.nexusHash, fingerprint(safePath(root, "nexus.config.json")), "工作树后端配置已变化，旧派发记录失效");
  const current = config(root),
    legacy = legacyTaskConfig(current),
    configHash = sha(JSON.stringify(current));
  if (legacy === null || snap.configHash !== sha(JSON.stringify(legacy)))
    checkFingerprint(snap.configHash, configHash, "项目配置已变化，旧派发记录失效");
  for (const rule of snap.rules) checkFingerprint(rule.sha256, fingerprint(safePath(root, rule.path)), `公共规则已变化：${rule.path}`);
  return task;
}
function launchStatusError(status: string, id: string, action: string): string {
  const message = `状态 ${status} 不能${action}`;
  return status === "待验收"
    ? `${message}；需要返工时，先执行 task rework ${id} --message-file <JSON 路径>，JSON 填写 defects、reproduce、criteria；登记后再执行 task resume ${id}。交付和基准都无需调整时继续 verify 和独立审查，再 accept`
    : message;
}
function prepare(ctx: TaskContext, id: string, refresh = false): Snapshot {
  const task = readTask(ctx.root, ctx.cfg, id);
  check(["待认领", "返工", "中断", "受阻", "执行中"].includes(task.status), launchStatusError(task.status, id, "派发或建树"));
  assertCommitted(ctx.root, [`${ctx.cfg.tasksDir}/${id}.md`, "nexus.config.json", ...ctx.cfg.rules]);
  checkInputs(ctx.root, task.spec, true);
  // start copies untracked inputs into the task tree; unless ignored they dirty it and verify can never pass.
  for (const input of task.spec.inputs) {
    // The task tree is built from HEAD, so a staged-only input is copied in just like an untracked one.
    if (inHead(ctx.root, input.path)) continue;
    const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", input.path], { cwd: ctx.root }).status === 0;
    check(ignored, `输入 ${input.path} 既未提交也未被 Git 忽略；复制进任务树后会成为未提交改动，先把它加入 .gitignore`);
  }
  for (const dep of task.spec.dependencies) {
    const path = join(control(ctx, dep.id), "accepted.json");
    check(existsSync(path), `前置任务未通过：${dep.id}`);
    const accepted = checkedAcceptance(ctx, dep.id),
      wt = taskWorktree(ctx.mainRoot, ctx.cfg, dep.id);
    if (existsSync(wt)) {
      assertClean(wt);
      check(
        git(wt, "rev-parse", "HEAD") === accepted.acceptanceCommit && git(wt, "status", "--porcelain") === "",
        `前置任务版本变化或存在未提交内容：${dep.id}`,
      );
    } else
      check(
        spawnSync("git", ["merge-base", "--is-ancestor", accepted.acceptanceCommit, "HEAD"], { cwd: ctx.mainRoot }).status === 0,
        `前置验收提交尚未集成：${dep.id}`,
      );
    check(!dep.commit || dep.commit === accepted.verifiedCommit, `前置提交不符：${dep.id}`);
  }
  // The control directory must be ignored, otherwise launch metadata dirties main.
  const probe = relative(ctx.mainRoot, join(control(ctx, id), "definition.json"));
  const ignored = spawnSync("git", ["check-ignore", "--quiet", probe], { cwd: ctx.mainRoot });
  check(ignored.status === 0, `控制目录必须先由 Git 忽略：${ctx.cfg.controlDir}`);
  const snap: Snapshot = {
    version: 2,
    base: git(ctx.root, "rev-parse", "HEAD"),
    sourceRoot: ctx.root,
    spec: task.spec,
    definition: task.definition,
    config: task.effective,
    configHash: sha(JSON.stringify(ctx.cfg)),
    nexusHash: fingerprint(safePath(ctx.root, "nexus.config.json")),
    rules: ctx.cfg.rules.map((path) => ({ path, sha256: fingerprint(safePath(ctx.root, path)) })),
  };
  if (existsSync(snapshotPath(ctx, id))) {
    const old = loadSnapshot(ctx, id);
    if (refresh) {
      const oldTree = worktree(ctx, old);
      if (!existsSync(oldTree)) {
        // The executor failed before task start built the tree: nothing has been
        // done yet, so the main repo may re-confirm (e.g. switch model) and re-dispatch.
        const branchExists =
          spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${old.spec.branch}`], { cwd: ctx.mainRoot }).status === 0;
        check(
          task.status === "待认领" && !branchExists && ctx.root === ctx.mainRoot,
          `原任务工作树 ${printable(oldTree)} 不存在${branchExists ? `，分支 ${old.spec.branch} 仍在` : ""}；重新确认必须在原任务工作树执行，现场缺失时保留记录交协调者处理`,
        );
        check(old.spec.branch === snap.spec.branch && old.spec.worktree === snap.spec.worktree, "重新确认不能更换任务分支或工作树");
        return snap;
      }
      check(realpathSync(ctx.root) === realpathSync(oldTree), "重新确认必须在原任务工作树执行");
      check(["返工", "中断", "受阻", "执行中"].includes(task.status), "当前状态不能重新确认");
      check(old.spec.branch === snap.spec.branch && old.spec.worktree === snap.spec.worktree, "重新确认不能更换任务分支或工作树");
      const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", old.base, "HEAD"], { cwd: ctx.root });
      snap.base = ancestor.status === 0 ? old.base : git(ctx.mainRoot, "rev-parse", "HEAD");
      check(
        spawnSync("git", ["merge-base", "--is-ancestor", snap.base, "HEAD"], { cwd: ctx.root }).status === 0,
        "变基后必须先对齐主仓基准",
      );
      return snap;
    }
    checkDefinition(ctx, old, existsSync(worktree(ctx, old)) ? worktree(ctx, old) : ctx.root);
    checkFingerprint(old.definition, snap.definition, "旧任务定义不同，保留现场并由协调者处理");
    return old;
  }
  return snap;
}
function commitTask(ctx: TaskContext, snap: Snapshot, wt: string, content: string, message: string) {
  const rel = `${ctx.cfg.tasksDir}/${snap.spec.id}.md`;
  writeFileSync(taskFile(wt, ctx.cfg, snap.spec.id), content);
  git(wt, "add", "--", rel);
  git(wt, "commit", "-m", message, "--", rel);
}
/** Removes a lock whose recorded holder has exited; locks without a holder record are left for the operator. */
function reclaimStaleLock(path: string): boolean {
  const holder = join(path, "pid");
  if (!existsSync(holder)) return false;
  const recorded = readFileSync(holder, "utf8").trim(),
    pid = Number(recorded);
  if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) return false;
  const grave = `${path}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, grave);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return false;
    throw e;
  }
  if (!existsSync(join(grave, "pid")) || readFileSync(join(grave, "pid"), "utf8").trim() !== recorded) {
    renameSync(grave, path);
    return false;
  }
  process.stderr.write(`[task] 回收残锁：登记进程 ${pid} 已退出：${path}\n`);
  rmSync(grave, { recursive: true, force: true });
  return true;
}
function lock<T>(ctx: TaskContext, id: string, fn: () => T): T {
  const path = join(control(ctx, id), "operation.lock");
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(path);
      break;
    } catch (e) {
      if (errorCode(e) === "EEXIST" && attempt === 0 && reclaimStaleLock(path)) continue;
      if (errorCode(e) === "EEXIST")
        throw new Error(`任务操作正在进行或留有残锁，拒绝重复操作：${path}；确认没有该任务的 task 进程在运行后，删除这个目录再重试`, {
          cause: e,
        });
      throw e;
    }
  }
  writeFileSync(join(path, "pid"), String(process.pid));
  let result;
  try {
    result = fn();
  } catch (e) {
    rmSync(path, { recursive: true });
    throw e;
  }
  if (result instanceof Promise) return result.finally(() => rmSync(path, { recursive: true })) as T;
  rmSync(path, { recursive: true });
  return result;
}
export function start(ctx: TaskContext, id: string, owner: string) {
  text(owner, "负责人");
  check(!/[\r\n]/.test(owner), "负责人不能含换行");
  return lock(ctx, id, () => {
    const snap = existsSync(snapshotPath(ctx, id)) ? loadSnapshot(ctx, id) : prepare(ctx, id);
    const wt = worktree(ctx, snap);
    if (existsSync(wt)) {
      check(git(wt, "rev-parse", "--show-toplevel") === realpathSync(wt), "目录不是独立工作树");
      check(git(wt, "branch", "--show-current") === snap.spec.branch, "已有工作树分支不符");
      checkDefinition(ctx, snap, wt);
      checkInputs(wt, snap.spec);
      check(
        spawnSync("git", ["merge-base", "--is-ancestor", snap.base, "HEAD"], { cwd: wt }).status === 0,
        "旧工作树不是固定起点的后续版本",
      );
      if (!existsSync(snapshotPath(ctx, id))) atomic(snapshotPath(ctx, id), snap);
      const current = readTask(wt, ctx.cfg, id);
      if (["待认领", "中断", "返工", "受阻"].includes(current.status))
        commitTask(
          ctx,
          snap,
          wt,
          record(setHeader(setHeader(current.content, "状态", "执行中"), "负责人", owner), "恢复原工作树继续执行"),
          `续跑：${id}`,
        );
      return { id, worktree: wt, base: snap.base, head: git(wt, "rev-parse", "HEAD"), restored: true };
    }
    checkDefinition(ctx, snap, snap.sourceRoot);
    checkInputs(snap.sourceRoot, snap.spec, true);
    // nexus-devflow computes directory from the branch basename.
    check(snap.spec.branch.split("/").at(-1) === id, "分支末段必须与任务标识一致");
    const created = worktreeNew(
      {
        cwd: snap.sourceRoot,
        config: { ...ctx.backend, dir: snap.config.worktreeDir, share: [], postCreate: snap.config.postCreate },
        loadConfig: (dir) => loadNexusConfigAt(dir).worktree,
        procs: systemProcessProbe(),
        log: (message) => process.stderr.write(`[task] ${message}\n`),
        run: (cmd, args, cwd) => {
          execFileSync(cmd, args, { cwd, stdio: ["ignore", 2, 2] });
        },
      },
      { branch: snap.spec.branch, from: snap.base },
    );
    check(realpathSync(created.root) === realpathSync(wt), "后端建树位置与任务不符");
    check(existsSync(wt), "后端建树位置与任务不符");
    check(git(wt, "rev-parse", "HEAD") === snap.base && git(wt, "branch", "--show-current") === snap.spec.branch, "后端建树版本不符");
    for (const input of snap.spec.inputs) {
      const dest = safePath(wt, input.path);
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(safePath(snap.sourceRoot, input.source ?? input.path), dest, { errorOnExist: true, force: false });
      }
    }
    for (const input of snap.spec.inputs) chmodSync(safePath(wt, input.path), 0o444);
    checkInputs(wt, snap.spec);
    atomic(snapshotPath(ctx, id), snap);
    const task = checkDefinition(ctx, snap, wt);
    let content = setHeader(setHeader(setHeader(task.content, "状态", "执行中"), "负责人", owner), "开始时间", new Date().toISOString());
    content = record(content, `认领；起始提交 ${snap.base}，分支 ${snap.spec.branch}，工作树 ${snap.spec.worktree}`);
    commitTask(ctx, snap, wt, content, `认领：${id}`);
    return { id, worktree: wt, base: snap.base, head: git(wt, "rev-parse", "HEAD"), restored: false };
  });
}
export function status(ctx: TaskContext, id?: string) {
  const dir = safePath(ctx.root, ctx.cfg.tasksDir);
  const files = id
    ? [`${id}.md`]
    : readdirSync(dir).filter((p) => p.endsWith(".md") && !ctx.cfg.rules.includes(`${ctx.cfg.tasksDir}/${p}`));
  const tasks: TaskStatus[] = files.map((file) => {
    try {
      return taskStatus(ctx, file);
    } catch (e) {
      // One broken task must not hide the others.
      return { id: file.slice(0, -3), task: `${ctx.cfg.tasksDir}/${file}`, legacy: false, status: "未知", error: errorMessage(e) };
    }
  });
  return { tasks };
}
function taskStatus(ctx: TaskContext, file: string): TaskStatus {
  const content = readFileSync(safePath(ctx.root, `${ctx.cfg.tasksDir}/${file}`), "utf8");
  const match = content.match(/<!-- task-config -->\s*```json\n([\s\S]*?)\n```/);
  if (!match)
    return {
      task: `${ctx.cfg.tasksDir}/${file}`,
      legacy: true,
      status: content.match(/^> 状态：(.+)$/m)?.[1] ?? "未登记",
      note: "主仓历史状态，未读取旧工作树；旧任务只读，不支持派发",
    };
  const key = file.slice(0, -3),
    task = readTask(ctx.root, ctx.cfg, key, false);
  const wt = taskWorktree(ctx.mainRoot, ctx.cfg, key),
    hasTree = existsSync(wt);
  let current = task.status,
    head: string | null = null;
  if (hasTree) {
    check(git(wt, "branch", "--show-current") === task.spec.branch, `工作树分支不符：${key}`);
    current = header(readFileSync(taskFile(wt, ctx.cfg, key), "utf8"), "状态");
    head = git(wt, "rev-parse", "HEAD");
  }
  return {
    id: key,
    task: `${ctx.cfg.tasksDir}/${file}`,
    status: current,
    worktree: wt,
    treeExists: hasTree,
    head,
    legacy: false,
    run: runInfo(ctx, key),
    verification: verificationInfo(ctx, key, head),
    acceptance: acceptanceInfo(ctx, key, head),
  };
}
function verificationInfo(ctx: TaskContext, id: string, head: string | null): VerificationStatus | null {
  const pointer = join(control(ctx, id), "latest-verify.json");
  if (!existsSync(pointer)) return null;
  try {
    const latest = readPointer(pointer),
      file = safePath(ctx.mainRoot, relative(ctx.mainRoot, latest.file)),
      receipt = readVerification(file);
    if (latest.sha256) checkFingerprint(latest.sha256, fingerprint(file), `验证材料指纹变化：${file}`);
    if (receipt.passed) assertReceiptIntegrity(ctx, receipt);
    let matchesHead = receipt.commit === head;
    const acceptedFile = join(control(ctx, id), "accepted.json");
    if (!matchesHead && existsSync(acceptedFile)) {
      const accepted = readAccepted(acceptedFile);
      matchesHead = accepted.acceptanceCommit === head && accepted.verifiedCommit === receipt.commit;
    }
    return { passed: receipt.passed, commit: receipt.commit, matchesHead, endedAt: receipt.endedAt ?? null };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

function assertReceiptIntegrity(ctx: TaskContext, receipt: Verification): void {
  check(receipt.passed, "正式验收引用的独立验证未通过");
  for (const audit of receipt.mainAudits ?? []) {
    checkFingerprint(
      audit.sha256,
      fingerprint(safePath(ctx.mainRoot, relative(ctx.mainRoot, audit.file))),
      `主仓审计或核对记录指纹变化：${audit.file}`,
    );
  }
  const output = safePath(ctx.mainRoot, relative(ctx.mainRoot, receipt.output));
  const actualOutputs = outputManifest(output),
    expectedOutputs = receipt.outputs ?? {};
  check(JSON.stringify(Object.keys(actualOutputs)) === JSON.stringify(Object.keys(expectedOutputs)), "独立复跑产物文件清单变化");
  for (const [path, expected] of Object.entries(expectedOutputs))
    checkFingerprint(expected, actualOutputs[path]!, `独立复跑产物指纹变化：${path}`);
  check(receipt.commands.length > 0 && receipt.commands.every((cmd) => cmd.exitCode === 0 && !cmd.timedOut), "验证命令记录不完整或失败");
  for (const cmd of receipt.commands) {
    for (const [path, expected] of [
      [cmd.stdout, cmd.stdoutSha256],
      [cmd.stderr, cmd.stderrSha256],
    ] as const)
      checkFingerprint(expected, fingerprint(safePath(ctx.mainRoot, relative(ctx.mainRoot, path))), `独立验证日志指纹变化：${path}`);
  }
}
function checkedAcceptance(ctx: TaskContext, id: string): Accepted {
  const accepted = readAccepted(join(control(ctx, id), "accepted.json"));
  check(accepted.id === id, "正式验收任务不匹配");
  const file = safePath(ctx.mainRoot, relative(ctx.mainRoot, accepted.receipt));
  checkFingerprint(accepted.receiptSha256, fingerprint(file), `正式验收材料指纹变化：${file}`);
  const receipt = readVerification(file);
  check(receipt.commit === accepted.verifiedCommit && receipt.id === id, "正式验收引用不匹配");
  check(accepted.review.commit === accepted.verifiedCommit && accepted.review.code.passed, "正式验收审查不匹配");
  assertReceiptIntegrity(ctx, receipt);
  return accepted;
}

function acceptanceInfo(ctx: TaskContext, id: string, head: string | null): AcceptanceStatus | null {
  const file = join(control(ctx, id), "accepted.json");
  if (!existsSync(file)) return null;
  try {
    const accepted = checkedAcceptance(ctx, id);
    const integrated =
      spawnSync("git", ["merge-base", "--is-ancestor", accepted.acceptanceCommit, "HEAD"], { cwd: ctx.mainRoot }).status === 0;
    return {
      verifiedCommit: accepted.verifiedCommit,
      acceptanceCommit: accepted.acceptanceCommit,
      acceptedAt: accepted.acceptedAt,
      passed: true,
      integrated,
      matchesHead: head === accepted.acceptanceCommit,
    };
  } catch (e) {
    return {
      verifiedCommit: "",
      acceptanceCommit: "",
      acceptedAt: "",
      passed: false,
      integrated: false,
      matchesHead: false,
      error: errorMessage(e),
    };
  }
}

export function shortStatus(result: { tasks: TaskStatus[] }) {
  const clean = printable;
  return result.tasks
    .map((t) => {
      if (t.legacy) return `${clean(t.task)}\t${clean(t.status)}\t历史（主仓快照）\t-\t验证=-`;
      if (t.error) return `${clean(t.id)}\t错误：${clean(t.error)}`;
      const v = t.verification,
        label = !v
          ? "-"
          : v.error
            ? "材料错误"
            : !v.endedAt
              ? "进行中"
              : !v.passed && !v.commit
                ? "失败"
                : !t.head
                  ? "无法对账"
                  : !v.matchesHead
                    ? "过期"
                    : v.passed
                      ? "通过"
                      : "失败";
      return `${clean(t.id)}\t${clean(t.status)}${t.treeExists ? "" : "（调用树记录，树缺失）"}\t${clean(t.run?.state ?? "未派发")}${t.run?.executionState === "waiting_approval" ? `（等待审批；CloudCLI 会话 ${clean(t.run.conversationId)}）` : ""}${t.run?.mainWarning ? "（主仓新提交）" : ""}${t.run?.endReason ? `（${clean(t.run.endReason)}）` : ""}\t${t.head?.slice(0, 8) ?? "-"}\t验证=${label}\t验收=${!t.acceptance ? "-" : t.acceptance.error ? "材料错误" : t.acceptance.matchesHead ? "通过" : t.acceptance.integrated ? "已集成（历史）" : "通过（历史，当前无法对账）"}`;
    })
    .join("\n");
}
function alive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (errorCode(e) === "ESRCH") return false;
    if (errorCode(e) === "EPERM") return true;
    throw e;
  }
}
function groupAlive(pid: number | null | undefined) {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && alive(-pid);
}
function latestRun(ctx: TaskContext, id: string) {
  const pointer = join(control(ctx, id), "latest.json");
  if (!existsSync(pointer)) return null;
  const directory = readRunPointer(pointer);
  const file = safePath(ctx.mainRoot, `${ctx.cfg.controlDir}/${id}/runs/${directory}/run.json`);
  return { file, data: readRun(file), directory };
}
/** A record still marked running whose supervisor is gone reads as interrupted; the file itself is left untouched. */
export function settleRun(info: RunInfo): RunInfo {
  if (
    ["starting", "running"].includes(info.state) &&
    !alive(info.supervisorPid) &&
    (info.supervisorPid || Date.now() - Date.parse(info.startedAt) > 10_000)
  )
    return { ...info, state: "interrupted", error: "监督进程已退出，原记录没有收尾；核对现场后恢复" };
  return info;
}
function runInfo(ctx: TaskContext, id: string) {
  const run = latestRun(ctx, id);
  return run ? settleRun(run.data) : null;
}
function noRunning(ctx: TaskContext, id: string) {
  const info = runInfo(ctx, id);
  check(
    !info || (!["starting", "running"].includes(info.state) && !groupAlive(info.executorPid)),
    "任务正在运行，拒绝重复派发、续跑或验收",
  );
}
/** The executor's last reported error, sanitized and capped; it may not be the root cause. */
function executorFailureNote(id: string, failure: ExecutorFailure): string {
  const chars = Array.from(printable(`${failure.type}：${failure.message}`).trim());
  const note = `；执行器最后一条报错 ${chars.length > 300 ? `${chars.slice(0, 300).join("")}…` : chars.join("")}`;
  return failure.type === "provider.quota"
    ? `${note}；等额度恢复或换模型：已建树在任务树执行 task resume ${id} --refresh-definition --model <模型>，建树前失败在主仓执行 task dispatch ${id} --refresh-definition --model <模型>`
    : note;
}
function promptFor(ctx: TaskContext, snap: Snapshot, resume: boolean) {
  const id = snap.spec.id,
    tool = `${JSON.stringify(process.execPath)} ${JSON.stringify(toolCli())} task`;
  return `${resume ? "继续原会话与原工作树，不重建现场。上次若停在计划确认，直接按已批准范围续跑。" : "执行已分配的独立任务。"}\n任务：${ctx.cfg.tasksDir}/${id}.md\n起始提交：${snap.base}\n工作树：${worktree(ctx, snap)}\n目标：${snap.spec.goal}\n先读任务文件和公共规则 ${ctx.cfg.rules.join("、")}，再执行 ${tool} start ${id} --owner ${snap.config.executor} 自建或恢复工作树（工具启动目录：${snap.sourceRoot}）。\n派发表示已批准任务文件列出的范围：范围内直接实施，不要结束回合等待重复批准；需要扩范围、改验收目标或新增未授权动作时，保存证据交回协调者。\n预算 ${snap.config.budgetMinutes} 分钟是进度检查节点，不是硬期限。\n交付：按验收清单逐条自验，在「自验结果」列写「通过：证据」或「不适用：理由」并提交，再在工作树内执行 ${tool} deliver ${id} --summary-file <工作树外的摘要文件>（三行：改了什么、验证如何、还有什么）；它会复跑验证命令、追加交付摘要并标待验收。做不到时执行 ${tool} block ${id} --reason-file <工作树外的文件> 登记受阻。最终回复给交付 SHA 并复述交付摘要。`;
}
function baseRecovery(ctx: TaskContext, snap: Snapshot): string {
  return `保留原任务工作树 ${printable(worktree(ctx, snap))}；待验收任务先用 task rework ${snap.spec.id} --message-file <JSON 路径> 登记基准改写原因、复现命令和通过标准。再逐文件核对并完成变基或重放交付，在原树提交后用 task resume ${snap.spec.id} --refresh-definition 重新确认基准并交付，随后重新 verify、独立审查和 accept。仅刷新定义不能修复历史`;
}
function warnBase(ctx: TaskContext, snap: Snapshot): string | undefined {
  const mainHead = git(ctx.mainRoot, "rev-parse", "HEAD");
  const result = spawnSync("git", ["merge-base", "--is-ancestor", snap.base, mainHead], { cwd: ctx.mainRoot, encoding: "utf8" });
  check(result.status === 0 || result.status === 1, `无法核对任务固定起点：${result.error?.message ?? result.stderr}`);
  if (result.status === 0) return undefined;
  const warning = `固定起点 ${snap.base} 已不是主仓 HEAD ${mainHead} 的祖先；集成可能出现 add/add 冲突。${baseRecovery(ctx, snap)}`;
  process.stderr.write(`[task] ${warning}\n`);
  return warning;
}
function modelOverride(snap: Snapshot, model: string) {
  const name = snap.config.executor;
  const previous = snap.config.executors[name];
  check(previous !== undefined, `缺少执行器配置段：${name}`);
  const settings = structuredClone(previous);
  settings.model = text(model, "模型 --model");
  return { name, settings: executorByName(name).parseSettings(settings) };
}
/**
 * Runs the host's preflight checks in the repository dispatch was called from
 * (normally main); any failure refuses the dispatch before a snapshot exists.
 */
function preflight(ctx: TaskContext, id: string) {
  const checks = ctx.cfg.preflight;
  if (!checks) return undefined;
  const file = taskFile(ctx.root, ctx.cfg, id);
  return checks.map((argv) => {
    const result = spawnSync(argv[0]!, argv.slice(1), {
      cwd: ctx.root,
      env: { ...process.env, TASK_ID: id, TASK_FILE: file },
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) {
      const output = Array.from(`${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
      const shown = output.length > 2000 ? `…${output.slice(-2000).join("")}` : output.join("");
      throw new Error(
        `派发预检失败：${JSON.stringify(argv)}；${result.error ? `错误 ${result.error.message}` : `退出码 ${result.status ?? "无"}，信号 ${result.signal ?? "无"}`}；输出：${printable(shown)}；修好后再派发`,
      );
    }
    return { argv, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  });
}
export async function dispatch(ctx: TaskContext, id: string, options: RunOptions = {}) {
  if (options.dryRun) {
    const snap = prepare(ctx, id, options.refreshDefinition),
      checks = preflight(ctx, id),
      baseWarning = warnBase(ctx, snap);
    const executor = snap.config.executor;
    if (options.model !== undefined) modelOverride(snap, options.model);
    return {
      id,
      base: snap.base,
      prompt: promptFor(ctx, snap, false),
      dryRun: true,
      executor,
      model: options.model ?? snap.config.executors[executor]!.model,
      ...(checks ? { preflight: checks } : {}),
      ...(baseWarning ? { baseWarning } : {}),
    };
  }
  const run = launch(ctx, id, false, options);
  return options.detach ? run : { ...(await waitForRun(ctx, run)), ...(run.preflight ? { preflight: run.preflight } : {}) };
}
export async function resume(ctx: TaskContext, id: string, options: RunOptions = {}) {
  const run = launch(ctx, id, true, options);
  return options.detach ? run : waitForRun(ctx, run);
}
async function waitForRun(ctx: TaskContext, run: LaunchResult) {
  const file = safePath(ctx.mainRoot, relative(ctx.mainRoot, join(run.runDir, "run.json")));
  let cancelled = 0;
  const interrupt = () => {
      cancelled = 130;
    },
    terminate = () => {
      cancelled = 143;
    };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  process.stderr.write(`[task] 等待任务 ${run.id}；运行目录 ${run.runDir}；取消等待不会终止执行器\n`);
  try {
    while (true) {
      const info = readRun(file);
      if (cancelled) return { ...info, runDir: run.runDir, waitingCancelled: true, commandExitCode: cancelled };
      if (info.endedAt && ["completed", "failed", "interrupted"].includes(info.state)) {
        const commandExitCode = info.state === "completed" ? (info.taskStatus === "受阻" ? 3 : 0) : 1;
        if (info.endMessage) process.stderr.write(`[task] ${info.endMessage}\n`);
        if (info.notificationError) process.stderr.write(`[task] 结束流水写入失败：${info.notificationError}\n`);
        if (commandExitCode) process.stderr.write(`[task] ${info.error ?? "任务受阻"}；运行目录 ${run.runDir}\n`);
        if (info.mainWarning) process.stderr.write(`[task] ${info.mainWarning}\n`);
        const executor = executorByName(run.executor);
        return {
          ...info,
          runDir: run.runDir,
          commandExitCode,
          ...(info.state === "completed" ? { result: executor.receipt(info.stdout) } : {}),
        };
      }
      const pid = info.supervisorPid ?? run.supervisorPid;
      if (!alive(pid))
        return { ...info, state: "interrupted", error: "监督进程异常退出，核对现场后恢复", runDir: run.runDir, commandExitCode: 1 };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
function launch(ctx: TaskContext, id: string, resuming: boolean, options: RunOptions): LaunchResult {
  return lock(ctx, id, () => {
    noRunning(ctx, id);
    assertMainClean(ctx.mainRoot);
    const snap = options.refreshDefinition ? prepare(ctx, id, true) : resuming ? loadSnapshot(ctx, id) : prepare(ctx, id);
    const hadSnapshot = existsSync(snapshotPath(ctx, id));
    if (options.model !== undefined) {
      const { name, settings } = modelOverride(snap, options.model);
      check(
        !hadSnapshot || options.refreshDefinition || settings.model === snap.config.executors[name]!.model,
        `派发快照已固定模型 ${snap.config.executors[name]!.model}；换模型加 --refresh-definition 重新确认`,
      );
      snap.config.executors[name] = settings;
    }
    const wt = worktree(ctx, snap);
    const task = checkDefinition(ctx, snap, existsSync(wt) ? wt : snap.sourceRoot);
    const previous = latestRun(ctx, id);
    const conversationId = resuming ? (options.conversation ?? previous?.data.conversationId ?? null) : null;
    if (resuming && task.status !== "待验收") {
      text(conversationId, "恢复会话 conversation_id");
      check(!/[\s\0]/.test(text(conversationId, "会话标识")), "非法会话标识");
      check(existsSync(wt), "原工作树缺失，不创建替代现场");
    }
    check(
      resuming
        ? ["返工", "中断", "受阻", "执行中"].includes(task.status)
        : ["待认领", "执行中", "中断", "受阻", "返工"].includes(task.status),
      launchStatusError(task.status, id, "启动"),
    );
    const checks = resuming ? undefined : preflight(ctx, id);
    const baseWarning = warnBase(ctx, snap);
    const definitionFile = snapshotPath(ctx, id);
    if (options.refreshDefinition && existsSync(definitionFile)) {
      // Archive the original bytes; loadSnapshot normalizes legacy configs.
      loadSnapshot(ctx, id);
      const archive = join(control(ctx, id), "definitions");
      mkdirSync(archive, { recursive: true });
      copyFileSync(definitionFile, join(archive, `${nonce()}.json`), constants.COPYFILE_EXCL);
      atomic(definitionFile, snap);
    } else if (!existsSync(definitionFile)) atomic(definitionFile, snap);
    const directory = nonce(),
      runDir = join(control(ctx, id), "runs", directory);
    mkdirSync(runDir, { recursive: true });
    const info: RunInfo = {
      id,
      state: "starting",
      startedAt: new Date().toISOString(),
      supervisorPid: null,
      executorPid: null,
      executor: snap.config.executor,
      conversationId,
      resume: resuming,
      sourceRoot: snap.sourceRoot,
      stdout: join(runDir, "stdout.json"),
      stderr: join(runDir, "stderr.log"),
      budgetReached: false,
      hardTimeout: false,
      ...(baseWarning ? { baseWarning } : {}),
    };
    const mainAudit = beginMainAudit(ctx.mainRoot, control(ctx, id), resuming ? "resume" : "dispatch");
    atomic(join(runDir, "main-audit.json"), { file: mainAudit });
    atomic(join(runDir, "run.json"), info);
    atomic(join(control(ctx, id), "latest.json"), { directory });
    writeFileSync(join(runDir, "prompt.txt"), promptFor(ctx, snap, resuming), { flag: "wx" });
    const runnerLog = openSync(join(runDir, "supervisor.log"), "wx");
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [toolCli(), "task", "_supervise", id, "--run-dir", directory], {
        cwd: snap.sourceRoot,
        detached: true,
        stdio: ["ignore", runnerLog, runnerLog],
        env: { ...process.env },
      });
      check(typeof child.pid === "number" && Number.isInteger(child.pid), "无法启动监督进程");
      child.unref();
    } finally {
      closeSync(runnerLog);
    }
    return {
      id,
      state: "starting",
      supervisorPid: child.pid,
      executor: snap.config.executor,
      conversationId,
      runDir,
      resume: resuming,
      ...(checks ? { preflight: checks } : {}),
      ...(baseWarning ? { baseWarning } : {}),
    };
  });
}
function markInterrupted(ctx: TaskContext, snap: Snapshot, message: string) {
  const wt = worktree(ctx, snap);
  if (!existsSync(wt)) return;
  const task = readTask(wt, ctx.cfg, snap.spec.id);
  if (["执行中", "待认领"].includes(task.status))
    commitTask(ctx, snap, wt, record(setHeader(task.content, "状态", "中断"), message), `记录中断：${snap.spec.id}`);
}
export async function supervise(ctx: TaskContext, id: string, directory: string) {
  const runDir = safePath(ctx.mainRoot, `${ctx.cfg.controlDir}/${id}/runs/${directory}`),
    file = join(runDir, "run.json");
  const info = readRun(file),
    snap = loadSnapshot(ctx, id);
  info.supervisorPid = process.pid;
  const save = () => atomic(file, info);
  let child: ChildProcess | undefined,
    budget: NodeJS.Timeout | undefined,
    progress: NodeJS.Timeout | undefined,
    hard: NodeJS.Timeout | undefined,
    sessionTimer: NodeJS.Timeout | undefined,
    termination: Promise<void> | undefined,
    cleanupError: unknown,
    interruption: string | undefined,
    out: number | undefined,
    err: number | undefined,
    sessionError: unknown,
    endResponse: string | undefined;
  let executorLaunch: ExecutorLaunch | undefined;
  let executor: Executor | undefined, readSession: (() => string | null) | undefined;
  const pollSession = () => {
    let id;
    try {
      const progress = executorLaunch ? executor?.progress?.(executorLaunch) : null;
      id = progress?.conversationId ?? readSession!();
      if (progress && (info.executionState !== progress.state || info.executionRunId !== progress.runId)) {
        info.executionState = progress.state;
        info.executionRunId = progress.runId;
        save();
      }
    } catch (e) {
      if (!info.conversationId && e instanceof Error && "identifiedConversationId" in e && typeof e.identifiedConversationId === "string") {
        info.conversationId = e.identifiedConversationId;
        info.sessionSource = "startup-log";
        save();
      }
      throw e;
    }
    if (id && info.resume) check(id === info.conversationId, "执行器返回了不同的原会话");
    if (id && (info.conversationId !== id || info.sessionSource !== "startup-log")) {
      info.conversationId = id;
      info.sessionSource = "startup-log";
      save();
    }
  };
  const terminate = () => {
    if (termination) return;
    termination = (async () => {
      if (child?.pid) await stopGroup(child.pid);
      if (executor?.stop && executorLaunch) await executor.stop(executorLaunch);
    })().catch((error) => {
      cleanupError = error;
    });
  };
  const guarded = (callback: () => void) => () => {
    try {
      callback();
    } catch (e) {
      sessionError ??= e;
      terminate();
    }
  };
  const stop = () => {
    info.stopRequested = true;
    terminate();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    checkDefinition(ctx, snap, snap.sourceRoot);
    executor = executorByName(snap.config.executor);
    const executorSettings = snap.config.executors[snap.config.executor];
    check(executorSettings !== undefined, `快照缺少执行器配置段：${snap.config.executor}`);
    executorLaunch = executor.invocation(
      executorSettings,
      info.resume ? text(info.conversationId, "conversationId") : null,
      runDir,
      info.stdout,
      readFileSync(join(runDir, "prompt.txt"), "utf8"),
    );
    readSession = executor.sessionScanner(executorLaunch, info.resume ? info.conversationId : null);
    out = openSync(info.stdout, "wx");
    err = openSync(info.stderr, "wx");
    // Grants exported in the coordinator shell belong to the coordinator, not to an executor launched from that shell.
    const inherited = { ...process.env };
    for (const name of snap.config.executorEnvDeny) delete inherited[name];
    child = spawn(text(executorLaunch.exe, "执行器命令"), executorLaunch.argv, {
      cwd: snap.sourceRoot,
      detached: true,
      stdio: ["ignore", out, err],
      env: { ...inherited, TASK_ID: id, TASK_ROOT: snap.sourceRoot, TASK_TOOL_CLI: toolCli() },
    });
    info.executorPid = child.pid ?? null;
    info.state = "running";
    save();
    sessionTimer = setInterval(guarded(pollSession), 100);
    budget = setTimeout(
      guarded(() => {
        info.budgetReached = true;
        info.budgetMessage = "预算到点；现场和进程保留，协调者检查阶段进度";
        save();
      }),
      snap.config.budgetMinutes * 60_000,
    );
    progress = setInterval(
      guarded(() => {
        const wt = worktree(ctx, snap);
        info.progressAt = new Date().toISOString();
        if (existsSync(wt)) info.lastHead = git(wt, "rev-parse", "HEAD");
        save();
      }),
      snap.config.progressMinutes * 60_000,
    );
    if (snap.config.hardTimeoutMinutes > 0)
      hard = setTimeout(
        guarded(() => {
          info.hardTimeout = true;
          terminate();
          save();
        }),
        snap.config.hardTimeoutMinutes * 60_000,
      );
    const exit = await new Promise<CommandExit>((resolve) => {
      child!.once("error", (error) => resolve({ exitCode: null, signal: null, error: error.message }));
      child!.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    Object.assign(info, exit);
    if (sessionError) throw sessionError;
    pollSession();
    check(!exit.error, `执行器启动失败：${exit.error}`);
    check(exit.exitCode === 0 && !info.hardTimeout, `执行器退出码 ${exit.exitCode}，信号 ${exit.signal ?? "无"}`);
    const receipt = executor!.receipt(info.stdout);
    if (info.conversationId) check(receipt.conversationId === info.conversationId, "最终输出返回了不同会话，拒绝替换原会话");
    info.conversationId = receipt.conversationId;
    info.sessionSource ??= "final-json";
    endResponse = receipt.response;
    if (!readSession!()) info.sessionWarning = "未识别会话日志格式；本次使用最终输出登记";
    const wt = worktree(ctx, snap);
    check(existsSync(wt), "执行器结束但任务树缺失");
    info.taskStatus = readTask(wt, ctx.cfg, id).status;
    check(["待验收", "受阻"].includes(info.taskStatus), "执行器结束但任务没有交付或登记受阻");
    info.lastHead = git(wt, "rev-parse", "HEAD");
    info.state = "completed";
  } catch (e) {
    info.state = info.hardTimeout || info.stopRequested ? "interrupted" : "failed";
    info.error = errorMessage(e);
    // A failed output can still carry the session identifier needed for recovery.
    if (executor && existsSync(info.stdout)) {
      try {
        const salvaged = executor.salvage(info.stdout);
        if (salvaged.conversationId) {
          info.reportedConversationId = salvaged.conversationId;
          if (!info.resume && !info.conversationId) info.conversationId = salvaged.conversationId;
        }
        endResponse = salvaged.response;
        // Only a non-zero exit gets the executor's own report: exit-0 failures keep their exact
        // message, which the plan-stop classification matches on.
        if (salvaged.failure && typeof info.exitCode === "number" && info.exitCode !== 0)
          info.error += executorFailureNote(id, salvaged.failure);
      } catch (salvageError) {
        info.outputError = errorMessage(salvageError);
      }
    }
    interruption = `执行中断：${errorMessage(e)}；日志 ${relative(ctx.mainRoot, runDir)}`;
    process.exitCode = 1;
  } finally {
    clearTimeout(budget);
    clearInterval(progress);
    clearTimeout(hard);
    clearInterval(sessionTimer);
    if (groupAlive(child?.pid) || (executor?.stop && executorLaunch)) terminate();
    await termination;
    if (cleanupError) {
      info.state = "failed";
      info.error = `执行器后代收尾失败：${errorMessage(cleanupError)}`;
      process.exitCode = 1;
    }
    // Record only after descendants are gone, otherwise they can still race on the task tree.
    if (interruption && cleanupError) info.recordError = "执行器后代未能收尾，未写中断记录，避免与残留进程抢写任务树";
    else if (interruption)
      try {
        markInterrupted(ctx, snap, interruption);
      } catch (recordError) {
        info.recordError = errorMessage(recordError);
      }
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (out !== undefined) closeSync(out);
    if (err !== undefined) closeSync(err);
    try {
      check(!cleanupError, "执行器未确认停止，主仓审计保持未完成");
      const auditFile = readPointer(join(runDir, "main-audit.json")).file;
      check(dirname(auditFile) === join(control(ctx, id), "main-audit"), "主仓审计路径不匹配");
      try {
        const warning = finishMainAudit(ctx.mainRoot, auditFile, true);
        if (warning) info.mainWarning = warning;
      } finally {
        if (existsSync(auditFile)) atomic(join(runDir, "main-audit.json"), { file: auditFile, sha256: fingerprint(auditFile) });
      }
    } catch (auditError) {
      info.state = "failed";
      info.error = [info.error, errorMessage(auditError)].filter(Boolean).join("；");
      process.exitCode = 1;
    }
    info.endedAt = new Date().toISOString();
    recordRunEnd(control(ctx, id), info, endResponse);
    save();
  }
  return info;
}
function assertClean(wt: string) {
  const flags = execFileSync("git", ["ls-files", "-v", "-z"], { cwd: wt, encoding: "utf8" }).split("\0").filter(Boolean);
  check(!flags.some((entry) => /^[a-zS]/.test(entry)), "Git 索引存在忽略工作副本的标记，先取消 assume-unchanged 或 skip-worktree");
  check(git(wt, "status", "--porcelain") === "", "工作树有未提交或暂存内容，不能验证、验收或登记返工");
}
function delivery(ctx: TaskContext, snap: Snapshot, expected = "待验收") {
  const wt = worktree(ctx, snap);
  check(existsSync(wt), "交付工作树缺失");
  check(git(wt, "branch", "--show-current") === snap.spec.branch, "交付分支不符");
  const task = checkDefinition(ctx, snap, wt);
  check(
    task.status === expected,
    expected === "待验收" ? "任务必须处于待验收" : `状态 ${task.status} 不能交付；deliver 和 block 只用于执行中的任务`,
  );
  assertClean(wt);
  checkInputs(wt, snap.spec);
  const commit = git(wt, "rev-parse", "HEAD");
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", snap.base, commit], { cwd: wt });
  check(ancestor.status === 0, `交付提交不是固定起点的后续版本，先确认变基后的任务基准；${baseRecovery(ctx, snap)}`);
  // --name-status -z without renames yields alternating "status\0path\0" records.
  const records = execFileSync("git", ["diff", "--no-renames", "--name-status", "-z", `${snap.base}..${commit}`], {
    cwd: wt,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const changed: string[] = [],
    deleted = new Set<string>();
  for (let i = 0; i + 1 < records.length; i += 2) {
    const status = records[i]!,
      path = records[i + 1]!;
    changed.push(path);
    if (status === "D") deleted.add(path);
  }
  const deletable = snap.spec.deletable ?? [];
  const forbidden = changed.filter((path) => (deleted.has(path) ? !deletable.includes(path) : !snap.spec.writable.includes(path)));
  if (forbidden.length) {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const range = `${snap.base}..${commit}`;
    const details = forbidden.map((path) => {
      const commits = git(wt, "log", "--full-history", "--no-renames", "--format=%H", range, "--", path);
      const reason = deleted.has(path)
        ? `删除未授权：${JSON.stringify(path)}；可写白名单不授权删除，确需删除时列入任务配置 deletable`
        : `改动超出白名单：${JSON.stringify(path)}`;
      return `${reason}；相关提交：${commits.split("\n").join("、")}；查看：git -C ${quote(wt)} log --full-history --no-renames --oneline ${quote(range)} -- ${quote(path)}`;
    });
    throw new Error(details.join("\n"));
  }
  for (const path of snap.spec.writable) safePath(wt, path);
  return { wt, task, commit, changed };
}
/** Runs the registered verify commands, each in its own empty directory under output; audit adds main-repo audits. */
async function runChecks(
  ctx: TaskContext,
  snap: Snapshot,
  wt: string,
  commit: string,
  output: string,
  file: string,
  result: Verification,
  audit: boolean,
) {
  for (const [index, entry] of snap.spec.verify.entries()) {
    const commandOutput = join(output, String(index));
    mkdirSync(commandOutput);
    const argv = entry.argv.map((arg) => arg.replaceAll("{output}", commandOutput));
    const stdout = join(output, `${index}.stdout.log`),
      stderr = join(output, `${index}.stderr.log`);
    const mainAudit = audit ? beginMainAudit(ctx.mainRoot, control(ctx, snap.spec.id), `verify:${entry.name}`) : undefined;
    const out = openSync(stdout, "wx"),
      err = openSync(stderr, "wx");
    let run;
    try {
      run = await runCommand(
        argv,
        wt,
        { ...process.env, TASK_VERIFY_OUTPUT: commandOutput },
        out,
        err,
        (entry.timeoutSeconds ?? 300) * 1000,
      );
    } catch (runError) {
      try {
        if (mainAudit) finishMainAudit(ctx.mainRoot, mainAudit);
      } catch (auditError) {
        throw new Error(`${errorMessage(runError)}；${errorMessage(auditError)}`, { cause: auditError });
      }
      throw runError;
    } finally {
      closeSync(out);
      closeSync(err);
    }
    result.commands.push({
      name: entry.name,
      argv,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      stdout,
      stderr,
      stdoutSha256: fingerprint(stdout),
      stderrSha256: fingerprint(stderr),
      error: run.error ?? null,
    });
    atomic(file, result);
    if (mainAudit) finishMainAudit(ctx.mainRoot, mainAudit);
    check(
      run.exitCode === 0 && !run.timedOut && !run.cancelled,
      `验证命令失败：${entry.name}；${run.timedOut ? "期限已到（超时）" : run.cancelled ? "协调者中断" : "退出码 " + run.exitCode}；错误 ${run.error ?? readFileSync(stderr, "utf8")}；记录 ${file}`,
    );
    check(git(wt, "rev-parse", "HEAD") === commit, "验证命令改变了交付提交");
    check(git(wt, "status", "--porcelain") === "", "验证命令修改了受跟踪文件或生成未提交文件");
    checkInputs(wt, snap.spec);
  }
}
export async function verify(ctx: TaskContext, id: string, mainReview?: string) {
  return lock(ctx, id, async () => {
    noRunning(ctx, id);
    const snap = loadSnapshot(ctx, id),
      directory = nonce(),
      output = join(control(ctx, id), "verifications", directory);
    mkdirSync(output, { recursive: true });
    const file = join(output, "result.json"),
      result: Verification = { id, passed: false, startedAt: new Date().toISOString(), definition: snap.definition, commands: [], output };
    atomic(file, result);
    atomic(join(control(ctx, id), "latest-verify.json"), { file });
    try {
      assertMainClean(ctx.mainRoot);
      const { wt, commit, changed } = delivery(ctx, snap);
      if (mainReview) reviewMainAudits(control(ctx, id), inputFile(ctx, mainReview));
      assertMainAuditsReviewed(control(ctx, id));
      result.commit = commit;
      result.changed = changed;
      const baseWarning = warnBase(ctx, snap);
      if (baseWarning) result.baseWarning = baseWarning;
      await runChecks(ctx, snap, wt, commit, output, file, result, true);
      result.mainAudits = mainAuditManifest(control(ctx, id));
      result.outputs = outputManifest(output);
      result.passed = true;
    } catch (e) {
      result.error = errorMessage(e);
      throw new Error(`${errorMessage(e)}；验证材料 ${file}`, { cause: e });
    } finally {
      result.endedAt = new Date().toISOString();
      atomic(file, result);
      atomic(join(control(ctx, id), "latest-verify.json"), { file, sha256: fingerprint(file) });
    }
    return { ...result, receipt: file };
  });
}
/**
 * Executor-side delivery gate: committed work inside the whitelist, every
 * acceptance row self-checked, the registered verify commands passing in a
 * fresh directory. Only then the summary is appended and the task marked 待验收.
 */
export async function deliver(ctx: TaskContext, id: string, summaryPath: string) {
  return lock(ctx, id, async () => {
    const snap = loadSnapshot(ctx, id),
      wt = worktree(ctx, snap);
    check(existsSync(wt), "交付工作树缺失");
    const summary = readNote(summaryPath, wt, "交付摘要");
    const { task, commit } = delivery(ctx, snap, "执行中");
    const rows = checkAcceptance(task.content);
    const formatted = formatSummary(summary);
    const output = join(control(ctx, id), "self-checks", nonce());
    mkdirSync(output, { recursive: true });
    const file = join(output, "result.json"),
      result: Verification = {
        id,
        passed: false,
        startedAt: new Date().toISOString(),
        definition: snap.definition,
        commands: [],
        output,
        commit,
      };
    try {
      await runChecks(ctx, snap, wt, commit, output, file, result, false);
      result.outputs = outputManifest(output);
      result.passed = true;
    } catch (e) {
      result.error = errorMessage(e);
      throw new Error(`${errorMessage(e)}；自验材料 ${file}；修好后再交付，做不到就用 task block 登记受阻`, { cause: e });
    } finally {
      result.endedAt = new Date().toISOString();
      atomic(file, result);
    }
    const receipt = relative(ctx.mainRoot, file);
    const content = record(
      setHeader(task.content, "状态", "待验收"),
      `交付摘要（验收清单 ${rows} 条已自验；自验 ${result.commands.length} 条命令通过：${receipt}；被自验提交 ${commit}）\n${indentNote(formatted)}`,
    );
    commitTask(ctx, snap, wt, content, `交付：${id}`);
    return { id, status: "待验收", commit: git(wt, "rev-parse", "HEAD"), verifiedCommit: commit, selfCheck: file, summary: formatted };
  });
}
/**
 * Executor-side block: records the reason and status 受阻, committing only the
 * task file. It runs exactly when work cannot be finished, so it does not
 * demand a clean tree or a whitelist-clean diff; uncommitted paths are listed.
 */
export function block(ctx: TaskContext, id: string, reasonPath: string) {
  return lock(ctx, id, () => {
    const snap = loadSnapshot(ctx, id),
      wt = worktree(ctx, snap);
    check(existsSync(wt), "任务工作树缺失");
    check(git(wt, "branch", "--show-current") === snap.spec.branch, "任务分支不符");
    const reason = readNote(reasonPath, wt, "受阻原因");
    const task = checkDefinition(ctx, snap, wt);
    check(task.status === "执行中", `状态 ${task.status} 不能登记受阻；block 只用于执行中的任务`);
    const rel = `${ctx.cfg.tasksDir}/${id}.md`;
    const uncommitted = execFileSync("git", ["status", "--porcelain", "--no-renames", "-z", "--untracked-files=all"], {
      cwd: wt,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3))
      .filter((path) => path !== rel);
    const note = uncommitted.length ? `${reason}\n未提交现场：${uncommitted.join("、")}` : reason;
    commitTask(ctx, snap, wt, record(setHeader(task.content, "状态", "受阻"), `受阻\n${indentNote(note)}`), `受阻：${id}`);
    return { id, status: "受阻", commit: git(wt, "rev-parse", "HEAD"), uncommitted };
  });
}
export function rework(ctx: TaskContext, id: string, messagePath: string) {
  text(messagePath, "返工说明 --message-file");
  const message = readRework(inputFile(ctx, messagePath));
  return lock(ctx, id, () => {
    noRunning(ctx, id);
    const snap = loadSnapshot(ctx, id),
      wt = worktree(ctx, snap);
    check(existsSync(wt), "原工作树缺失，不能登记返工");
    check(git(wt, "branch", "--show-current") === snap.spec.branch, "工作树分支不符");
    const task = checkDefinition(ctx, snap, wt);
    check(["待验收", "受阻", "中断"].includes(task.status), `状态 ${task.status} 不能登记返工`);
    assertClean(wt);
    const content = record(
      setHeader(clearSelfChecks(task.content), "状态", "返工"),
      `返工要求\n\n~~~json\n${JSON.stringify(message, null, 2)}\n~~~`,
    );
    commitTask(ctx, snap, wt, content, `返工：${id}`);
    return { id, status: "返工", commit: git(wt, "rev-parse", "HEAD"), worktree: wt };
  });
}
export function accept(ctx: TaskContext, id: string, reviewPath: string) {
  text(reviewPath, "独立审查记录 --review");
  return lock(ctx, id, () => {
    noRunning(ctx, id);
    assertMainClean(ctx.mainRoot);
    assertMainAuditsReviewed(control(ctx, id));
    const snap = loadSnapshot(ctx, id),
      { wt, task, commit } = delivery(ctx, snap);
    const baseWarning = warnBase(ctx, snap);
    const pointer = join(control(ctx, id), "latest-verify.json");
    check(existsSync(pointer), "缺少独立验证材料");
    const latest = readPointer(pointer),
      file = latest.file;
    const receiptFile = safePath(ctx.mainRoot, relative(ctx.mainRoot, file));
    checkFingerprint(text(latest.sha256, "验证材料 SHA-256"), fingerprint(receiptFile), `验证材料指纹变化：${receiptFile}`);
    const receipt = readVerification(receiptFile);
    check(receipt.passed === true && receipt.id === id, "独立验证未通过或材料不匹配");
    checkFingerprint(snap.definition, receipt.definition, "独立验证定义不匹配，必须重新验证");
    check(receipt.commit === commit, "交付提交已变化，必须重新验证");
    assertReceiptIntegrity(ctx, receipt);
    check(receipt.commands.length === snap.spec.verify.length, "验证命令记录不完整或失败");
    const reviewFile = inputFile(ctx, reviewPath);
    const review = readReview(reviewFile);
    check(review.commit === commit, "审查记录提交不匹配");
    for (const kind of ["code", ...(snap.spec.productReviewRequired === true ? ["product" as const] : [])] as const) {
      check(review[kind]?.passed === true, `缺少通过的独立 ${kind} 审查`);
      text(review[kind]!.reviewer, `${kind} 审查者`);
      text(review[kind]!.record, `${kind} 审查依据`);
    }
    commitTask(
      ctx,
      snap,
      wt,
      record(
        setHeader(task.content, "状态", "通过"),
        `协调者验收通过；被验收提交 ${commit}；验证记录 ${relative(ctx.mainRoot, receiptFile)}；审查 SHA-256 ${fingerprint(reviewFile)}`,
      ),
      `验收：${id}`,
    );
    const accepted: Accepted = {
      id,
      status: "通过",
      verifiedCommit: commit,
      acceptanceCommit: git(wt, "rev-parse", "HEAD"),
      receipt: receiptFile,
      receiptSha256: fingerprint(receiptFile),
      review,
      reviewSha256: fingerprint(reviewFile),
      acceptedAt: new Date().toISOString(),
      ...(baseWarning ? { baseWarning } : {}),
    };
    atomic(join(control(ctx, id), "accepted.json"), accepted);
    const mainWarnings = mainAuditWarnings(control(ctx, id));
    for (const warning of mainWarnings) process.stderr.write(`[task] ${warning}\n`);
    return { ...accepted, mainWarnings };
  });
}

function outputManifest(output: string) {
  check(!lstatSync(output).isSymbolicLink(), "验证输出根目录不能是软链");
  const root = realpathSync(output),
    files: Record<string, string> = {};
  for (const dir of readdirSync(output)
    .filter((p) => /^\d+$/.test(p))
    .sort()) {
    const walk = (path: string): void => {
      check(!lstatSync(path).isSymbolicLink() && inside(root, realpathSync(path)), "验证输出目录不能是软链或越界");
      for (const name of readdirSync(path).sort()) {
        const file = join(path, name),
          stat = lstatSync(file);
        check(!stat.isSymbolicLink(), "验证产物不能包含软链");
        if (stat.isDirectory()) walk(file);
        else {
          check(stat.isFile(), "验证产物必须是普通文件");
          files[relative(output, file)] = fingerprint(file);
        }
      }
    };
    walk(join(output, dir));
  }
  return files;
}

async function stopGroup(pid: number | undefined) {
  if (!groupAlive(pid)) return;
  process.kill(-pid!, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (groupAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (groupAlive(pid)) process.kill(-pid!, "SIGKILL");
  const killedDeadline = Date.now() + 1000;
  while (groupAlive(pid) && Date.now() < killedDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  check(!groupAlive(pid), "执行器进程组仍存在，拒绝释放任务");
}
async function runCommand(argv: string[], cwd: string, env: NodeJS.ProcessEnv, out: number, err: number, timeout: number) {
  const child = spawn(text(argv[0], "验证命令"), argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", out, err] });
  let stopping: Promise<void> | undefined,
    timedOut = false,
    cancelled = false;
  const terminate = () => {
    stopping ??= stopGroup(child.pid);
  };
  const stop = () => {
    cancelled = true;
    terminate();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeout);
  let result: CommandExit;
  try {
    result = await new Promise<CommandExit>((resolve) => {
      child!.once("error", (error) => resolve({ exitCode: null, signal: null, error: error.message }));
      child!.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
  } finally {
    clearTimeout(timer);
    if (groupAlive(child.pid)) terminate();
    await stopping;
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
  return { ...result, timedOut, cancelled };
}
