import { createHash as cryptoHash } from "node:crypto";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, realpathSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const cli = fileURLToPath(new URL("../packages/devflow/dist/cli.js", import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function repo() {
  const root = mkdtempSync(join(tmpdir(), "sw-task-test-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "task-test@example.invalid");
  git(root, "config", "user.name", "Task Test");
  writeFileSync(join(root, ".gitignore"), ".worktrees\nresearch/local\n");
  mkdirSync(join(root, "tasks"));
  writeFileSync(join(root, "tasks/协作规则.md"), "# 测试协作规则\n");
  writeFileSync(
    join(root, "nexus.config.json"),
    JSON.stringify({
      task: {
        version: 1,
        worktreeDir: ".worktrees",
        postCreate: [],
        tasksDir: "tasks",
        controlDir: "research/local/task-control",
        rules: ["tasks/协作规则.md"],
        executor: "agy",
        executors: {
          agy: {
            command: ["agy"],
            model: "test-model",
            effort: "medium",
            mode: "accept-edits",
            permissionArgs: [],
          },
        },
        budgetMinutes: 40,
        progressMinutes: 10,
        hardTimeoutMinutes: 0,
        executorEnvDeny: ["ALLOW_EVIDENCE_DELETE"],
      },
      worktree: { share: [], postCreate: [], postMerge: [] },
    }),
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture");
  return realpathSync(root);
}
function run(root, ...args) {
  return spawnSync(process.execPath, [cli, "task", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
}
function success(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function taskPath(root, id = "cancel-buy") {
  return join(root, "tasks", `${id}.md`);
}

test("new 生成可编辑任务，重复名称不覆盖原件", () => {
  const root = repo();
  const created = success(run(root, "new", "cancel-buy", "--title", "取消购买核验"));
  assert.equal(created.task, "tasks/cancel-buy.md");
  const original = readFileSync(taskPath(root), "utf8");
  assert.match(original, /取消购买核验/);
  assert.match(original, /> 状态：待认领/);
  const repeat = run(root, "new", "cancel-buy", "--title", "覆盖");
  assert.notEqual(repeat.status, 0);
  assert.match(repeat.stderr, /已存在/);
  assert.equal(readFileSync(taskPath(root), "utf8"), original);
  const traversal = run(root, "new", "../outside", "--title", "越界");
  assert.notEqual(traversal.status, 0);
  assert.equal(existsSync(join(dirname(root), "outside.md")), false);
});
function editTask(root, edit, id = "cancel-buy") {
  const file = taskPath(root, id),
    content = readFileSync(file, "utf8");
  const match = content.match(/<!-- task-config -->\n```json\n([\s\S]*?)\n```\n<!-- \/task-config -->/);
  const spec = JSON.parse(match[1]);
  edit(spec);
  writeFileSync(file, content.replace(match[1], JSON.stringify(spec, null, 2)));
}
function configure(root, edit) {
  const file = join(root, "nexus.config.json"),
    cfg = JSON.parse(readFileSync(file, "utf8"));
  edit(cfg.task);
  writeFileSync(file, JSON.stringify(cfg));
}
function ready(root, id = "cancel-buy") {
  success(run(root, "new", id, "--title", "取消购买核验"));
  editTask(
    root,
    (spec) => {
      spec.goal = "取消不扣款";
      spec.scope = "仅取消路径";
      spec.writable.push("artifact.txt");
      spec.verify = [
        {
          name: "取消余额",
          argv: [
            process.execPath,
            "-e",
            "const fs=require('fs');if(fs.readFileSync('artifact.txt','utf8')!=='cancel-ok')process.exit(3);fs.writeFileSync(process.env.TASK_VERIFY_OUTPUT+'/result.txt','verified')",
          ],
        },
      ];
    },
    id,
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "task ready");
  return git(root, "rev-parse", "HEAD");
}

test("start 固定提交建树并认领，重复调用恢复原树，主仓保持干净", () => {
  const root = repo(),
    base = ready(root);
  const started = success(run(root, "start", "cancel-buy", "--owner", "执行者"));
  assert.equal(started.base, base);
  const wt = join(root, ".worktrees/cancel-buy");
  assert.equal(git(wt, "branch", "--show-current"), "task/cancel-buy");
  assert.match(readFileSync(taskPath(wt), "utf8"), /> 状态：执行中/);
  assert.equal(git(root, "status", "--porcelain"), "");
  writeFileSync(join(wt, "artifact.txt"), "half-done");
  const head = git(wt, "rev-parse", "HEAD");
  const resumed = success(run(root, "start", "cancel-buy", "--owner", "执行者"));
  assert.equal(resumed.restored, true);
  assert.equal(git(wt, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(wt, "artifact.txt"), "utf8"), "half-done");
});

test("status 读取真实工作树，并保留旧任务只读支持", () => {
  const root = repo();
  ready(root);
  success(run(root, "start", "cancel-buy", "--owner", "执行者"));
  writeFileSync(join(root, "tasks/旧任务.md"), "# 旧任务\n\n> 状态：待认领\n> 分支：research/old\n> 工作树：.worktrees/old\n");
  const result = success(run(root, "status"));
  assert.equal(result.tasks.find((t) => t.id === "cancel-buy").status, "执行中");
  assert.equal(result.tasks.find((t) => t.task === "tasks/旧任务.md").legacy, true);
  assert.notEqual(run(root, "dispatch", "旧任务").status, 0);
});
const executor = fileURLToPath(new URL("./fixtures/task-executor.mjs", import.meta.url));
function executorConfig(root) {
  configure(root, (cfg) => {
    cfg.executors.agy.command = [process.execPath, executor];
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "executor config");
}
function opencodeConfig(root, executorName = "opencode") {
  configure(root, (cfg) => {
    cfg.executors[executorName] = {
      command: [process.execPath, executor, "--opencode"],
      model: "opencode/test-model",
      permissionArgs: [],
    };
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "opencode executor config");
}
async function finished(root, id = "cancel-buy") {
  for (let n = 0; n < 180; n++) {
    const result = success(run(root, "status", id)).tasks[0];
    if (result.run && !["starting", "running"].includes(result.run.state)) return result;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.fail("执行器没有结束");
}
function detachedScenario(root, scenario, ...args) {
  return spawnSync(process.execPath, [cli, "task", ...args, "--detach"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, TASK_TEST_SCENARIO: scenario },
  });
}

test("dispatch 预览无副作用；未提交任务与指纹错误拒绝启动", () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  const preview = success(run(root, "dispatch", "cancel-buy", "--dry-run"));
  assert.match(preview.prompt, /task start/);
  assert.equal(existsSync(join(root, "research/local/task-control")), false);
  writeFileSync(taskPath(root), readFileSync(taskPath(root), "utf8") + "\n未提交\n");
  const dirty = run(root, "dispatch", "cancel-buy");
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /未提交/);
  git(root, "checkout", "--", "tasks/cancel-buy.md");
  writeFileSync(join(root, "source.txt"), "actual");
  editTask(root, (s) => {
    s.inputs = [{ path: "source.txt", sha256: "0".repeat(64) }];
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "wrong input");
  const bad = run(root, "dispatch", "cancel-buy");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /指纹不符/);
  assert.ok(bad.stderr.includes("期望 SHA-256 " + "0".repeat(64)), bad.stderr);
  assert.ok(bad.stderr.includes("实际 SHA-256 e5c6fde86910ded72db5cc7afc32f850440d4ef7caa5dbb69f5bdc0d3e39cb3b"), bad.stderr);
});

test("协调者 shell 里的删除放行变量不会传给执行者", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  const envFile = join(root, "research/local/executor-env.json");
  const result = spawnSync(process.execPath, [cli, "task", "dispatch", "cancel-buy", "--detach"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      TASK_TEST_SCENARIO: "complete",
      TASK_TEST_ENV_FILE: envFile,
      ALLOW_EVIDENCE_DELETE: "1",
    },
  });
  success(result);
  await finished(root);
  assert.deepEqual(JSON.parse(readFileSync(envFile, "utf8")), {
    allowEvidenceDelete: null,
  });
});
test("dispatch 完整交付，status 显示会话；无前置不能启动", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(detachedScenario(root, "complete", "dispatch", "cancel-buy"));
  const done = await finished(root);
  assert.equal(done.status, "待验收");
  assert.equal(done.run.state, "completed");
  assert.equal(done.run.conversationId, "fixture-session");
  assert.equal(git(root, "status", "--porcelain"), "");
  const blocked = repo();
  ready(blocked);
  editTask(blocked, (s) => {
    s.dependencies = [{ id: "missing" }];
  });
  git(blocked, "add", ".");
  git(blocked, "commit", "-m", "dependency");
  const r = run(blocked, "dispatch", "cancel-buy");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /前置任务未通过/);
});

test("失败留下退出码和日志，中断后通过原会话续跑，现场不重建", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(detachedScenario(root, "fail", "dispatch", "cancel-buy"));
  const failed = await finished(root);
  assert.equal(failed.run.exitCode, 7);
  assert.equal(failed.status, "中断");
  assert.match(readFileSync(failed.run.stderr, "utf8"), /deliberate failure/);
  // A failed turn may not emit a final JSON; explicitly supply its known conversation.
  const resumed = success(detachedScenario(root, "complete", "resume", "cancel-buy", "--conversation", "fixture-session"));
  assert.equal(resumed.conversationId, "fixture-session");
  const done = await finished(root);
  assert.equal(done.run.state, "completed");
  assert.equal(done.run.resume, true);
  assert.match(readFileSync(done.run.stdout, "utf8"), /resumed/);
});

test("坏 JSON 与缺会话不能冒充成功", async () => {
  for (const scenario of ["invalid", "missing-session"]) {
    const root = repo();
    ready(root);
    executorConfig(root);
    success(detachedScenario(root, scenario, "dispatch", "cancel-buy"));
    const done = await finished(root);
    assert.equal(done.run.state, "failed");
    assert.match(done.run.error, /JSON|conversation_id/);
    const retry = run(root, "resume", "cancel-buy");
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /会话/);
  }
});

test("重复派发拒绝，首轮预算不终止进程，硬期限另外终止并留证", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  configure(root, (cfg) => {
    cfg.budgetMinutes = 0.001;
    cfg.progressMinutes = 0.001;
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "budget");
  success(detachedScenario(root, "sleep", "dispatch", "cancel-buy"));
  const duplicate = detachedScenario(root, "sleep", "dispatch", "cancel-buy");
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /正在运行/);
  const done = await finished(root);
  assert.equal(done.run.exitCode, 0);
  assert.equal(done.run.budgetReached, true);
  const timed = repo();
  ready(timed);
  executorConfig(timed);
  configure(timed, (cfg) => {
    cfg.hardTimeoutMinutes = 0.002;
  });
  git(timed, "add", ".");
  git(timed, "commit", "-m", "hard limit");
  success(detachedScenario(timed, "sleep", "dispatch", "cancel-buy"));
  const stopped = await finished(timed);
  assert.equal(stopped.run.state, "interrupted");
  assert.equal(stopped.run.hardTimeout, true);
});
function delivered(root) {
  ready(root);
  success(run(root, "start", "cancel-buy", "--owner", "执行者"));
  const wt = join(root, ".worktrees/cancel-buy");
  writeFileSync(join(wt, "artifact.txt"), "cancel-ok");
  writeFileSync(taskPath(wt), readFileSync(taskPath(wt), "utf8").replace(/^> 状态：.*$/m, "> 状态：待验收"));
  git(wt, "add", ".");
  git(wt, "commit", "-m", "delivery");
  return wt;
}
function review(root, commit) {
  const path = join(root, "review.json");
  writeFileSync(
    path,
    JSON.stringify({
      commit,
      code: {
        passed: true,
        reviewer: "independent-reviewer",
        record: "独立审查通过；范围内无阻断问题",
      },
    }),
  );
  return path;
}

test("verify 新目录独立复跑，accept 绑定提交并登记审查依据", () => {
  const root = repo(),
    wt = delivered(root),
    head = git(wt, "rev-parse", "HEAD");
  const verified = success(run(root, "verify", "cancel-buy"));
  assert.equal(verified.passed, true);
  assert.equal(verified.baseWarning, undefined);
  assert.equal(verified.commit, head);
  assert.equal(readFileSync(join(verified.output, "0/result.txt"), "utf8"), "verified");
  const verifiedAgain = success(run(root, "verify", "cancel-buy"));
  assert.notEqual(verified.output, verifiedAgain.output);
  const r = review(root, head);
  const accepted = success(run(root, "accept", "cancel-buy", "--review", r));
  assert.equal(accepted.verifiedCommit, head);
  assert.equal(accepted.status, "通过");
  assert.match(readFileSync(taskPath(wt), "utf8"), /> 状态：通过/);
  assert.equal(success(run(root, "status", "cancel-buy")).tasks[0].status, "通过");
});

test("验证命令失败保留日志和 passed=false，不能验收", () => {
  const root = repo(),
    wt = delivered(root);
  writeFileSync(join(wt, "artifact.txt"), "wrong");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "bad result");
  const failed = run(root, "verify", "cancel-buy");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /验证命令失败/);
  const pointer = JSON.parse(readFileSync(join(root, "research/local/task-control/cancel-buy/latest-verify.json"), "utf8"));
  const evidence = JSON.parse(readFileSync(pointer.file, "utf8"));
  assert.equal(evidence.passed, false);
  assert.equal(evidence.commands[0].exitCode, 3);
  assert.notEqual(run(root, "accept", "cancel-buy", "--review", review(root, git(wt, "rev-parse", "HEAD"))).status, 0);
});

