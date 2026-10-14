// External process fixture: exercises the same CLI and Git operations an agent uses.
import { spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
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
const earlyId = "4890d7e3-fa80-415d-b856-23ed106ba9bc";
const logFile = process.argv[process.argv.indexOf("--log-file") + 1];
if (["early-session", "mismatch-final", "multiple-session", "early-hard"].includes(scenario)) {
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

if (scenario === "early-resume")
  writeFileSync(logFile, `Print mode: resuming conversation ${process.argv[process.argv.indexOf("--conversation") + 1]}\n`);
if (scenario === "unknown-log")
  writeFileSync(
    logFile,
    "Created conversation not-a-uuid\nGetConversationDetail: found conversation 5da7df16-fef9-4055-a94d-a39363b6eeac\n",
  );
if (scenario === "invalid") {
  console.log("not-json");
  process.exit(0);
}
if (scenario === "missing-session") {
  console.log(JSON.stringify({ status: "success", response: "no session" }));
  process.exit(0);
}
if (scenario === "orphan") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(process.env.TASK_TEST_PID_FILE, String(child.pid));
  setTimeout(() => {}, 60_000);
} else if (scenario === "sleep") {
  setTimeout(() => console.log(JSON.stringify({ conversation_id: "fixture-session", status: "success" })), 1500);
} else {
  const id = process.env.TASK_ID,
    root = process.env.TASK_ROOT;
  const started = JSON.parse(run(process.execPath, [process.env.TASK_TOOL_CLI, "task", "start", id, "--owner", "fixture-executor"], root));
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
      response: process.argv.includes("--conversation") ? "resumed" : "delivered",
    }),
  );
}
