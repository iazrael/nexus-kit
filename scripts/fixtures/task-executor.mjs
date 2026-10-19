// External process fixture: exercises the same CLI and Git operations an agent uses.
// One fixture emulates both executor protocols: agy (default) and opencode (--opencode marker).
import { spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout);
    process.exit(r.status || 1);
  }
  return r.stdout;
}
const scenario = process.env.TASK_TEST_SCENARIO || "complete";
if (process.env.TASK_TEST_ENV_FILE)
  writeFileSync(
    process.env.TASK_TEST_ENV_FILE,
    JSON.stringify({
      allowEvidenceDelete: process.env.ALLOW_EVIDENCE_DELETE ?? null,
    }),
  );
const earlyId = "4890d7e3-fa80-415d-b856-23ed106ba9bc";
const opencodeMode = process.argv.includes("--opencode");
const ocFresh = "ses-fixture-session";
const ocEarly = "ses-early-fixture-session";
const ocArgs = opencodeMode ? process.argv.slice(process.argv.indexOf("--opencode") + 1) : [];
const ocResumeId = ocArgs.includes("--session") ? ocArgs[ocArgs.indexOf("--session") + 1] : null;
// opencode --format json streams one event per line; text parts carry the reply.
const emit = (sessionId, text) =>
  console.log(
    JSON.stringify({
      type: "text",
      timestamp: Date.now(),
      sessionID: sessionId,
      part: {
        id: "prt-fixture",
        sessionID: sessionId,
        messageID: "msg-fixture",
        type: "text",
        text,
      },
    }),
  );
const logFile = process.argv[process.argv.indexOf("--log-file") + 1];
if (["early-session", "mismatch-final", "multiple-session", "early-hard"].includes(scenario)) {
  if (opencodeMode) {
    emit(ocEarly, "");
    if (scenario === "multiple-session") setTimeout(() => emit(ocFresh, ""), 50);
  } else {
    writeFileSync(logFile, `GetConversationDetail: found conversation 5da7df16-fef9-4055-a94d-a39363b6eeac\nCreated conversa`);
    setTimeout(
      () =>
        appendFileSync(
          logFile,
          `tion ${earlyId}\nCreated conversation ${scenario === "multiple-session" ? "5da7df16-fef9-4055-a94d-a39363b6eeac" : earlyId}\n`,
        ),
      50,
    );
  }
}

