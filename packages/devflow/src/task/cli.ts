import { parseArgs } from "node:util";
import { newTask, check, idOf } from "./definition.ts";
import { context, start, status, dispatch, resume, supervise, verify, accept, rework, deliver, block, shortStatus } from "./runtime.ts";
import { watchCommand } from "./watch.ts";
import { text } from "./validation.ts";
const usage =
  "用法：nexus-devflow task <new|dispatch|start|deliver|block|status|resume|verify|accept|rework|watch> [任务标识]\n执行者：start 建树认领；deliver --summary-file <工作树外文件> 自验后交付（复跑当前验证命令通过、追加交付摘要并标待验收）；block --reason-file <工作树外文件> 登记受阻。\ndispatch/resume 默认等待最终结果；--detach 只启动；--dry-run 仅派发预览；--model 覆盖本次执行器模型（无需刷新定义）。\nwatch <任务标识...> | --all 轮询运行记录，任务结束打印一行摘要后退出；协调者在当前回合前台运行并加 --timeout-minutes（小于宿主单条命令上限），退出 3 表示未结束、再跑一轮，watch 退出前不结束回复。\nstatus --short 输出一行一个任务；rework --message-file <JSON> 登记缺陷、复现命令与通过标准。\nverify --main-review <JSON> 登记主仓异常核对（reviewer、reason、incidents[{id,sha256}]）。\n取消等待保留执行器；执行完成仍需 verify、独立审查和 accept。";
export async function taskCommand(argv: string[]): Promise<number> {
  let [sub, ...args] = argv;
  if (sub === "--help" || sub === "-h") {
    args = ["--help"];
    sub = "help";
  }
  if (sub === "watch") return watchCommand(args);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: "string" },
      owner: { type: "string" },
      help: { type: "boolean", short: "h" },
      "dry-run": { type: "boolean" },
      detach: { type: "boolean" },
      model: { type: "string" },
      short: { type: "boolean" },
      conversation: { type: "string" },
      "run-dir": { type: "string" },
      "message-file": { type: "string" },
      review: { type: "string" },
      "main-review": { type: "string" },
      "refresh-definition": { type: "boolean" },
      "summary-file": { type: "string" },
      "reason-file": { type: "string" },
    },
  });
  if (values.help || !sub) {
    console.log(usage);
    return sub ? 0 : 2;
  }
  const allowed: Record<string, string[]> = {
    new: ["title"],
    start: ["owner"],
    deliver: ["summary-file"],
    block: ["reason-file"],
    status: ["short"],
    dispatch: ["dry-run", "detach", "model", "refresh-definition"],
    resume: ["conversation", "detach", "model", "refresh-definition"],
    verify: ["main-review"],
    accept: ["review"],
    rework: ["message-file"],
    _supervise: ["run-dir"],
  };
  check(allowed[sub], `未知命令：${sub}`);
  for (const key of Object.keys(values)) check(allowed[sub]!.includes(key), `${sub} 不支持参数 --${key}`);
  check(!(values["dry-run"] && values.detach), "--dry-run 与 --detach 不能同时使用");
  const ctx = context();
  check(positionals.length === (sub === "status" ? Math.min(positionals.length, 1) : 1), "必须指定一个任务标识");
  const id = positionals[0];
  if (id) idOf(id);
  if (sub === "status") {
    const result = status(ctx, id);
    console.log(values.short ? shortStatus(result) : JSON.stringify(result, null, 2));
    // A list degrades per row; a single queried task that cannot be read is a failure.
    return id && result.tasks.some((t) => t.error) ? 1 : 0;
  }
  const key = idOf(id);
  let result: object;
  switch (sub) {
    case "new":
      result = newTask(ctx.root, ctx.cfg, key, text(values.title, "标题 --title"));
      break;
    case "start":
      result = start(ctx, key, text(values.owner, "负责人 --owner"));
      break;
    case "dispatch":
      result = await dispatch(ctx, key, {
        dryRun: values["dry-run"],
        refreshDefinition: values["refresh-definition"],
        detach: values.detach,
        model: values.model,
      });
      break;
    case "resume":
      result = await resume(ctx, key, {
        conversation: values.conversation,
        refreshDefinition: values["refresh-definition"],
        detach: values.detach,
        model: values.model,
      });
      break;
    case "deliver":
      result = await deliver(ctx, key, text(values["summary-file"], "交付摘要 --summary-file"));
      break;
    case "block":
      result = block(ctx, key, text(values["reason-file"], "受阻原因 --reason-file"));
      break;
    case "verify":
      result = await verify(ctx, key, values["main-review"]);
      break;
    case "rework":
      result = rework(ctx, key, text(values["message-file"], "返工说明 --message-file"));
      break;
    case "accept":
      result = accept(ctx, key, text(values.review, "独立审查记录 --review"));
      break;
    case "_supervise":
      result = await supervise(ctx, key, text(values["run-dir"], "run-dir"));
      break;
    default:
      throw new Error(`未知命令：${sub}`);
  }
  console.log(JSON.stringify(result, null, 2));
  return "commandExitCode" in result && typeof result.commandExitCode === "number"
    ? result.commandExitCode
    : typeof process.exitCode === "number"
      ? process.exitCode
      : 0;
}