test("未提交内容、越界改动、变更后的代码和缺审查阻止通过", () => {
  const root = repo(),
    wt = delivered(root);
  writeFileSync(join(wt, "artifact.txt"), "dirty");
  assert.match(run(root, "verify", "cancel-buy").stderr, /未提交/);
  git(wt, "checkout", "--", "artifact.txt");
  writeFileSync(join(wt, "outside.txt"), "forbidden");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "outside");
  assert.match(run(root, "verify", "cancel-buy").stderr, /白名单/);
  git(wt, "revert", "--no-edit", "HEAD");
  success(run(root, "verify", "cancel-buy"));
  const verifiedHead = git(wt, "rev-parse", "HEAD");
  assert.notEqual(run(root, "accept", "cancel-buy").status, 0);
  writeFileSync(join(wt, "artifact.txt"), "cancel-ok\n");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "changed after verify");
  const stale = run(root, "accept", "cancel-buy", "--review", review(root, verifiedHead));
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /提交已变化/);
});

function deliveredWithDeletion(root, editSpec, change = (wt) => unlinkSync(join(wt, "guide.jpg"))) {
  writeFileSync(join(root, "guide.jpg"), "image");
  git(root, "add", ".");
  git(root, "commit", "-m", "shared input");
  ready(root);
  editTask(root, editSpec);
  git(root, "add", ".");
  git(root, "commit", "-m", "deletion scope");
  success(run(root, "start", "cancel-buy", "--owner", "执行者"));
  const wt = join(root, ".worktrees/cancel-buy");
  writeFileSync(join(wt, "artifact.txt"), "cancel-ok");
  change(wt);
  writeFileSync(taskPath(wt), readFileSync(taskPath(wt), "utf8").replace(/^> 状态：.*$/m, "> 状态：待验收"));
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "delivery deletes shared input");
  return wt;
}

test("可写白名单不授权删除：删除基准已有文件必须列入 deletable", () => {
  const root = repo();
  deliveredWithDeletion(root, (s) => s.writable.push("guide.jpg"));
  const rejected = run(root, "verify", "cancel-buy");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /删除未授权："guide\.jpg"/);
  assert.match(rejected.stderr, /deletable/);
  assert.notEqual(run(root, "accept", "cancel-buy", "--review", review(root, "0".repeat(40))).status, 0);
});

test("重命名按删除旧路径处理：旧路径未列入 deletable 时拒绝", () => {
  const root = repo();
  deliveredWithDeletion(
    root,
    (s) => s.writable.push("guide.jpg", "guide-renamed.jpg"),
    (wt) => git(wt, "mv", "guide.jpg", "guide-renamed.jpg"),
  );
  const rejected = run(root, "verify", "cancel-buy");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /删除未授权："guide\.jpg"/);
  assert.doesNotMatch(rejected.stderr, /guide-renamed\.jpg/);
});

test("未声明 deletable 的任务配置字段与顺序不变，定义指纹不受新字段影响", async () => {
  const { parseSpec, config } = await import("../packages/devflow/dist/task/definition.js");
  const root = repo();
  success(run(root, "new", "cancel-buy", "--title", "指纹"));
  let raw;
  editTask(root, (s) => {
    raw = structuredClone(s);
  });
  const legacyKeys = [
    "version",
    "id",
    "branch",
    "worktree",
    "goal",
    "scope",
    "writable",
    "inputs",
    "dependencies",
    "verify",
    "productReviewRequired",
  ];
  assert.deepEqual(Object.keys(parseSpec(raw, root, config(root), "cancel-buy")), legacyKeys);
  const declared = parseSpec({ ...raw, deletable: ["guide.jpg"] }, root, config(root), "cancel-buy");
  assert.deepEqual(Object.keys(declared), [...legacyKeys.slice(0, 7), "deletable", ...legacyKeys.slice(7)]);
});

test("deletable 声明的删除可以验收，路径越界或指向自身任务文件被拒", () => {
  const allowed = repo();
  deliveredWithDeletion(allowed, (s) => {
    s.deletable = ["guide.jpg"];
  });
  assert.equal(success(run(allowed, "verify", "cancel-buy")).passed, true);

  for (const [bad, message] of [
    [["../outside.txt"], /路径|越界|outside/],
    [["tasks/cancel-buy.md"], /不能删除自己的任务文件/],
    [["guide.jpg", "guide.jpg"], /重复/],
  ]) {
    const root = repo();
    success(run(root, "new", "cancel-buy", "--title", "删除范围"));
    editTask(root, (s) => {
      s.goal = "删除范围校验";
      s.scope = "仅校验";
      s.verify = [{ name: "noop", argv: [process.execPath, "-e", ""] }];
      s.deletable = bad;
    });
    git(root, "add", ".");
    git(root, "commit", "-m", "bad deletable");
    const result = run(root, "start", "cancel-buy", "--owner", "执行者");
    assert.notEqual(result.status, 0, JSON.stringify(bad));
    assert.match(result.stderr, message);
  }
});

test("路径软链、坏配置、缺 goal 和未知命令有明确失败", () => {
  const root = repo();
  ready(root);
  editTask(root, (s) => {
    s.goal = "";
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "incomplete");
  assert.match(run(root, "dispatch", "cancel-buy", "--dry-run").stderr, /goal/);
  editTask(root, (s) => {
    s.goal = "cancel";
    s.writable.push(".git/config");
  });
  assert.match(run(root, "dispatch", "cancel-buy", "--dry-run").stderr, /禁止(写入|访问)/);
  assert.notEqual(run(root, "unknown", "cancel-buy").status, 0);
  const help = run(root, "--help");
  assert.equal(help.status, 0);
  const missing = run(root);
  assert.equal(missing.status, 2);
  configure(root, (cfg) => {
    cfg.executors.agy.mode = "typo";
  });
  assert.match(run(root, "status").stderr, /mode/);
});

test("任务执行配置可覆盖默认预算与模型，输入只读副本不污染主仓", () => {
  const root = repo();
  ready(root);
  writeFileSync(join(root, "input.txt"), "fixture-input");
  editTask(root, (s) => {
    s.execution = {
      model: "task-model",
      budgetMinutes: 1,
      progressMinutes: 0.5,
      hardTimeoutMinutes: 0,
    };
    s.inputs = [
      {
        path: "input.txt",
        sha256: "988d844190c9507fd0dc2489834de24120bc2971f8d473c0f372bdcc31d0f33b1",
      },
    ];
  });
  // Pin the known fixture bytes; the digest is the external input fingerprint.
  editTask(root, (s) => {
    s.inputs[0].sha256 = cryptoHash("sha256").update("fixture-input").digest("hex");
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "input");
  const preview = success(run(root, "dispatch", "cancel-buy", "--dry-run"));
  assert.match(preview.prompt, /预算 1 分钟/);
  const started = success(run(root, "start", "cancel-buy", "--owner", "executor"));
  assert.equal(readFileSync(join(started.worktree, "input.txt"), "utf8"), "fixture-input");
  assert.equal(git(root, "status", "--porcelain"), "");
  editTask(root, (s) => {
    s.execution.extra = 1;
  });
  assert.match(run(root, "dispatch", "cancel-buy", "--dry-run").stderr, /未知 execution/);
});

test("已验收前置可派发，前置后来有修改时拒绝使用", () => {
  const root = repo(),
    wt = delivered(root);
  success(run(root, "verify", "cancel-buy"));
  success(run(root, "accept", "cancel-buy", "--review", review(root, git(wt, "rev-parse", "HEAD"))));
  ready(root, "follow-up");
  editTask(
    root,
    (s) => {
      s.dependencies = [{ id: "cancel-buy" }];
    },
    "follow-up",
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "valid dependency");
  assert.equal(run(root, "dispatch", "follow-up", "--dry-run").status, 0);
  writeFileSync(join(wt, "artifact.txt"), "later");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "changed dependency");
  assert.match(run(root, "dispatch", "follow-up", "--dry-run").stderr, /前置任务版本变化/);
});

test("执行器程序不存在时失败收尾，不能留下永久运行假象", async () => {
  const root = repo();
  ready(root);
  configure(root, (cfg) => {
    cfg.executors.agy.command = ["/nonexistent/task-executor"];
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "missing executor");
  success(run(root, "dispatch", "cancel-buy", "--detach"));
  const done = await finished(root);
  assert.equal(done.run.state, "failed");
  assert.match(done.run.error, /启动失败/);
});

test("预建同任务树也必须认领并保存基准，旧树不能假装恢复完成", () => {
  const root = repo(),
    base = ready(root);
  git(root, "worktree", "add", "-b", "task/cancel-buy", join(root, ".worktrees/cancel-buy"), base);
  success(run(root, "start", "cancel-buy", "--owner", "executor"));
  assert.ok(existsSync(join(root, "research/local/task-control/cancel-buy/definition.json")));
  assert.match(readFileSync(taskPath(join(root, ".worktrees/cancel-buy")), "utf8"), /> 状态：执行中/);
});

test("后端配置漂移阻止建树，独立复跑产物被改后阻止验收", () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(detachedScenario(root, "invalid", "dispatch", "cancel-buy"));
  const file = join(root, "nexus.config.json"),
    altered = JSON.parse(readFileSync(file, "utf8"));
  altered.worktree.postCreate = [[process.execPath, "-e", "process.exit(0)"]];
  writeFileSync(file, JSON.stringify(altered));
  assert.match(run(root, "start", "cancel-buy", "--owner", "executor").stderr, /后端配置/);
  const clean = repo(),
    wt = delivered(clean),
    verified = success(run(clean, "verify", "cancel-buy"));
  writeFileSync(join(verified.output, "0/result.txt"), "tampered");
  assert.match(run(clean, "accept", "cancel-buy", "--review", review(clean, git(wt, "rev-parse", "HEAD"))).stderr, /产物.*变化/);
});

test("验收前置合入并回收后仍能派发下游任务", () => {
  const root = repo(),
    wt = delivered(root);
  success(run(root, "verify", "cancel-buy"));
  success(run(root, "accept", "cancel-buy", "--review", review(root, git(wt, "rev-parse", "HEAD"))));
  git(root, "merge", "--ff-only", "task/cancel-buy");
  git(root, "worktree", "remove", wt);
  ready(root, "follow-up");
  editTask(
    root,
    (s) => {
      s.dependencies = [{ id: "cancel-buy" }];
    },
    "follow-up",
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "dependency after cleanup");
  assert.equal(run(root, "dispatch", "follow-up", "--dry-run").status, 0);
});

test("范围变更必须显式重新确认；确认后原树和原会话可继续", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(detachedScenario(root, "fail", "dispatch", "cancel-buy"));
  await finished(root);
  const wt = join(root, ".worktrees/cancel-buy");
  editTask(wt, (s) => {
    s.scope = "取消与返回路径";
  });
  git(wt, "add", ".");
  git(wt, "commit", "-m", "approved scope");
  assert.match(run(wt, "resume", "cancel-buy", "--conversation", "fixture-session").stderr, /定义已变化/);
  success(detachedScenario(wt, "complete", "resume", "cancel-buy", "--conversation", "fixture-session", "--refresh-definition"));
  assert.equal((await finished(root)).status, "待验收");
  assert.match(readFileSync(taskPath(wt), "utf8"), /取消与返回路径/);
});