if (scenario === "early-resume") {
  if (opencodeMode) emit(ocResumeId, "");
  else writeFileSync(logFile, `Print mode: resuming conversation ${process.argv[process.argv.indexOf("--conversation") + 1]}\n`);
}
if (scenario === "unknown-log") {
  if (opencodeMode) console.log("fixture noise without a session id");
  else
    writeFileSync(
      logFile,
      "Created conversation not-a-uuid\nGetConversationDetail: found conversation 5da7df16-fef9-4055-a94d-a39363b6eeac\n",
    );
}
if (scenario === "invalid") {
  console.log("not-json");
  process.exit(0);
}
if (scenario === "missing-session") {
  console.log(
    opencodeMode
      ? JSON.stringify({ type: "text", part: { type: "text", text: "no session" } })
      : JSON.stringify({ status: "success", response: "no session" }),
  );
  process.exit(0);
}
if (scenario === "orphan") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(process.env.TASK_TEST_PID_FILE, String(child.pid));
  setTimeout(() => {}, 60_000);
} else if (scenario === "sleep") {
  setTimeout(
    () =>
      opencodeMode
        ? emit(ocFresh, "done")
        : console.log(
            JSON.stringify({
              conversation_id: "fixture-session",
              status: "success",
            }),
          ),
    1500,
  );
} else {
  const id = process.env.TASK_ID,
    root = process.env.TASK_ROOT;
  if (scenario === "fail-before-start") {
    console.error("fixture provider quota exceeded");
    process.exit(1);
  }
  const started = JSON.parse(run(process.execPath, [process.env.TASK_TOOL_CLI, "task", "start", id, "--owner", "fixture-executor"], root));
  if (["plan-stop", "plan-english", "plan-nonzero", "ordinary-no-delivery"].includes(scenario)) {
    const response =
      scenario === "plan-english"
        ? "Please approve the plan before I continue."
        : scenario === "ordinary-no-delivery"
          ? "计划如下，已经写好调查报告。"
          : "请审阅计划，确认后我将开始实施。";
    if (opencodeMode) emit(ocFresh, response);
    else
      console.log(
        JSON.stringify({
          conversation_id: "fixture-session",
          status: "SUCCESS",
          response,
        }),
      );
    process.exit(scenario === "plan-nonzero" ? 7 : 0);
  }
  if (scenario === "log-fifo") run("mkfifo", [join(root, "research/local/task-control", id, "notify.log")], root);
  if (scenario === "log-directory") mkdirSync(join(root, "research/local/task-control", id, "notify.log"));
  if (scenario === "log-symlink") {
    const target = join(root, "research/local/protected.log");
    writeFileSync(target, "protected");
    symlinkSync(target, join(root, "research/local/task-control", id, "notify.log"));
  }
  if (scenario === "fail") {
    console.error("fixture deliberate failure");
    process.exit(7);
  }
  if (scenario === "early-hard") await new Promise((resolve) => setTimeout(resolve, 5000));
  if (["mismatch-final", "multiple-session"].includes(scenario)) await new Promise((resolve) => setTimeout(resolve, 200));
  if (scenario === "early-session") {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    console.error("interrupted without final JSON");
    process.exit(7);
  }
  if (scenario === "slow-delivery") await new Promise((resolve) => setTimeout(resolve, 1000));
  if (scenario === "main-write" || scenario === "main-commit" || scenario === "main-amend") {
    writeFileSync(join(root, ".gitignore"), readFileSync(join(root, ".gitignore"), "utf8") + "# main changed\n");
    if (scenario === "main-commit") {
      run("git", ["add", ".gitignore"], root);
      run("git", ["commit", "-m", "main contamination"], root);
    }
    if (scenario === "main-amend") {
      run("git", ["add", ".gitignore"], root);
      run("git", ["commit", "--amend", "--no-edit"], root);
    }
  }
  if (scenario === "late-child-commit") {
    // A descendant that keeps writing the task tree for a while after TERM.
    const wt = started.worktree,
      ready = join(root, "research/local/late-child-ready");
    spawn(
      process.execPath,
      [
        "-e",
        `const fs=require('fs'),cp=require('child_process');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(wt, "artifact.txt"))},'late');cp.execFileSync('git',['add','artifact.txt'],{cwd:${JSON.stringify(wt)}});cp.execFileSync('git',['commit','-m','late child'],{cwd:${JSON.stringify(wt)}});process.exit(0)},400));fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`,
      ],
      { stdio: "ignore" },
    ).unref();
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("late child did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  if (scenario === "main-child-write") {
    const ready = join(root, "research/local/audit-child-ready");
    spawn(
      process.execPath,
      [
        "-e",
        `const fs=require('fs');process.on('SIGTERM',()=>{fs.appendFileSync(${JSON.stringify(join(root, ".gitignore"))}, '# child changed main\\n');process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`,
      ],
      { stdio: "ignore" },
    ).unref();
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("audit child did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const wt = started.worktree,
    file = join(wt, `tasks/${id}.md`);
  writeFileSync(join(wt, "artifact.txt"), "cancel-ok");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^> 状态：.*$/m, scenario === "blocked" ? "> 状态：受阻" : "> 状态：待验收"));
  run("git", ["add", "--", `tasks/${id}.md`, "artifact.txt"], wt);
  run("git", ["commit", "-m", "fixture delivery"], wt);
  const response = scenario === "complete-mentions-plan" ? "请审阅计划；现已完成交付。" : ocResumeId ? "resumed" : "delivered";
  if (opencodeMode)
    emit(scenario === "wrong-session" ? "ses-wrong-session" : scenario === "mismatch-final" ? ocFresh : (ocResumeId ?? ocFresh), response);
  else
    console.log(
      JSON.stringify({
        conversation_id:
          scenario === "wrong-session"
            ? "wrong-session"
            : scenario === "mismatch-final"
              ? "fixture-session"
              : process.argv.includes("--conversation")
                ? process.argv[process.argv.indexOf("--conversation") + 1]
                : "fixture-session",
        status: scenario === "uppercase" ? "SUCCESS" : "success",
        response:
          scenario === "complete-mentions-plan"
            ? "请审阅计划；现已完成交付。"
            : process.argv.includes("--conversation")
              ? "resumed"
              : "delivered",
      }),
    );
}
