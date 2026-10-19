import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
const cli = fileURLToPath(new URL("../packages/devflow/dist/cli.js", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "task-watch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = spawnSync("git", ["init", "-b", "main"], { cwd: root });
  assert.equal(init.status, 0);
  writeFileSync(join(root, "rules.md"), "# rules");
  mkdirSync(join(root, "jobs"));
  writeFileSync(
    join(root, "nexus.config.json"),
    JSON.stringify({
      worktree: { share: [], postCreate: [], postMerge: [] },
      task: {
        version: 1,
        tasksDir: "jobs",
        controlDir: ".control",
        rules: ["rules.md"],
        executor: "agy",
        executors: {
          agy: {
            command: ["unused"],
            model: "test",
            effort: "medium",
            mode: "accept-edits",
            permissionArgs: [],
          },
        },
        budgetMinutes: 1,
        progressMinutes: 1,
        hardTimeoutMinutes: 0,
        worktreeDir: null,
        postCreate: [],
      },
    }),
  );
  return root;
}
function record(root, id, run, ended = true, extra = {}) {
  const folder = join(root, ".control", id);
  mkdirSync(join(folder, "runs", run), { recursive: true });
  writeFileSync(join(folder, "latest.json"), JSON.stringify({ directory: run }));
  writeFileSync(
    join(folder, "runs", run, "run.json"),
    JSON.stringify({
      id,
      state: ended ? "completed" : "running",
      startedAt: new Date().toISOString(),
      sourceRoot: root,
      stdout: join(folder, "runs", run, "stdout.json"),
      stderr: join(folder, "runs", run, "stderr.log"),
      supervisorPid: null,
      executorPid: null,
      conversationId: "session",
      resume: false,
      budgetReached: false,
      hardTimeout: false,
      ...(ended
        ? {
            endedAt: new Date().toISOString(),
            taskStatus: "待验收",
            endReason: "delivered",
          }
        : {}),
      ...extra,
    }),
  );
}
function watch(root, ...args) {
  return spawnSync(process.execPath, [cli, "task", "watch", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
  });
}
function observing(t, root, ...args) {
  const child = spawn(process.execPath, [cli, "task", "watch", ...args, "--poll-ms", "20"], { cwd: root });
  t.after(() => child.kill("SIGKILL"));
  let stdout = "",
    stderr = "";
  const ready = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.includes("开始观察")) resolve();
    });
    child.on("close", () => reject(new Error("观察器未就绪：" + stderr)));
  });
  child.stdout.on("data", (d) => (stdout += d));
  const result = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { ready, result, child };
}
test("观察器：显式多个已结束任务的摘要完整，使用配置控制目录", (t) => {
  const root = fixture(t);
  record(root, "alpha", "1");
  record(root, "beta", "2", true, {
    state: "failed",
    endReason: "needs_approval",
    error: "等待计划批准",
  });
  const r = watch(root, "alpha", "beta");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alpha/);
  assert.match(r.stdout, /beta/);
  assert.match(r.stdout, /needs_approval/);
  assert.match(r.stdout, /task resume 原会话续跑/);
});

