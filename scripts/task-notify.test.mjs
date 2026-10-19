import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
test("结束流水：FIFO 不能卡住收尾，必须返回写入诊断", (t) => {
  const root = mkdtempSync(join(tmpdir(), "task-notify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const made = spawnSync("mkfifo", [join(root, "notify.log")]);
  assert.equal(made.status, 0);
  const module = new URL("../packages/devflow/dist/task/run-end.js", import.meta.url).href;
  const code = `import {recordRunEnd} from ${JSON.stringify(module)};const info={id:'sample',state:'completed',taskStatus:'待验收',stdout:'runs/1/stdout.json',endedAt:new Date().toISOString()};recordRunEnd(${JSON.stringify(root)},info);console.log(JSON.stringify(info));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 1000,
  });
  assert.equal(r.status, 0, r.error?.message ?? r.stderr);
  assert.match(r.stderr, /流水写入失败/);
  assert.ok(JSON.parse(r.stdout).notificationError);
});