test("续跑返回错误会话时保留原会话标识", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(detachedScenario(root, "fail", "dispatch", "cancel-buy"));
  await finished(root);
  success(detachedScenario(root, "wrong-session", "resume", "cancel-buy", "--conversation", "fixture-session"));
  const result = await finished(root);
  assert.equal(result.run.state, "failed");
  assert.equal(result.run.conversationId, "fixture-session");
  assert.equal(result.run.reportedConversationId, "wrong-session");
});

test("硬期限结束确认忽略 TERM 的后代也退出，才释放任务", async (t) => {
  const root = repo();
  ready(root);
  executorConfig(root);
  configure(root, (cfg) => {
    cfg.hardTimeoutMinutes = 0.02;
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "group deadline");
  const pidFile = join(root, "research/local/orphan.pid");
  mkdirSync(dirname(pidFile), { recursive: true });
  const r = spawnSync(process.execPath, [cli, "task", "dispatch", "cancel-buy", "--detach"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      TASK_TEST_SCENARIO: "orphan",
      TASK_TEST_PID_FILE: pidFile,
    },
  });
  success(r);
  const done = await finished(root);
  assert.equal(done.run.state, "interrupted");
  assert.ok(existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("实际软链越界与规则漂移均拒绝，验证不碰原件", async () => {
  const { symlinkSync } = await import("node:fs");
  const root = repo();
  ready(root);
  const external = mkdtempSync(join(tmpdir(), "sw-task-external-"));
  roots.push(external);
  symlinkSync(external, join(root, "linked"));
  editTask(root, (s) => s.writable.push("linked/output.txt"));
  assert.match(run(root, "dispatch", "cancel-buy", "--dry-run").stderr, /越界/);
  assert.equal(existsSync(join(external, "output.txt")), false);
  git(root, "checkout", "--", "tasks/cancel-buy.md");
  rmSync(join(root, "linked"));
  success(run(root, "start", "cancel-buy", "--owner", "executor"));
  const wt = join(root, ".worktrees/cancel-buy");
  writeFileSync(join(wt, "tasks/协作规则.md"), "changed");
  assert.match(run(root, "start", "cancel-buy", "--owner", "executor").stderr, /公共规则已变化/);
  git(wt, "checkout", "--", "tasks/协作规则.md");
  configure(wt, (cfg) => {
    cfg.executors.agy.model = "changed";
  });
  assert.match(run(root, "start", "cancel-buy", "--owner", "executor").stderr, /项目配置已变化|后端配置已变化/);
});

test("产品评审缺失、验证材料改动以及未交付状态不能验收", () => {
  const root = repo();
  ready(root);
  editTask(root, (s) => {
    s.productReviewRequired = true;
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "product review required");
  success(run(root, "start", "cancel-buy", "--owner", "executor"));
  assert.match(run(root, "verify", "cancel-buy").stderr, /待验收/);
  const wt = join(root, ".worktrees/cancel-buy");
  writeFileSync(join(wt, "artifact.txt"), "cancel-ok");
  writeFileSync(taskPath(wt), readFileSync(taskPath(wt), "utf8").replace("> 状态：执行中", "> 状态：待验收"));
  git(wt, "add", ".");
  git(wt, "commit", "-m", "delivery");
  const verified = success(run(root, "verify", "cancel-buy")),
    head = git(wt, "rev-parse", "HEAD"),
    r = review(root, head);
  assert.match(run(root, "accept", "cancel-buy", "--review", r).stderr, /product/);
  const value = JSON.parse(readFileSync(r, "utf8"));
  value.product = {
    passed: true,
    reviewer: "product-reviewer",
    record: "cancel journey verified",
  };
  writeFileSync(r, JSON.stringify(value));
  writeFileSync(verified.receipt, readFileSync(verified.receipt, "utf8") + " ");
  assert.match(run(root, "accept", "cancel-buy", "--review", r).stderr, /材料指纹变化/);
  success(run(root, "verify", "cancel-buy"));
  assert.equal(run(root, "accept", "cancel-buy", "--review", r).status, 0);
});

test("任务与项目输入错误有清晰错误，配置不完整不默默套默认", () => {
  for (const mutation of [
    (cfg) => {
      cfg.version = 2;
    },
    (cfg) => {
      cfg.executors.agy.effort = "typo";
    },
    (cfg) => {
      cfg.rules = [];
    },
    (cfg) => {
      cfg.budgetMinutes = -1;
    },
    (cfg) => {
      cfg.executors.agy.command = [];
    },
  ]) {
    const root = repo();
    configure(root, mutation);
    assert.notEqual(run(root, "status").status, 0);
  }
  const root = repo();
  ready(root);
  writeFileSync(join(root, "nexus.config.json"), "{bad json");
  assert.match(run(root, "status").stderr, /JSON/);
  git(root, "checkout", "--", "nexus.config.json");
  const original = readFileSync(taskPath(root), "utf8");
  for (const mutation of [
    (s) => {
      s.execution = { effort: "typo" };
    },
    (s) => {
      s.execution = { mode: "typo" };
    },
    (s) => {
      s.inputs = [{ path: "missing.bin", sha256: "a".repeat(64) }];
    },
  ]) {
    writeFileSync(taskPath(root), original);
    editTask(root, mutation);
    git(root, "add", ".");
    git(root, "commit", "-m", "invalid task");
    assert.notEqual(run(root, "dispatch", "cancel-buy", "--dry-run").status, 0);
  }
});

test("真实 agy 大写 SUCCESS 被识别为成功", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(detachedScenario(root, "uppercase", "dispatch", "cancel-buy"));
  const done = await finished(root);
  assert.equal(done.run.state, "completed");
});

test("Git 索引忽略标记不能让未提交字节冒充被验收提交", () => {
  const root = repo(),
    wt = delivered(root);
  writeFileSync(join(wt, "artifact.txt"), "wrong committed");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "wrong bytes");
  git(wt, "update-index", "--assume-unchanged", "artifact.txt");
  writeFileSync(join(wt, "artifact.txt"), "cancel-ok");
  assert.equal(git(wt, "status", "--porcelain"), "");
  assert.match(run(root, "verify", "cancel-buy").stderr, /索引.*忽略/);
});

test("验证脚本忽略 TERM 时仍按期限退出，留下失败记录并释放锁", () => {
  const root = repo();
  ready(root);
  editTask(root, (s) => {
    s.verify = [
      {
        name: "ignore-term",
        timeoutSeconds: 0.05,
        argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      },
    ];
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "verification timeout");
  success(run(root, "start", "cancel-buy", "--owner", "executor"));
  const wt = join(root, ".worktrees/cancel-buy");
  writeFileSync(taskPath(wt), readFileSync(taskPath(wt), "utf8").replace("> 状态：执行中", "> 状态：待验收"));
  git(wt, "add", ".");
  git(wt, "commit", "-m", "delivery");
  const r = run(root, "verify", "cancel-buy");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /超时|期限/);
  assert.equal(existsSync(join(root, "research/local/task-control/cancel-buy/operation.lock")), false);
  const pointer = JSON.parse(readFileSync(join(root, "research/local/task-control/cancel-buy/latest-verify.json"), "utf8")),
    receipt = JSON.parse(readFileSync(pointer.file, "utf8"));
  assert.equal(receipt.passed, false);
  assert.equal(receipt.commands[0].timedOut, true);
});

test("复跑输出目录自身是软链时拒绝，不能读仓库外证据", async () => {
  const root = repo();
  ready(root);
  const outside = mkdtempSync(join(tmpdir(), "sw-output-external-"));
  roots.push(outside);
  writeFileSync(join(outside, "evidence.txt"), "external");
  editTask(root, (s) => {
    s.verify = [
      {
        name: "output-link",
        argv: [
          process.execPath,
          "-e",
          `const fs=require('fs');const p=process.env.TASK_VERIFY_OUTPUT;fs.rmdirSync(p);fs.symlinkSync(${JSON.stringify(outside)},p)`,
        ],
      },
    ];
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "output symlink");
  success(run(root, "start", "cancel-buy", "--owner", "executor"));
  const wt = join(root, ".worktrees/cancel-buy");
  writeFileSync(taskPath(wt), readFileSync(taskPath(wt), "utf8").replace("> 状态：执行中", "> 状态：待验收"));
  git(wt, "add", ".");
  git(wt, "commit", "-m", "delivery");
  const r = run(root, "verify", "cancel-buy");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /软链/);
});

test("dispatch 默认等待最终交付，返回最终结果而不是 starting", () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  const result = success(run(root, "dispatch", "cancel-buy"));
  assert.equal(result.state, "completed");
  assert.equal(result.taskStatus, "待验收");
  assert.equal(result.conversationId, "fixture-session");
  assert.equal(result.result.response, "delivered");
  assert.ok(result.endedAt);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("默认等待报告失败和受阻，resume 返回原会话最终结果", () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  const invoke = (scenario, ...args) =>
    spawnSync(process.execPath, [cli, "task", ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TASK_TEST_SCENARIO: scenario },
    });
  const failed = invoke("fail", "dispatch", "cancel-buy");
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).state, "failed");
  const blocked = invoke("blocked", "resume", "cancel-buy", "--conversation", "fixture-session");
  assert.equal(blocked.status, 3);
  assert.equal(JSON.parse(blocked.stdout).taskStatus, "受阻");
  const resumed = success(invoke("complete", "resume", "cancel-buy"));
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.result.response, "resumed");
});

function asyncRun(root, scenario, ...args) {
  const child = spawn(process.execPath, [cli, "task", ...args], {
    cwd: root,
    env: { ...process.env, TASK_TEST_SCENARIO: scenario },
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, result };
}
async function until(root, predicate, id = "cancel-buy") {
  for (let i = 0; i < 100; i++) {
    const t = success(run(root, "status", id)).tasks[0];
    if (predicate(t)) return t;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail("任务未到达预期阶段");
}
test("INT 和 TERM 只取消等待，监督进程仍可完成交付", async () => {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const root = repo();
    ready(root);
    executorConfig(root);
    const execution = asyncRun(root, "slow-delivery", "dispatch", "cancel-buy");
    await until(root, (t) => t.status === "执行中" && t.run?.executorPid);
    execution.child.kill(signal);
    const stopped = await execution.result;
    assert.equal(stopped.status, code);
    assert.equal(JSON.parse(stopped.stdout).waitingCancelled, true);
    const done = await finished(root);
    assert.equal(done.run.state, "completed");
    assert.equal(done.status, "待验收");
  }
});
test("两任务默认等待互不阻塞，等待期间拒绝重复派发", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  ready(root, "second");
  const a = asyncRun(root, "slow-delivery", "dispatch", "cancel-buy"),
    b = asyncRun(root, "slow-delivery", "dispatch", "second");
  await until(root, (t) => t.status === "执行中");
  assert.match(run(root, "dispatch", "cancel-buy").stderr, /正在运行/);
  for (const result of await Promise.all([a.result, b.result])) assert.equal(success(result).state, "completed");
});
test("监督进程异常退出时等待明确失败，不永久挂起", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  const execution = asyncRun(root, "sleep", "dispatch", "cancel-buy");
  const t = await until(root, (t) => t.run?.executorPid);
  process.kill(t.run.supervisorPid, "SIGKILL");
  const failed = await execution.result;
  assert.equal(failed.status, 1);
  assert.match(JSON.parse(failed.stdout).error, /监督进程/);
  try {
    process.kill(-t.run.executorPid, "SIGKILL");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
});

test("启动日志提前登记本次会话，半行与干扰记录不误认，最终输出缺失仍可续跑", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  const execution = asyncRun(root, "early-session", "dispatch", "cancel-buy");
  const t = await until(root, (t) => t.run?.conversationId);
  assert.equal(t.run.state, "running");
  assert.equal(t.run.conversationId, "4890d7e3-fa80-415d-b856-23ed106ba9bc");
  const ended = await execution.result;
  assert.equal(ended.status, 1);
  assert.equal(JSON.parse(ended.stdout).conversationId, "4890d7e3-fa80-415d-b856-23ed106ba9bc");
  const resumed = success(await asyncRun(root, "early-resume", "resume", "cancel-buy").result);
  assert.equal(resumed.conversationId, "4890d7e3-fa80-415d-b856-23ed106ba9bc");
  assert.equal(resumed.sessionSource, "startup-log");
});