test("观察器：all 保留已结束摘要，发现新任务和原任务新运行，不混入旧历史", { timeout: 5000 }, async (t) => {
  const root = fixture(t);
  record(root, "history", "1", true, { endedAt: "2020-01-01T00:00:00.000Z" });
  record(root, "alpha", "1", false);
  record(root, "beta", "1", false);
  const watcher = observing(t, root, "--all");
  await watcher.ready;
  record(root, "alpha", "1", true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  record(root, "alpha", "2", false);
  record(root, "fresh", "1", true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  record(root, "alpha", "2", true);
  record(root, "beta", "1", true);
  const r = await watcher.result;
  assert.equal(r.status, 0, r.stderr);
  const summary = r.stdout.split("=== 任务观察结果 ===")[1];
  for (const expected of ["alpha run=1", "alpha run=2", "beta run=1", "fresh run=1"]) assert.ok(summary.includes(expected), r.stdout);
  assert.doesNotMatch(summary, /history/);
});
test("观察器：缺少运行记录与超时返回非零，不假报全部结束", (t) => {
  const root = fixture(t);
  const r = watch(root, "missing", "--timeout-minutes", "0.001", "--poll-ms", "10");
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /未产生运行记录/);
  assert.match(r.stderr, /超时/);
});
test("观察器：持续损坏的记录明确失败，短暂半写可重试恢复", { timeout: 5000 }, async (t) => {
  const root = fixture(t);
  record(root, "alpha", "1", false);
  const file = join(root, ".control/alpha/runs/1/run.json");
  writeFileSync(file, "{");
  const bad = watch(root, "alpha", "--poll-ms", "10");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /记录读取失败.*3\/3/s);
  const watcher = observing(t, root, "alpha");
  await watcher.ready;
  record(root, "alpha", "1", true);
  assert.equal((await watcher.result).status, 0);
});
test("观察器：无活动任务时 all 立即结束，参数错误不等待", (t) => {
  const root = fixture(t);
  assert.equal(watch(root, "--all").status, 0);
  for (const args of [
    [],
    ["--all", "alpha"],
    ["alpha", "--timeout-minutes", "NaN"],
    ["alpha", "--poll-ms", "0"],
    ["../outside"],
    ["alpha", "--unknown"],
  ])
    assert.notEqual(watch(root, ...args).status, 0, JSON.stringify(args));
});
test("观察器：取消只退出观察，不改运行记录", { timeout: 5000 }, async (t) => {
  const root = fixture(t);
  record(root, "alpha", "1", false);
  const watcher = observing(t, root, "alpha");
  await watcher.ready;
  watcher.child.kill("SIGINT");
  assert.equal((await watcher.result).status, 130);
});

test("观察器：同一轮询间连续结束与续跑也保留每一轮，并显示真实退出码", { timeout: 5000 }, async (t) => {
  for (const args of [["--all"], ["alpha", "beta"]]) {
    const root = fixture(t);
    record(root, "alpha", "1", false);
    record(root, "beta", "1", false);
    const child = spawn(process.execPath, [cli, "task", "watch", ...args, "--poll-ms", "500"], { cwd: root });
    t.after(() => child.kill("SIGKILL"));
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    const ready = new Promise((resolve) =>
      child.stderr.on("data", (d) => {
        err += d;
        if (err.includes("开始观察")) resolve();
      }),
    );
    const done = new Promise((resolve) => child.on("close", (status) => resolve(status)));
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 80));
    record(root, "alpha", "1", true, {
      state: "failed",
      exitCode: 0,
      endReason: "needs_approval",
    });
    record(root, "alpha", "2", true, {
      state: "failed",
      exitCode: 42,
      endReason: "failed",
    });
    record(root, "alpha", "3", true, { exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    record(root, "beta", "1", true);
    assert.equal(await done, 0, err);
    const summary = out.split("=== 任务观察结果 ===")[1];
    for (const name of ["alpha run=1", "alpha run=2", "alpha run=3", "beta run=1"]) assert.ok(summary.includes(name), out);
    assert.match(summary, /exitCode=42/);
  }
});

test("观察器：兼容 GLM 旧记录的空结束分类，不改写历史", (t) => {
  const root = fixture(t);
  record(root, "legacy", "1", true, { endReason: null });
  const before = readFileSync(join(root, ".control/legacy/runs/1/run.json"), "utf8");
  const r = watch(root, "legacy");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reason=未分类/);
  assert.equal(readFileSync(join(root, ".control/legacy/runs/1/run.json"), "utf8"), before);
});

test("观察器：监督进程已退出但记录停在运行中，按中断结束，不空等到超时", (t) => {
  const root = fixture(t);
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  record(root, "orphan", "run-1", false, { supervisorPid: Number(dead.stdout) });
  const result = watch(root, "orphan", "--timeout-minutes", "1", "--poll-ms", "50");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[ended\] orphan run=run-1: state=interrupted/);
  assert.match(result.stdout, /监督进程已退出/);
});
