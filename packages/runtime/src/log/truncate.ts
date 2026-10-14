/**
 * 诊断全文截短（复制到聊天用）：聊天应用对单条消息长度有限制、粘贴大段文本会卡，日志多时全文有几十 KB。
 * 头部摘要（环境、上次退出等节）对排查最要紧，完整保留；「## 日志」节只取最近的整行，保留部分前补上它所属会话的
 * 分隔行（开发者分得清是本次还是上次），并在节首注明省略了多少行。最后一行本身就超出预算（长堆栈）时截前半段保留。
 * 省略说明的措辞（例如完整内容该点哪个按钮）归宿主，默认只说省略了多少行。上限没有对各聊天应用实测，由宿主调整。
 */

const LOG_HEADING = "## 日志\n";
const SESSION_LINE = /^--- 会话 /;

export interface TruncateOptions {
  /** 省略说明，参数是省略的日志行数 */
  note?: (omitted: number) => string;
}

export function truncateExport(text: string, maxChars: number, options: TruncateOptions = {}): string {
  if (text.length <= maxChars) return text;
  const note = (n: number): string => `（${options.note?.(n) ?? `已截取：省略了较早的 ${n} 行日志`}）`;
  const hard = (): string => {
    const tag = `\n${note(0).replace("0 行", "部分")}`;
    return `${text.slice(0, Math.max(0, maxChars - tag.length))}${tag}`.slice(0, maxChars);
  };
  const at = text.indexOf(LOG_HEADING);
  if (at === -1) return hard();
  const head = text.slice(0, at + LOG_HEADING.length);
  const body = text
    .slice(at + LOG_HEADING.length)
    .replace(/\n$/, "")
    .split("\n");
  const logLines = body.filter((l) => !SESSION_LINE.test(l)).length;
  // 预留：省略说明（按全部省略估算位数，偏保守）+ 一行会话分隔（取最长的那条估算）+ 换行
  const longestMarker = Math.max(0, ...body.filter((l) => SESSION_LINE.test(l)).map((l) => l.length + 1));
  let budget = maxChars - head.length - note(logLines).length - 2 - longestMarker;
  if (budget <= 0) return hard();
  let first = body.length;
  for (let i = body.length - 1; i >= 0; i--) {
    const cost = body[i]!.length + 1;
    if (cost > budget) break;
    budget -= cost;
    first = i;
  }
  let kept = body.slice(first);
  if (kept.length === 0 && body.length > 0) {
    // 最后一行就放不下：截前半段
    kept = [`${body[body.length - 1]!.slice(0, Math.max(0, budget - 2))}…`];
    first = body.length - 1;
  }
  // 保留部分不以会话分隔行开头时，补上它所属会话的分隔行
  if (kept.length > 0 && !SESSION_LINE.test(kept[0]!)) {
    for (let i = first - 1; i >= 0; i--) {
      if (SESSION_LINE.test(body[i]!)) {
        kept = [body[i]!, ...kept];
        break;
      }
    }
  }
  const omitted = body.slice(0, first).filter((l) => !SESSION_LINE.test(l)).length;
  return `${head}${note(omitted)}\n${kept.join("\n")}\n`;
}