test("会话冲突不能覆盖启动 ID，未知日志格式回退最终 JSON，硬中断保留开局 ID", () => {
  for (const scenario of ["mismatch-final", "multiple-session", "unknown-log", "early-hard"]) {
    const root = repo();
    ready(root);
    executorConfig(root);
    if (scenario === "early-hard") {
      configure(root, (c) => (c.hardTimeoutMinutes = 0.015));
      git(root, "add", ".");
      git(root, "commit", "-m", "early interruption");
    }
    const r = spawnSync(process.execPath, [cli, "task", "dispatch", "cancel-buy"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TASK_TEST_SCENARIO: scenario },
    });
    const result = JSON.parse(r.stdout);
    if (scenario === "unknown-log") {
      assert.equal(r.status, 0);
      assert.equal(result.conversationId, "fixture-session");
      assert.match(result.sessionWarning, /最终输出/);
    } else {
      assert.equal(r.status, 1);
      assert.equal(result.conversationId, "4890d7e3-fa80-415d-b856-23ed106ba9bc");
      assert.ok(result.error);
    }
  }
});
function reworkMessage(root) {
  const p = join(root, "research/local/rework.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      defects: "取消后余额变化",
      reproduce: "node cancel-probe.mjs --cancel",
      criteria: "余额与库存保持不变",
    }),
  );
  return p;
}
test("rework 正式记录缺陷与通过标准，只提交原任务，不自动续跑", () => {
  const root = repo(),
    wt = delivered(root);
  success(run(root, "verify", "cancel-buy"));
  const before = git(wt, "rev-parse", "HEAD");
  const r = success(run(root, "rework", "cancel-buy", "--message-file", reworkMessage(root)));
  assert.equal(r.status, "返工");
  assert.notEqual(r.commit, before);
  assert.equal(git(wt, "show", "--format=", "--name-only", "HEAD"), "tasks/cancel-buy.md");
  const content = readFileSync(taskPath(wt), "utf8");
  assert.match(content, /> 状态：返工/);
  assert.match(content, /取消后余额变化/);
  assert.match(content, /余额与库存保持不变/);
  assert.equal(success(run(root, "status", "cancel-buy")).tasks[0].run, null);
  assert.match(run(root, "accept", "cancel-buy", "--review", review(root, r.commit)).stderr, /待验收/);
  assert.match(run(root, "rework", "cancel-buy", "--message-file", reworkMessage(root)).stderr, /返工/);
});

test("rework 拒绝脏树、错误分支、不完整说明、运行中和已通过任务，提交失败不报告成功", async () => {
  const root = repo(),
    wt = delivered(root),
    message = reworkMessage(root),
    head = git(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "artifact.txt"), "staged");
  git(wt, "add", "artifact.txt");
  assert.match(run(root, "rework", "cancel-buy", "--message-file", message).stderr, /未提交|暂存/);
  git(wt, "restore", "--staged", "artifact.txt");
  git(wt, "restore", "artifact.txt");
  git(wt, "checkout", "-b", "wrong");
  assert.match(run(root, "rework", "cancel-buy", "--message-file", message).stderr, /分支/);
  git(wt, "checkout", "task/cancel-buy");
  writeFileSync(message, JSON.stringify({ defects: "x" }));
  assert.match(run(root, "rework", "cancel-buy", "--message-file", message).stderr, /reproduce/);
  reworkMessage(root);
  success(run(root, "verify", "cancel-buy"));
  success(run(root, "accept", "cancel-buy", "--review", review(root, head)));
  assert.match(run(root, "rework", "cancel-buy", "--message-file", message).stderr, /通过/);
  const active = repo();
  ready(active);
  executorConfig(active);
  const execution = asyncRun(active, "slow-delivery", "dispatch", "cancel-buy");
  await until(active, (t) => t.status === "执行中");
  assert.match(run(active, "rework", "cancel-buy", "--message-file", reworkMessage(active)).stderr, /正在运行/);
  success(await execution.result);
  const broken = repo(),
    tree = delivered(broken),
    hooks = join(broken, ".git/hooks");
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  const failed = run(broken, "rework", "cancel-buy", "--message-file", reworkMessage(broken));
  assert.equal(failed.status, 1);
  assert.equal(git(tree, "log", "-1", "--format=%s"), "delivery");
  assert.equal(git(tree, "diff", "--cached", "--name-only"), "tasks/cancel-buy.md");
});
test("新模板写明预建空目录与探索探针的验证约定", () => {
  const root = repo();
  success(run(root, "new", "cancel-buy", "--title", "探索任务"));
  const content = readFileSync(taskPath(root), "utf8");
  assert.match(content, /预先创建的空目录/);
  assert.match(content, /尚未实现/);
});

test("status --short 显示任务、进程、HEAD 和验证结果，旧任务明确标历史", () => {
  const root = repo(),
    wt = delivered(root);
  success(run(root, "verify", "cancel-buy"));
  writeFileSync(join(root, "tasks/旧任务.md"), "# 旧任务\n\n> 状态：通过\n");
  const result = run(root, "status", "--short");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cancel-buy\s+待验收\s+未派发/);
  assert.match(result.stdout, /验证=通过/);
  assert.match(result.stdout, /历史/);
  writeFileSync(join(wt, "artifact.txt"), "changed");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "later");
  assert.match(run(root, "status", "cancel-buy", "--short").stdout, /验证=过期/);
});
test("子命令拒绝不适用参数，不能静默忽略", () => {
  const root = repo();
  ready(root);
  for (const args of [
    ["status", "--detach"],
    ["new", "other", "--title", "x", "--short"],
    ["dispatch", "cancel-buy", "--short"],
    ["resume", "cancel-buy", "--dry-run"],
  ]) {
    const r = run(root, ...args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不支持参数/);
  }
});

test("白名单越界给出相关提交与只读查看命令，不自动撤回", () => {
  const root = repo(),
    wt = delivered(root);
  writeFileSync(join(wt, "outside.txt"), "one");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "introduce outside");
  const first = git(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "outside.txt"), "two");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "modify outside");
  const second = git(wt, "rev-parse", "HEAD");
  const r = run(root, "verify", "cancel-buy");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside.txt/);
  assert.ok(r.stderr.includes(first));
  assert.ok(r.stderr.includes(second));
  assert.match(r.stderr, /查看：git/);
  assert.equal(git(wt, "rev-parse", "HEAD"), second);
  assert.equal(readFileSync(join(wt, "outside.txt"), "utf8"), "two");
});

test("rework 拒绝索引隐藏的未提交任务内容，不把用户半成品纳入返工提交", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const root = repo(),
      wt = delivered(root),
      head = git(wt, "rev-parse", "HEAD");
    git(wt, "update-index", flag, "tasks/cancel-buy.md");
    writeFileSync(taskPath(wt), readFileSync(taskPath(wt), "utf8") + "\n用户未提交备注\n");
    const r = run(root, "rework", "cancel-buy", "--message-file", reworkMessage(root));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /索引.*忽略/);
    assert.equal(git(wt, "rev-parse", "HEAD"), head);
    assert.match(readFileSync(taskPath(wt), "utf8"), /用户未提交备注/);
  }
});

test("verify 前置检查失败时短状态显示失败，不能把无提交的失败材料当过期", () => {
  const root = repo(),
    wt = delivered(root);
  success(run(root, "verify", "cancel-buy"));
  writeFileSync(join(wt, "uncommitted.txt"), "user changes");
  assert.equal(run(root, "verify", "cancel-buy").status, 1);
  const result = run(root, "status", "cancel-buy", "--short");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /验证=失败/);
});

test("任务树缺失时短状态注明调用树记录，验证不能冒充可对账状态", () => {
  const root = repo(),
    wt = delivered(root);
  success(run(root, "verify", "cancel-buy"));
  git(root, "worktree", "remove", wt);
  const result = run(root, "status", "cancel-buy", "--short");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /调用树记录/);
  assert.match(result.stdout, /树缺失/);
  assert.match(result.stdout, /验证=无法对账/);
});

test("无 task 配置时普通命令仍能运行，task 报接入提示", () => {
  const root = repo();
  writeFileSync(join(root, "nexus.config.json"), "{}");
  const wt = spawnSync(process.execPath, [cli, "worktree", "ls"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(wt.status, 0, wt.stderr);
  assert.match(run(root, "new", "sample", "--title", "示例").stderr, /缺少 task 段/);
});

test("任务树支持仓库同级目录，宿主共享项和安装钩子不进入任务树", () => {
  const root = repo();
  configure(root, (cfg) => {
    cfg.worktreeDir = null;
  });
  const file = join(root, "nexus.config.json"),
    cfg = JSON.parse(readFileSync(file, "utf8"));
  cfg.worktree.share = ["shared"];
  cfg.worktree.postCreate = [[process.execPath, "-e", "require('fs').writeFileSync('unexpected-install','bad')"]];
  writeFileSync(file, JSON.stringify(cfg));
  mkdirSync(join(root, "shared"));
  writeFileSync(join(root, "shared/input"), "original");
  writeFileSync(join(root, ".gitignore"), ".worktrees\nresearch/local\nshared\n");
  ready(root);
  const preview = success(run(root, "dispatch", "cancel-buy", "--dry-run"));
  assert.doesNotMatch(preview.prompt, /pnpm task/);
  const wt = success(run(root, "start", "cancel-buy", "--owner", "worker")).worktree;
  roots.push(dirname(wt));
  assert.equal(dirname(wt), root + "-worktrees");
  assert.equal(existsSync(join(wt, "shared")), false);
  assert.equal(existsSync(join(wt, "unexpected-install")), false);
  assert.equal(success(run(wt, "status", "cancel-buy")).tasks[0].status, "执行中");
  assert.equal(success(run(wt, "start", "cancel-buy", "--owner", "worker")).restored, true);
});

test("已验收任务保留正式依据，后续失败复跑和回收不冒充验收被撤销", () => {
  const root = repo(),
    wt = delivered(root),
    head = git(wt, "rev-parse", "HEAD");
  success(run(root, "verify", "cancel-buy"));
  const accepted = success(run(root, "accept", "cancel-buy", "--review", review(root, head)));
  assert.notEqual(run(root, "verify", "cancel-buy").status, 0);
  let row = success(run(root, "status", "cancel-buy")).tasks[0];
  assert.equal(row.verification.passed, false);
  assert.equal(row.acceptance.verifiedCommit, head);
  assert.equal(row.acceptance.matchesHead, true);
  git(root, "merge", "--ff-only", "task/cancel-buy");
  git(root, "worktree", "remove", wt);
  row = success(run(root, "status", "cancel-buy")).tasks[0];
  assert.equal(row.acceptance.integrated, true);
  assert.equal(row.acceptance.matchesHead, false);
  assert.equal(row.acceptance.acceptanceCommit, accepted.acceptanceCommit);
  assert.match(run(root, "status", "cancel-buy", "--short").stdout, /验收=已集成（历史）/);
  writeFileSync(accepted.receipt, readFileSync(accepted.receipt, "utf8") + " ");
  assert.match(run(root, "status", "cancel-buy", "--short").stdout, /验收=材料错误/);
});

test("旧快照版本拒绝继续运行，原定义材料保持原字节", () => {
  const root = repo();
  ready(root);
  success(run(root, "start", "cancel-buy", "--owner", "worker"));
  const file = join(root, "research/local/task-control/cancel-buy/definition.json"),
    value = JSON.parse(readFileSync(file, "utf8"));
  value.version = 1;
  const bytes = JSON.stringify(value);
  writeFileSync(file, bytes);
  assert.match(run(root, "resume", "cancel-buy").stderr, /快照版本不支持/);
  assert.equal(readFileSync(file, "utf8"), bytes);
});

test("正式验收材料损坏后依赖拒绝派发，旧快照的已集成验收仍可作前置", () => {
  const root = repo(),
    wt = delivered(root),
    head = git(wt, "rev-parse", "HEAD");
  success(run(root, "verify", "cancel-buy"));
  const accepted = success(run(root, "accept", "cancel-buy", "--review", review(root, head)));
  git(root, "merge", "--ff-only", "task/cancel-buy");
  git(root, "worktree", "remove", wt);
  const definition = join(root, "research/local/task-control/cancel-buy/definition.json"),
    v = JSON.parse(readFileSync(definition, "utf8"));
  v.version = 1;
  writeFileSync(definition, JSON.stringify(v));
  ready(root, "next-task");
  editTask(
    root,
    (s) => {
      s.dependencies = [{ id: "cancel-buy" }];
    },
    "next-task",
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "dependency on historical task");
  assert.equal(run(root, "dispatch", "next-task", "--dry-run").status, 0, "集成后的已验收前置不要求旧快照能运行");
  writeFileSync(accepted.receipt, readFileSync(accepted.receipt, "utf8") + " ");
  assert.match(run(root, "dispatch", "next-task", "--dry-run").stderr, /验收.*指纹变化/);
});

test("执行器成功交付后也回收忽略 TERM 的后代，返回后不存在活进程", async (t) => {
  const root = repo();
  ready(root);
  executorConfig(root);
  const fake = join(root, "executor.mjs"),
    pidfile = join(root, "research/local/child.pid");
  mkdirSync(dirname(pidfile), { recursive: true });
  writeFileSync(
    fake,
    `import{spawn,spawnSync}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();writeFileSync(${JSON.stringify(pidfile)},String(c.pid));const r=spawnSync(process.execPath,[${JSON.stringify(executor)},...process.argv.slice(2)],{stdio:'inherit',env:process.env});process.exit(r.status);`,
  );
  configure(root, (c) => {
    c.executors.agy.command = [process.execPath, fake];
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "executor with descendant");
  const r = run(root, "dispatch", "cancel-buy");
  const pid = Number(readFileSync(pidfile, "utf8"));
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("进度采样失败会终止执行器并留下失败收尾，不能丢下 running 记录", async (t) => {
  const root = repo();
  ready(root);
  executorConfig(root);
  configure(root, (c) => {
    c.progressMinutes = 0.001;
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "fast progress");
  const wt = success(run(root, "start", "cancel-buy", "--owner", "test")).worktree;
  const launch = success(detachedScenario(root, "sleep", "dispatch", "cancel-buy"));
  const gitfile = join(wt, ".git"),
    original = readFileSync(gitfile, "utf8");
  writeFileSync(gitfile, "gitdir: /tmp/nonexistent-nexus-progress-test\n");
  t.after(() => {
    if (existsSync(gitfile)) writeFileSync(gitfile, original);
  });
  // 树的 .git 已写坏，status 读不了，直接轮询运行记录；固定等待在机器繁忙时会先于监督进程收尾
  let info;
  for (let n = 0; n < 250; n++) {
    info = JSON.parse(readFileSync(join(launch.runDir, "run.json"), "utf8"));
    if (info.endedAt) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  t.after(() => {
    try {
      if (info.executorPid) process.kill(-info.executorPid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  });
  assert.ok(info.endedAt, "失败必须留下结束时间");
  assert.equal(info.state, "failed");
  assert.match(info.error, /git|Command failed/);
  assert.throws(() => process.kill(info.executorPid, 0), { code: "ESRCH" });
});

test("状态和前置判断都检查正式验收的日志与产物，最近验证也不能掩盖材料损坏", () => {
  for (const kind of ["log", "output"]) {
    const root = repo(),
      wt = delivered(root),
      head = git(wt, "rev-parse", "HEAD");
    const verified = success(run(root, "verify", "cancel-buy"));
    const path = kind === "log" ? verified.commands[0].stdout : join(verified.output, "0/result.txt");
    writeFileSync(path, readFileSync(path, "utf8") + "changed");
    assert.match(run(root, "status", "cancel-buy", "--short").stdout, /验证=材料错误/);
    assert.match(run(root, "accept", "cancel-buy", "--review", review(root, head)).stderr, /指纹变化/);
    const fresh = success(run(root, "verify", "cancel-buy"));
    success(run(root, "accept", "cancel-buy", "--review", review(root, head)));
    const acceptedPath = kind === "log" ? fresh.commands[0].stdout : join(fresh.output, "0/result.txt");
    writeFileSync(acceptedPath, "tampered");
    assert.match(run(root, "status", "cancel-buy", "--short").stdout, /验收=材料错误/);
    ready(root, "next-task");
    editTask(
      root,
      (s) => {
        s.dependencies = [{ id: "cancel-buy" }];
      },
      "next-task",
    );
    git(root, "add", ".");
    git(root, "commit", "-m", "invalid dependency materials");
    assert.match(run(root, "dispatch", "next-task", "--dry-run").stderr, /指纹变化/);
  }
});

test("前置树索引隐藏的未提交内容不能借已验收 HEAD 绕过派发检查", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const root = repo(),
      wt = delivered(root),
      head = git(wt, "rev-parse", "HEAD");
    success(run(root, "verify", "cancel-buy"));
    success(run(root, "accept", "cancel-buy", "--review", review(root, head)));
    ready(root, "next-task");
    editTask(
      root,
      (s) => {
        s.dependencies = [{ id: "cancel-buy" }];
      },
      "next-task",
    );
    git(root, "add", ".");
    git(root, "commit", "-m", "dependency");
    git(wt, "update-index", flag, "artifact.txt");
    writeFileSync(join(wt, "artifact.txt"), "not committed");
    const result = run(root, "dispatch", "next-task", "--dry-run");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /索引.*忽略/);
  }
});

// 主仓审计通过公开 CLI 覆盖，不把任务树白名单当成主仓隔离。
for (const kind of ["working", "staged", "assume-unchanged", "skip-worktree"]) {
  test(`主仓审计：verify 拒绝 ${kind}，不清理现场`, () => {
    const root = repo();
    delivered(root);
    writeFileSync(join(root, ".gitignore"), "changed-main");
    if (kind === "staged") git(root, "add", ".gitignore");
    if (kind === "assume-unchanged" || kind === "skip-worktree") git(root, "update-index", `--${kind}`, ".gitignore");
    const result = run(root, "verify", "cancel-buy");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /主仓/);
    assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "changed-main");
  });
}
for (const command of ["dispatch", "resume"]) {
  test(`主仓审计：${command} 启动前拒绝主仓受跟踪改动`, () => {
    const root = repo();
    ready(root);
    executorConfig(root);
    if (command === "resume") success(run(root, "start", "cancel-buy", "--owner", "fixture"));
    writeFileSync(join(root, ".gitignore"), "dirty-main");
    const result = run(root, command, "cancel-buy", ...(command === "resume" ? ["--conversation", "fixture-session"] : []));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /主仓/);
  });
}
function mainAuditFiles(root) {
  const dir = join(root, "research/local/task-control/cancel-buy/main-audit");
  return {
    dir,
    files: existsSync(dir) ? readdirSync(dir).filter((p) => p.endsWith(".json")) : [],
  };
}
function mainReview(root) {
  const { dir, files } = mainAuditFiles(root);
  const incidents = files
    .filter((file) => !JSON.parse(readFileSync(join(dir, file))).passed)
    .map((id) => ({
      id,
      sha256: cryptoHash("sha256")
        .update(readFileSync(join(dir, id)))
        .digest("hex"),
    }));
  const file = join(root, "main-review.json");
  writeFileSync(
    file,
    JSON.stringify({
      reviewer: "coordinator",
      reason: "核对主仓改动，确认内容保留",
      incidents,
    }),
  );
  return file;
}
for (const scenario of ["main-write", "main-amend", "main-child-write"]) {
  test(`主仓审计：执行 ${scenario} 留证，后续提交不能抹去，核对后可保留内容`, async () => {
    const root = repo();
    ready(root);
    executorConfig(root);
    success(detachedScenario(root, scenario, "dispatch", "cancel-buy"));
    const done = await finished(root);
    assert.equal(done.run.state, "failed");
    assert.match(done.run.error, /主仓/);
    if (scenario !== "main-amend") {
      git(root, "add", ".gitignore");
      git(root, "commit", "-m", "coordinator registration includes contamination");
    }
    assert.equal(git(root, "status", "--porcelain"), "");
    const rejected = run(root, "verify", "cancel-buy");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /主仓.*审计/);
    const { dir, files } = mainAuditFiles(root);
    assert.equal(files.length, 1);
    const evidence = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    assert.equal(evidence.passed, false);
    assert.ok(evidence.paths.includes(".gitignore"));
    const record = mainReview(root);
    const invalid = JSON.parse(readFileSync(record));
    invalid.incidents[0].sha256 = "0".repeat(64);
    writeFileSync(record, JSON.stringify(invalid));
    assert.notEqual(run(root, "verify", "cancel-buy", "--main-review", record).status, 0);
    const verified = success(run(root, "verify", "cancel-buy", "--main-review", mainReview(root)));
    assert.equal(verified.passed, true);
    assert.equal(JSON.parse(readFileSync(join(dir, files[0]), "utf8")).passed, false);
    const head = git(join(root, ".worktrees/cancel-buy"), "rev-parse", "HEAD");
    success(run(root, "accept", "cancel-buy", "--review", review(root, head)));
  });
}
test("主仓审计：验证命令修改主仓并提交也拒绝，恢复干净仍保留异常", () => {
  const root = repo();
  ready(root);
  editTask(root, (s) => {
    s.verify[0].argv = [
      process.execPath,
      "-e",
      `const fs=require('fs'),cp=require('child_process');fs.appendFileSync(${JSON.stringify(join(root, ".gitignore"))}, '# verify wrote main\\n');cp.execFileSync('git',['add','.gitignore'],{cwd:${JSON.stringify(root)}});cp.execFileSync('git',['commit','-m','verify contamination'],{cwd:${JSON.stringify(root)}});`,
    ];
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "verify setup");
  success(run(root, "start", "cancel-buy", "--owner", "fixture"));
  const wt = join(root, ".worktrees/cancel-buy");
  writeFileSync(join(wt, "artifact.txt"), "cancel-ok");
  writeFileSync(taskPath(wt), readFileSync(taskPath(wt), "utf8").replace(/^> 状态：.*$/m, "> 状态：待验收"));
  git(wt, "add", ".");
  git(wt, "commit", "-m", "delivery");
  const result = run(root, "verify", "cancel-buy");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /主仓/);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.notEqual(run(root, "verify", "cancel-buy").status, 0);
});
test("主仓审计：验收拒绝验证后的主仓改动，未跟踪核对文件允许存在", () => {
  const root = repo(),
    wt = delivered(root);
  success(run(root, "verify", "cancel-buy"));
  const record = review(root, git(wt, "rev-parse", "HEAD"));
  writeFileSync(join(root, ".gitignore"), "changed after verify");
  const result = run(root, "accept", "cancel-buy", "--review", record);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /主仓/);
  git(root, "checkout", "--", ".gitignore");
  success(run(root, "accept", "cancel-buy", "--review", record));
});

test("主仓审计：resume 越权也留证，核对不得绕过未恢复的主仓现场", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(detachedScenario(root, "blocked", "dispatch", "cancel-buy"));
  await finished(root);
  success(detachedScenario(root, "main-write", "resume", "cancel-buy"));
  const done = await finished(root);
  assert.equal(done.run.state, "failed");
  assert.match(done.run.error, /主仓/);
  assert.notEqual(run(root, "verify", "cancel-buy", "--main-review", mainReview(root)).status, 0);
  git(root, "checkout", "--", ".gitignore");
  success(run(root, "verify", "cancel-buy", "--main-review", mainReview(root)));
});
test("主仓审计：通过材料绑定审计和核对记录指纹，删除审计不能验收", () => {
  const root = repo(),
    wt = delivered(root);
  const verified = success(run(root, "verify", "cancel-buy"));
  assert.ok(verified.mainAudits.length > 0);
  const audit = verified.mainAudits[0];
  rmSync(audit.file);
  const result = run(root, "accept", "cancel-buy", "--review", review(root, git(wt, "rev-parse", "HEAD")));
  assert.notEqual(result.status, 0);
});
test("主仓审计：只暂存和带换行路径的改动按路径记录", async () => {
  const root = repo();
  const path = "special\ntracked.txt";
  writeFileSync(join(root, path), "old");
  git(root, "add", ".");
  git(root, "commit", "-m", "special path");
  ready(root);
  executorConfig(root);
  const launched = success(detachedScenario(root, "slow-delivery", "dispatch", "cancel-buy"));
  writeFileSync(join(root, path), "new");
  git(root, "add", "--", path);
  writeFileSync(join(root, path), "old");
  const done = await finished(root);
  assert.equal(done.run.state, "failed");
  const { dir, files } = mainAuditFiles(root);
  assert.ok(files.some((id) => JSON.parse(readFileSync(join(dir, id))).paths?.includes(path)));
  assert.ok(existsSync(join(launched.runDir, "run.json")));
});

test("主仓审计：删除复跑异常不能把下一次验证变成无异常", () => {
  const root = repo();
  ready(root);
  editTask(root, (s) => {
    const marker = join(root, "research/local/verify-once");
    s.verify[0].argv = [
      process.execPath,
      "-e",
      `const fs=require('fs'),cp=require('child_process');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'once');fs.appendFileSync(${JSON.stringify(join(root, ".gitignore"))},'# verify wrote main\\n');cp.execFileSync('git',['add','.gitignore'],{cwd:${JSON.stringify(root)}});cp.execFileSync('git',['commit','-m','main write'],{cwd:${JSON.stringify(root)}})}`,
    ];
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "one-time verifier");
  success(run(root, "start", "cancel-buy", "--owner", "fixture"));
  const wt = join(root, ".worktrees/cancel-buy");
  writeFileSync(join(wt, "artifact.txt"), "cancel-ok");
  writeFileSync(taskPath(wt), readFileSync(taskPath(wt), "utf8").replace(/^> 状态：.*$/m, "> 状态：待验收"));
  git(wt, "add", ".");
  git(wt, "commit", "-m", "delivery");
  assert.notEqual(run(root, "verify", "cancel-buy").status, 0);
  const { dir, files } = mainAuditFiles(root);
  assert.equal(files.length, 1);
  rmSync(join(dir, files[0]));
  const result = run(root, "verify", "cancel-buy");
  assert.notEqual(result.status, 0, "删除异常不应解除验收门禁");
});
test("主仓审计：已核对记录不能被后续拒绝的 verify 覆盖", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(detachedScenario(root, "main-amend", "dispatch", "cancel-buy"));
  await finished(root);
  const mainRecord = mainReview(root);
  const verified = success(run(root, "verify", "cancel-buy", "--main-review", mainRecord));
  const wt = join(root, ".worktrees/cancel-buy");
  success(run(root, "accept", "cancel-buy", "--review", review(root, git(wt, "rev-parse", "HEAD"))));
  const bound = verified.mainAudits.find((entry) => entry.file.includes("/reviews/"));
  const original = readFileSync(bound.file, "utf8");
  const changed = JSON.parse(readFileSync(mainRecord, "utf8"));
  changed.reason = "different reason";
  writeFileSync(mainRecord, JSON.stringify(changed));
  assert.notEqual(run(root, "verify", "cancel-buy", "--main-review", mainRecord).status, 0);
  assert.equal(readFileSync(bound.file, "utf8"), original, "正式验收引用的核对记录不能被覆盖");
  assert.equal(success(run(root, "status", "cancel-buy")).tasks[0].acceptance.passed, true);
});

test("主仓审计：执行期间主仓快进的新提交只提醒并列出提交，复跑无需核对", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(detachedScenario(root, "slow-delivery", "dispatch", "cancel-buy"));
  // 协调者在任务运行期间合入另一个任务的成果。
  writeFileSync(join(root, "merged.txt"), "other task");
  git(root, "add", "merged.txt");
  git(root, "commit", "-m", "merge other task");
  const merged = git(root, "rev-parse", "HEAD");
  const done = await finished(root);
  assert.equal(done.run.state, "completed");
  assert.match(done.run.mainWarning, new RegExp(merged));
  assert.match(done.run.mainWarning, /merge other task/);
  assert.match(run(root, "status", "--short").stdout, /completed（主仓新提交）/);
  assert.equal(success(run(root, "verify", "cancel-buy")).passed, true);
  // 执行者自己往主仓提交同样只提醒：这是放宽审计的已知代价，提交记录本身留证。
  const own = repo();
  ready(own);
  executorConfig(own);
  success(detachedScenario(own, "main-commit", "dispatch", "cancel-buy"));
  const ownDone = await finished(own);
  assert.equal(ownDone.run.state, "completed");
  assert.match(ownDone.run.mainWarning, /main contamination/);
});

test("硬期限中断记录排在执行器后代收尾之后，不与残留进程抢写任务树", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  configure(root, (cfg) => {
    cfg.hardTimeoutMinutes = 0.04;
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "hard limit");
  success(detachedScenario(root, "late-child-commit", "dispatch", "cancel-buy"));
  const done = await finished(root);
  assert.equal(done.run.state, "interrupted");
  assert.equal(done.run.recordError, undefined);
  const wt = join(root, ".worktrees/cancel-buy");
  assert.equal(git(wt, "log", "-2", "--format=%s"), "记录中断：cancel-buy\nlate child");
  assert.match(readFileSync(taskPath(wt), "utf8"), /> 状态：中断/);
});

test("未跟踪且未被 Git 忽略的输入拒绝派发；加入忽略后复制进任务树也能通过复跑", () => {
  const root = repo();
  ready(root);
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data/in.txt"), "raw");
  editTask(root, (s) => {
    s.inputs = [
      {
        path: "data/in.txt",
        sha256: cryptoHash("sha256").update("raw").digest("hex"),
      },
    ];
  });
  git(root, "add", "tasks");
  git(root, "commit", "-m", "untracked input");
  const rejected = run(root, "dispatch", "cancel-buy", "--dry-run");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /data\/in\.txt.*忽略/);
  writeFileSync(join(root, ".gitignore"), readFileSync(join(root, ".gitignore"), "utf8") + "data\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore input");
  const started = success(run(root, "start", "cancel-buy", "--owner", "执行者"));
  const wt = started.worktree;
  assert.equal(readFileSync(join(wt, "data/in.txt"), "utf8"), "raw");
  writeFileSync(join(wt, "artifact.txt"), "cancel-ok");
  writeFileSync(taskPath(wt), readFileSync(taskPath(wt), "utf8").replace(/^> 状态：.*$/m, "> 状态：待验收"));
  git(wt, "add", "tasks", "artifact.txt");
  git(wt, "commit", "-m", "delivery");
  assert.equal(success(run(root, "verify", "cancel-buy")).passed, true);
});

test("status 单个任务现场异常只标该任务，其余任务照常显示", () => {
  const root = repo();
  ready(root);
  ready(root, "other-task");
  success(run(root, "start", "cancel-buy", "--owner", "执行者"));
  git(join(root, ".worktrees/cancel-buy"), "checkout", "-b", "wrong");
  const all = success(run(root, "status"));
  assert.match(all.tasks.find((t) => t.id === "cancel-buy").error, /分支/);
  assert.equal(all.tasks.find((t) => t.id === "other-task").status, "待认领");
  const short = run(root, "status", "--short");
  assert.equal(short.status, 0, short.stderr);
  assert.match(short.stdout, /cancel-buy\t错误：.*分支/);
  assert.match(short.stdout, /other-task\t待认领/);
  writeFileSync(taskPath(root, "other-task"), readFileSync(taskPath(root, "other-task"), "utf8").replace('"version": 1', '"version": 9'));
  const broken = success(run(root, "status"));
  assert.match(broken.tasks.find((t) => t.id === "other-task").error, /version/);
});

test("时间配置超过定时器上限时拒绝，不会让执行器一启动就被杀", () => {
  const root = repo();
  ready(root);
  configure(root, (cfg) => {
    cfg.hardTimeoutMinutes = 40000;
  });
  const config = run(root, "dispatch", "cancel-buy", "--dry-run");
  assert.notEqual(config.status, 0);
  assert.match(config.stderr, /hardTimeoutMinutes.*35791/);
  configure(root, (cfg) => {
    cfg.hardTimeoutMinutes = 0;
  });
  editTask(root, (s) => {
    s.execution = { budgetMinutes: 40000 };
  });
  assert.match(run(root, "dispatch", "cancel-buy", "--dry-run").stderr, /budgetMinutes.*35791/);
  editTask(root, (s) => {
    delete s.execution;
    s.verify[0].timeoutSeconds = 3_000_000;
  });
  assert.match(run(root, "dispatch", "cancel-buy", "--dry-run").stderr, /验证期限.*2147483/);
});

test("残锁报错给出锁路径和清理条件", () => {
  const root = repo();
  ready(root);
  const lock = join(root, "research/local/task-control/cancel-buy/operation.lock");
  mkdirSync(lock, { recursive: true });
  const result = run(root, "start", "cancel-buy", "--owner", "执行者");
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(lock), result.stderr);
  assert.match(result.stderr, /没有.*进程.*删除/);
});

test("status 按配置排除规则文件，不写死规则文件名", () => {
  const root = repo();
  ready(root);
  git(root, "mv", "tasks/协作规则.md", "tasks/规则.md");
  configure(root, (cfg) => {
    cfg.rules = ["tasks/规则.md"];
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "rename rules");
  const tasks = success(run(root, "status")).tasks;
  assert.deepEqual(
    tasks.map((t) => t.task),
    ["tasks/cancel-buy.md"],
  );
});

test("默认 quotepath 下中文规则与已提交的中文输入照常派发；只暂存未提交的输入拒绝", () => {
  const root = repo();
  ready(root);
  writeFileSync(join(root, "需求输入.txt"), "raw");
  writeFileSync(join(root, "staged-only.txt"), "raw");
  editTask(root, (s) => {
    s.inputs = [
      {
        path: "需求输入.txt",
        sha256: cryptoHash("sha256").update("raw").digest("hex"),
      },
    ];
  });
  git(root, "add", ".");
  git(root, "reset", "-q", "--", "staged-only.txt");
  git(root, "commit", "-m", "chinese input");
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.quotepath",
    GIT_CONFIG_VALUE_0: "true",
  };
  const quoted = (...args) =>
    spawnSync(process.execPath, [cli, "task", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env,
    });
  success(quoted("dispatch", "cancel-buy", "--dry-run"));
  editTask(root, (s) => {
    s.inputs = [
      {
        path: "staged-only.txt",
        sha256: cryptoHash("sha256").update("raw").digest("hex"),
      },
    ];
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "staged input", "--", "tasks");
  git(root, "add", "staged-only.txt");
  const staged = quoted("dispatch", "cancel-buy", "--dry-run");
  assert.notEqual(staged.status, 0);
  assert.match(staged.stderr, /staged-only\.txt.*忽略/);
});

test("status 指定任务读取失败时退出非零，列表模式仍降级显示", () => {
  const root = repo();
  ready(root);
  const missing = run(root, "status", "no-such-task");
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).tasks[0].error, /ENOENT|no-such-task/);
  success(run(root, "status"));
});

test("快进提醒清洗提交标题里的控制字符，验收输出带出执行期间的主仓提醒", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(detachedScenario(root, "slow-delivery", "dispatch", "cancel-buy"));
  writeFileSync(join(root, "merged.txt"), "other task");
  git(root, "add", "merged.txt");
  git(root, "commit", "-m", "merge \u001b[31mred");
  const done = await finished(root);
  assert.equal(done.run.state, "completed");
  assert.equal(done.run.mainWarning.includes("\u001b"), false);
  assert.equal(done.run.baseWarning, undefined);
  success(run(root, "verify", "cancel-buy"));
  const wt = join(root, ".worktrees/cancel-buy");
  const accepted = run(root, "accept", "cancel-buy", "--review", review(root, git(wt, "rev-parse", "HEAD")));
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(JSON.parse(accepted.stdout).mainWarnings[0], /merge/);
  assert.match(accepted.stderr, /主仓.*新提交/);
});

function fingerprintDiagnostic(result, label) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, label);
  assert.match(result.stderr, /期望 SHA-256 [a-f0-9]{64}；实际 SHA-256 [a-f0-9]{64}/);
}
test("指纹诊断覆盖公共规则、后端配置、验证材料、两路日志、产物和审计", () => {
  for (const kind of ["rule", "config", "receipt", "stdout", "stderr", "output", "audit"]) {
    const root = repo(),
      wt = delivered(root),
      head = git(wt, "rev-parse", "HEAD");
    if (kind === "rule" || kind === "config") {
      const path = join(wt, kind === "rule" ? "tasks/协作规则.md" : "nexus.config.json");
      writeFileSync(path, readFileSync(path, "utf8") + "\n");
      fingerprintDiagnostic(run(root, "verify", "cancel-buy"), kind === "rule" ? /公共规则已变化/ : /后端配置已变化/);
      continue;
    }
    const verified = success(run(root, "verify", "cancel-buy"));
    const path =
      kind === "receipt"
        ? verified.receipt
        : kind === "output"
          ? join(verified.output, "0/result.txt")
          : kind === "audit"
            ? verified.mainAudits[0].file
            : verified.commands[0][kind];
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    fingerprintDiagnostic(run(root, "accept", "cancel-buy", "--review", review(root, head)), /指纹变化/);
  }
});

test("待验收拒绝派发和续跑时给出返工登记及续跑步骤，不改任务现场", () => {
  const root = repo(),
    wt = delivered(root),
    before = git(wt, "rev-parse", "HEAD");
  for (const args of [
    ["dispatch", "cancel-buy"],
    ["resume", "cancel-buy"],
    ["resume", "cancel-buy", "--conversation", "fixture-session"],
    ["resume", "cancel-buy", "--conversation", "fixture-session", "--refresh-definition"],
  ]) {
    const rejected = run(args.includes("--refresh-definition") ? wt : root, ...args);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /待验收/);
    assert.match(rejected.stderr, /task rework cancel-buy --message-file/);
    assert.match(rejected.stderr, /task resume cancel-buy/);
    assert.match(rejected.stderr, /defects.*reproduce.*criteria/);
    assert.equal(git(wt, "rev-parse", "HEAD"), before);
  }
});

function assertBaseWarning(result, base, mainHead) {
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.ok(result.stderr.includes(base), result.stderr);
  assert.ok(result.stderr.includes(mainHead), result.stderr);
  assert.match(result.stderr, /固定起点.*不是主仓 HEAD.*祖先/);
  assert.match(result.stderr, /原任务工作树.*变基.*refresh-definition/);
  assert.match(result.stderr, /待验收.*task rework cancel-buy --message-file.*基准/);
  assert.match(info.baseWarning, /固定起点/);
  return info;
}
test("主仓在交付后 amend，verify 与 accept 告警但保留有效交付和固定起点", () => {
  const root = repo(),
    wt = delivered(root),
    taskHead = git(wt, "rev-parse", "HEAD"),
    base = git(root, "rev-parse", "HEAD");
  git(root, "commit", "--amend", "-m", "rewritten main");
  const mainHead = git(root, "rev-parse", "HEAD");
  const verified = assertBaseWarning(run(root, "verify", "cancel-buy"), base, mainHead);
  assert.equal(verified.passed, true);
  assert.equal(git(wt, "rev-parse", "HEAD"), taskHead);
  const accepted = assertBaseWarning(run(root, "accept", "cancel-buy", "--review", review(root, taskHead)), base, mainHead);
  assert.equal(accepted.status, "通过");
  assert.equal(success(run(root, "status", "cancel-buy")).tasks[0].acceptance.passed, true);
  assert.equal(git(root, "rev-parse", "HEAD"), mainHead);
  assert.equal(JSON.parse(readFileSync(join(root, "research/local/task-control/cancel-buy/definition.json"), "utf8")).base, base);
});

test("派发预览、分离派发和原会话续跑都提示已改写的主仓起点", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  const started = success(run(root, "start", "cancel-buy", "--owner", "executor")),
    base = started.base;
  git(root, "commit", "--amend", "-m", "rewritten before dispatch");
  const mainHead = git(root, "rev-parse", "HEAD");
  assertBaseWarning(run(root, "dispatch", "cancel-buy", "--dry-run"), base, mainHead);
  const first = assertBaseWarning(detachedScenario(root, "complete", "dispatch", "cancel-buy"), base, mainHead);
  const done = await finished(root);
  assert.equal(done.run.state, "completed");
  assert.equal(done.run.baseWarning, first.baseWarning);
  success(run(root, "rework", "cancel-buy", "--message-file", reworkMessage(root)));
  const resumed = assertBaseWarning(await asyncRun(root, "complete", "resume", "cancel-buy").result, base, mainHead);
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.conversationId, done.run.conversationId);
  assert.equal(JSON.parse(readFileSync(join(root, "research/local/task-control/cancel-buy/definition.json"), "utf8")).base, base);
  success(run(root, "rework", "cancel-buy", "--message-file", reworkMessage(root)));
  git(started.worktree, "rebase", "--onto", "main", base);
  const refreshed = success(await asyncRun(started.worktree, "complete", "resume", "cancel-buy", "--refresh-definition").result);
  assert.equal(refreshed.baseWarning, undefined);
  assert.equal(JSON.parse(readFileSync(join(root, "research/local/task-control/cancel-buy/definition.json"), "utf8")).base, mainHead);
});

test("命令替换的分离派发不持有调用方管道，默认派发仍等待最终交付", async () => {
  const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  for (const detach of [true, false]) {
    const root = repo();
    ready(root);
    executorConfig(root);
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        `result=$(${quote(process.execPath)} ${quote(cli)} task dispatch cancel-buy ${detach ? "--detach" : ""}); printf '%s\\n' "$result"`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, TASK_TEST_SCENARIO: "slow-delivery" },
      },
    );
    const info = success(result);
    if (detach) {
      assert.equal(info.state, "starting");
      assert.ok(["starting", "running"].includes(success(run(root, "status", "cancel-buy")).tasks[0].run.state));
      assert.equal((await finished(root)).run.state, "completed");
    } else assert.equal(info.state, "completed");
  }
});

test("起点对应 Git 对象缺失时拒绝派发预览，不把检查失败当作没有告警", () => {
  const root = repo();
  ready(root);
  success(run(root, "start", "cancel-buy", "--owner", "executor"));
  const path = join(root, "research/local/task-control/cancel-buy/definition.json"),
    snapshot = JSON.parse(readFileSync(path, "utf8"));
  snapshot.base = "0".repeat(40);
  writeFileSync(path, JSON.stringify(snapshot));
  const failed = run(root, "dispatch", "cancel-buy", "--dry-run");
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /无法核对任务固定起点/);
});

test("任务定义返工并重新确认后，旧验证材料报出新旧定义指纹", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(await asyncRun(root, "complete", "dispatch", "cancel-buy").result);
  const wt = join(root, ".worktrees/cancel-buy"),
    verified = success(run(root, "verify", "cancel-buy"));
  success(run(root, "rework", "cancel-buy", "--message-file", reworkMessage(root)));
  editTask(wt, (spec) => {
    spec.goal = "取消后余额和库存都保持不变";
  });
  git(wt, "add", "tasks/cancel-buy.md");
  git(wt, "commit", "-m", "clarify definition");
  success(await asyncRun(wt, "complete", "resume", "cancel-buy", "--refresh-definition").result);
  const snapshot = JSON.parse(readFileSync(join(root, "research/local/task-control/cancel-buy/definition.json"), "utf8"));
  const rejected = run(root, "accept", "cancel-buy", "--review", review(root, git(wt, "rev-parse", "HEAD")));
  fingerprintDiagnostic(rejected, /定义不匹配/);
  assert.ok(rejected.stderr.includes("期望 SHA-256 " + snapshot.definition), rejected.stderr);
  assert.ok(rejected.stderr.includes("实际 SHA-256 " + verified.definition), rejected.stderr);
});

test("本地实践：计划停等有分类与流水，原会话续跑后交付", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  const watching = asyncRun(root, "none", "watch", "cancel-buy", "--poll-ms", "10", "--timeout-minutes", "0.2");
  const stopped = await asyncRun(root, "plan-stop", "dispatch", "cancel-buy").result;
  const observed = await watching.result;
  assert.equal(observed.status, 0, observed.stderr);
  assert.match(observed.stdout, /needs_approval/);
  assert.equal(stopped.status, 1, stopped.stderr);
  const info = JSON.parse(stopped.stdout);
  assert.equal(info.state, "failed");
  assert.equal(info.exitCode, 0);
  assert.equal(info.endReason, "needs_approval");
  assert.equal(success(run(root, "status", "cancel-buy")).tasks[0].run.endReason, "needs_approval");
  const log = join(root, "research/local/task-control/cancel-buy/notify.log");
  assert.match(readFileSync(log, "utf8"), /needs_approval/);
  const tree = join(root, ".worktrees/cancel-buy");
  const before = git(tree, "rev-parse", "HEAD");
  const resumed = success(await asyncRun(root, "complete", "resume", "cancel-buy").result);
  assert.equal(resumed.conversationId, "fixture-session");
  assert.equal(resumed.state, "completed");
  assert.notEqual(git(tree, "rev-parse", "HEAD"), before);
  assert.match(readFileSync(log, "utf8"), /delivered/);
});

test("本地实践：派发写清已批准范围，续跑不再停在同一计划确认，短状态指出停等", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  const preview = success(run(root, "dispatch", "cancel-buy", "--dry-run"));
  assert.match(preview.prompt, /已批准.*范围/);
  assert.match(preview.prompt, /不要结束回合等待.*批准/);
  assert.match(preview.prompt, /扩.*范围/);
  const stopped = await asyncRun(root, "plan-stop", "dispatch", "cancel-buy").result;
  assert.equal(stopped.status, 1);
  assert.match(run(root, "status", "cancel-buy", "--short").stdout, /needs_approval/);
  const resumed = success(await asyncRun(root, "complete", "resume", "cancel-buy").result);
  assert.match(readFileSync(join(resumed.runDir, "prompt.txt"), "utf8"), /上次.*计划确认/);
});

test("本地实践：结束分类覆盖英文、真失败、受阻和成功回复中的计划字样", async () => {
  for (const [scenario, reason, exit] of [
    ["plan-english", "needs_approval", 1],
    ["plan-nonzero", "failed", 1],
    ["ordinary-no-delivery", "failed", 1],
    ["blocked", "blocked", 3],
    ["complete-mentions-plan", "delivered", 0],
    ["fail", "failed", 1],
  ]) {
    const root = repo();
    ready(root);
    executorConfig(root);
    const r = await asyncRun(root, scenario, "dispatch", "cancel-buy").result;
    assert.equal(r.status, exit, r.stderr);
    const info = JSON.parse(r.stdout);
    assert.equal(info.endReason, reason, scenario);
    const rows = readFileSync(join(root, "research/local/task-control/cancel-buy/notify.log"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, reason);
  }
});
test("本地实践：流水不可写或是软链会留诊断，不能伪造交付失败或改写目标", async () => {
  for (const scenario of ["log-directory", "log-symlink", "log-fifo"]) {
    const root = repo();
    ready(root);
    executorConfig(root);
    const r = await asyncRun(root, scenario, "dispatch", "cancel-buy").result;
    const info = success(r);
    assert.equal(info.state, "completed");
    assert.equal(info.endReason, "delivered");
    assert.ok(info.notificationError);
    assert.match(r.stderr, /流水写入失败/);
    if (scenario === "log-symlink") assert.equal(readFileSync(join(root, "research/local/protected.log"), "utf8"), "protected");
  }
});

test("本地实践：任务模板给接手模型列出背景、授权、步骤和逐项证据要求", () => {
  const root = repo();
  success(run(root, "new", "cancel-buy", "--title", "取消购买核验"));
  const body = readFileSync(taskPath(root), "utf8");
  for (const section of ["背景与证据", "已批准计划与授权", "输入与操作步骤", "验收清单", "交付物与失败处理"])
    assert.ok(body.includes("## " + section), section);
  assert.match(body, /预期结果/);
  assert.match(body, /负例/);
  assert.match(body, /不得.*猜测.*事实/);
});

// ---- 执行器接口：opencode 适配器、任务级执行器与派发级模型覆盖 ----

function defaultOpencode(root) {
  opencodeConfig(root);
  configure(root, (cfg) => {
    cfg.executor = "opencode";
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "default opencode");
}

test("opencode 执行器完整交付，登记执行器、会话与最终回复", async () => {
  const root = repo();
  ready(root);
  defaultOpencode(root);
  const preview = success(run(root, "dispatch", "cancel-buy", "--dry-run"));
  assert.equal(preview.executor, "opencode");
  assert.equal(preview.model, "opencode/test-model");
  assert.match(preview.prompt, /--owner opencode/);
  const done = success(await asyncRun(root, "complete", "dispatch", "cancel-buy").result);
  assert.equal(done.state, "completed");
  assert.equal(done.executor, "opencode");
  assert.equal(done.conversationId, "ses-fixture-session");
  assert.equal(done.result.response, "delivered");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("opencode 失败后按原会话续跑，现场不重建", async () => {
  const root = repo();
  ready(root);
  defaultOpencode(root);
  const failed = JSON.parse((await asyncRun(root, "fail", "dispatch", "cancel-buy").result).stdout);
  assert.equal(failed.state, "failed");
  assert.equal(failed.exitCode, 7);
  const resumed = success(await asyncRun(root, "complete", "resume", "cancel-buy", "--conversation", "ses-fixture-session").result);
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.resume, true);
  assert.equal(resumed.conversationId, "ses-fixture-session");
  assert.match(readFileSync(resumed.stdout, "utf8"), /resumed/);
});

test("opencode 从输出流提前登记会话，未知格式回退最终输出", async () => {
  const root = repo();
  ready(root);
  defaultOpencode(root);
  const execution = asyncRun(root, "early-session", "dispatch", "cancel-buy");
  const t = await until(root, (t) => t.run?.conversationId);
  assert.equal(t.run.state, "running");
  assert.equal(t.run.conversationId, "ses-early-fixture-session");
  const ended = await execution.result;
  assert.equal(ended.status, 1);
  assert.equal(JSON.parse(ended.stdout).conversationId, "ses-early-fixture-session");
  const resumed = success(await asyncRun(root, "early-resume", "resume", "cancel-buy").result);
  assert.equal(resumed.conversationId, "ses-early-fixture-session");
  assert.equal(resumed.sessionSource, "startup-log");
  const fallback = repo();
  ready(fallback);
  defaultOpencode(fallback);
  const r = await asyncRun(fallback, "unknown-log", "dispatch", "cancel-buy").result;
  const result = JSON.parse(r.stdout);
  assert.equal(r.status, 0);
  assert.equal(result.conversationId, "ses-fixture-session");
  // opencode 的会话日志就是标准输出本身，最终事件行同样被扫描器认出，不存在回退路径。
  assert.equal(result.sessionSource, "startup-log");
  assert.equal(result.sessionWarning, undefined);
});

test("opencode 停在计划确认时按回复文本分类，续跑后交付", async () => {
  const root = repo();
  ready(root);
  defaultOpencode(root);
  const stopped = JSON.parse((await asyncRun(root, "plan-stop", "dispatch", "cancel-buy").result).stdout);
  assert.equal(stopped.endReason, "needs_approval");
  const log = join(root, "research/local/task-control/cancel-buy/notify.log");
  assert.match(readFileSync(log, "utf8"), /needs_approval/);
  const resumed = success(await asyncRun(root, "complete", "resume", "cancel-buy").result);
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.endReason, "delivered");
  assert.match(readFileSync(log, "utf8"), /delivered/);
});

test("任务可用 execution.executor 指定 opencode；agy 档位字段被拒绝", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  opencodeConfig(root);
  editTask(root, (s) => {
    s.execution = { executor: "opencode" };
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "task executor");
  const preview = success(run(root, "dispatch", "cancel-buy", "--dry-run"));
  assert.equal(preview.executor, "opencode");
  assert.match(preview.prompt, /--owner opencode/);
  const done = success(await asyncRun(root, "complete", "dispatch", "cancel-buy").result);
  assert.equal(done.executor, "opencode");
  assert.equal(done.conversationId, "ses-fixture-session");

  const conflict = repo();
  ready(conflict);
  executorConfig(conflict);
  opencodeConfig(conflict);
  editTask(conflict, (s) => {
    s.execution = { executor: "opencode", effort: "high" };
  });
  git(conflict, "add", ".");
  git(conflict, "commit", "-m", "conflict");
  const rejected = run(conflict, "dispatch", "cancel-buy", "--dry-run");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /effort\/mode 覆盖/);
});

test("dispatch --model 覆盖冻结进快照，换模型须重新确认", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  const preview = success(run(root, "dispatch", "cancel-buy", "--dry-run", "--model", "cli-model"));
  assert.equal(preview.model, "cli-model");
  assert.equal(existsSync(join(root, "research/local/task-control/cancel-buy")), false, "dry-run 不落快照");
  success(detachedScenario(root, "fail", "dispatch", "cancel-buy", "--model", "cli-model"));
  const done = await finished(root);
  assert.equal(done.run.state, "failed");
  const snapshot = JSON.parse(readFileSync(join(root, "research/local/task-control/cancel-buy/definition.json"), "utf8"));
  assert.equal(snapshot.config.executors.agy.model, "cli-model");
  const again = run(root, "dispatch", "cancel-buy", "--model", "other-model");
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /refresh-definition/);
  const wt = join(root, ".worktrees/cancel-buy");
  success(
    detachedScenario(
      wt,
      "complete",
      "resume",
      "cancel-buy",
      "--conversation",
      "fixture-session",
      "--refresh-definition",
      "--model",
      "other-model",
    ),
  );
  assert.equal(
    JSON.parse(readFileSync(join(root, "research/local/task-control/cancel-buy/definition.json"), "utf8")).config.executors.agy.model,
    "other-model",
  );
  assert.equal((await finished(root)).run.state, "completed");
});

test("执行器建树前失败，主仓 dispatch --refresh-definition 可换模型重派；已建树时缺树明确报错", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  success(detachedScenario(root, "fail-before-start", "dispatch", "cancel-buy", "--model", "cli-model"));
  assert.equal((await finished(root)).run.state, "failed");
  assert.equal(existsSync(join(root, ".worktrees/cancel-buy")), false, "执行器未建树");
  const control = join(root, "research/local/task-control/cancel-buy");
  const original = readFileSync(join(control, "definition.json"), "utf8");
  editTask(root, (s) => {
    s.branch = "task/other";
  });
  git(root, "commit", "-am", "rename branch");
  const renamed = run(root, "dispatch", "cancel-buy", "--refresh-definition", "--model", "other-model");
  assert.notEqual(renamed.status, 0);
  assert.match(renamed.stderr, /不能更换任务分支或工作树/);
  git(root, "revert", "--no-edit", "HEAD");
  success(detachedScenario(root, "complete", "dispatch", "cancel-buy", "--refresh-definition", "--model", "other-model"));
  assert.equal(JSON.parse(readFileSync(join(control, "definition.json"), "utf8")).config.executors.agy.model, "other-model");
  const archived = readdirSync(join(control, "definitions"));
  assert.equal(archived.length, 1, "旧快照归档");
  assert.equal(readFileSync(join(control, "definitions", archived[0]), "utf8"), original, "归档保留原始字节");
  assert.equal((await finished(root)).run.state, "completed");

  const gone = repo();
  ready(gone);
  executorConfig(gone);
  success(detachedScenario(gone, "fail", "dispatch", "cancel-buy"));
  assert.equal((await finished(gone)).run.state, "failed");
  rmSync(join(gone, ".worktrees/cancel-buy"), { recursive: true, force: true });
  git(gone, "worktree", "prune");
  const rejected = run(gone, "dispatch", "cancel-buy", "--refresh-definition", "--model", "other-model");
  assert.notEqual(rejected.status, 0);
  assert.doesNotMatch(rejected.stderr, /ENOENT/);
  assert.match(rejected.stderr, /原任务工作树/);
});

test("包内 task.config.example.json 原样拷入即可通过配置解析", () => {
  const root = repo();
  const example = JSON.parse(readFileSync(new URL("../packages/devflow/templates/task.config.example.json", import.meta.url), "utf8"));
  configure(root, (cfg) => {
    for (const key of Object.keys(cfg)) delete cfg[key];
    Object.assign(cfg, example.task, { controlDir: "research/local/task-control" });
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "example config");
  success(run(root, "status"));
});

test("旧 task.agy 配置段按单执行器等价读取", async () => {
  const root = repo();
  ready(root);
  configure(root, (cfg) => {
    delete cfg.executor;
    delete cfg.executors;
    cfg.agy = {
      command: [process.execPath, executor],
      model: "legacy-model",
      effort: "medium",
      mode: "accept-edits",
      permissionArgs: [],
    };
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "legacy config");
  assert.equal(success(run(root, "status")).tasks[0].status, "待认领");
  const done = success(await asyncRun(root, "complete", "dispatch", "cancel-buy").result);
  assert.equal(done.executor, "agy");
  assert.equal(done.conversationId, "fixture-session");
});

test("任务级 execution.model 覆盖冻结进快照", async () => {
  const root = repo();
  ready(root);
  executorConfig(root);
  editTask(root, (s) => {
    s.execution = { model: "task-model" };
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "task model");
  assert.equal(success(run(root, "dispatch", "cancel-buy", "--dry-run")).model, "task-model");
  success(detachedScenario(root, "fail", "dispatch", "cancel-buy"));
  await finished(root);
  assert.equal(
    JSON.parse(readFileSync(join(root, "research/local/task-control/cancel-buy/definition.json"), "utf8")).config.executors.agy.model,
    "task-model",
  );
});

test("0.7.0 旧形状快照：配置不变时直接续跑，--model 给出重新确认提示", async () => {
  const root = repo();
  ready(root);
  configure(root, (cfg) => {
    delete cfg.executor;
    delete cfg.executors;
    delete cfg.executorEnvDeny;
    cfg.agy = { command: [process.execPath, executor], model: "legacy-model", effort: "medium", mode: "accept-edits", permissionArgs: [] };
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "legacy config");
  success(detachedScenario(root, "fail", "dispatch", "cancel-buy"));
  await finished(root);
  // Rewrite the snapshot exactly as kit 0.7.0 froze it: parsed config with a top-level agy section.
  const file = join(root, "research/local/task-control/cancel-buy/definition.json"),
    snap = JSON.parse(readFileSync(file, "utf8")),
    c = snap.config;
  snap.config = {
    version: 1,
    tasksDir: c.tasksDir,
    controlDir: c.controlDir,
    rules: c.rules,
    agy: c.executors.agy,
    worktreeDir: c.worktreeDir,
    postCreate: c.postCreate,
    budgetMinutes: c.budgetMinutes,
    progressMinutes: c.progressMinutes,
    hardTimeoutMinutes: c.hardTimeoutMinutes,
  };
  snap.configHash = cryptoHash("sha256").update(JSON.stringify(snap.config)).digest("hex");
  writeFileSync(file, JSON.stringify(snap));
  const model = run(root, "resume", "cancel-buy", "--conversation", "fixture-session", "--model", "other-model");
  assert.notEqual(model.status, 0);
  assert.doesNotMatch(model.stderr, /TypeError|Cannot read/);
  assert.match(model.stderr, /refresh-definition/);
  success(detachedScenario(root, "complete", "resume", "cancel-buy", "--conversation", "fixture-session"));
  assert.equal((await finished(root)).run.state, "completed");
});

test("配置换新形状后，旧快照在工作树内重新确认可继续", async () => {
  const root = repo();
  ready(root);
  configure(root, (cfg) => {
    delete cfg.executor;
    delete cfg.executors;
    cfg.agy = {
      command: [process.execPath, executor],
      model: "legacy-model",
      effort: "medium",
      mode: "accept-edits",
      permissionArgs: [],
    };
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "legacy config");
  success(detachedScenario(root, "fail", "dispatch", "cancel-buy"));
  await finished(root);
  configure(root, (cfg) => {
    delete cfg.agy;
    cfg.executor = "agy";
    cfg.executors = {
      agy: {
        command: [process.execPath, executor],
        model: "legacy-model",
        effort: "medium",
        mode: "accept-edits",
        permissionArgs: [],
      },
    };
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "new config shape");
  assert.match(run(root, "resume", "cancel-buy", "--conversation", "fixture-session").stderr, /后端配置已变化|项目配置已变化/);
  const wt = join(root, ".worktrees/cancel-buy");
  const resumed = success(
    await asyncRun(wt, "complete", "resume", "cancel-buy", "--conversation", "fixture-session", "--refresh-definition").result,
  );
  assert.equal(resumed.state, "completed");
});

test("opencode 坏输出与缺会话不能冒充成功", async () => {
  for (const scenario of ["invalid", "missing-session"]) {
    const root = repo();
    ready(root);
    defaultOpencode(root);
    success(detachedScenario(root, scenario, "dispatch", "cancel-buy"));
    const done = await finished(root);
    assert.equal(done.run.state, "failed");
    assert.match(done.run.error, /JSON|会话标识|回复文本/);
  }
});

test("执行器配置错误有清晰报错：未知名称、缺失模型、形状不符、默认段缺失", () => {
  for (const [mutation, message] of [
    [
      (cfg) => {
        cfg.executor = "missing";
      },
      /默认执行器 missing 缺少配置段/,
    ],
    [
      (cfg) => {
        cfg.executors.mystery = { command: ["x"], model: "a/b", permissionArgs: [] };
      },
      /未知执行器：mystery/,
    ],
    [
      (cfg) => {
        cfg.executors.opencode = { command: ["opencode"], permissionArgs: [] };
      },
      /opencode\.model/,
    ],
    [
      (cfg) => {
        cfg.executors.opencode = {
          command: ["opencode"],
          model: "no-slash",
          permissionArgs: [],
        };
      },
      /厂商\/模型/,
    ],
    [
      (cfg) => {
        delete cfg.executors.agy;
      },
      /默认执行器 agy 缺少配置段/,
    ],
  ]) {
    const root = repo();
    configure(root, mutation);
    const result = run(root, "status");
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, message);
  }
});
