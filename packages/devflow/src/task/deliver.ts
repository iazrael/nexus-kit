import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { check, inside, printable } from "./validation.ts";

const summaryKeys = ["改了什么", "验证如何", "还有什么"] as const;
const maxNoteBytes = 64 * 1024;
const selfCheckColumn = "自验结果";

/** Resolves a path through every symlink, including a missing tail, by realpath-ing its nearest existing ancestor. */
function realLocation(path: string): string {
  let head = path,
    tail = "";
  while (!existsSync(head) && dirname(head) !== head) {
    tail = tail ? join(basename(head), tail) : basename(head);
    head = dirname(head);
  }
  return join(realpathSync(head), tail);
}

/**
 * Reads an executor note (summary or block reason). It must live outside the
 * task tree, so the tree stays clean; relative paths resolve from the caller's cwd.
 */
export function readNote(path: string, wt: string, label: string): string {
  const file = resolve(process.cwd(), path);
  check(!inside(realpathSync(wt), realLocation(file)), `${label}文件放在工作树外（例如 /tmp），否则工作树不干净：${path}`);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  check(stat, `${label}文件不存在：${path}`);
  check(!stat.isSymbolicLink(), `${label}文件不接受软链：${path}`);
  check(stat.isFile(), `${label}必须是普通文件：${path}`);
  check(stat.size <= maxNoteBytes, `${label}文件超过 ${maxNoteBytes} 字节`);
  const value = readFileSync(file, "utf8").replace(/\r\n?/g, "\n").trim();
  check(value !== "", `${label}不能为空`);
  return value;
}

/** Indents each line under a record bullet, stripping control characters so a note cannot break the record. */
export function indentNote(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${printable(line.replace(/\s+$/, ""))}`)
    .join("\n");
}

/**
 * Normalises a delivery summary to "1. 改了什么：… / 2. 验证如何：… / 3. 还有什么：…".
 * A section's content may continue on the following lines.
 */
export function formatSummary(value: string): string {
  const pattern = new RegExp(`^\\s*(?:\\d+[.、]\\s*)?(${summaryKeys.join("|")})[:：][ \\t]*(.*)$`);
  const sections = new Map<string, string[]>();
  let current: string | undefined,
    leadingText = false;
  for (const line of value.replace(/\r\n?/g, "\n").split("\n")) {
    const match = pattern.exec(line);
    if (!match) {
      if (current) sections.get(current)!.push(`   ${line}`);
      else if (line.trim() !== "") leadingText = true;
      continue;
    }
    const key = match[1]!;
    check(!sections.has(key), `交付摘要「${key}」重复`);
    current = key;
    sections.set(key, [match[2]!.trim()]);
  }
  const missing = summaryKeys.filter((key) => !sections.has(key));
  check(!missing.length, `交付摘要缺少：${missing.join("、")}；按「改了什么：」「验证如何：」「还有什么：」各写一段`);
  check(!leadingText, "交付摘要以「改了什么：」「验证如何：」「还有什么：」开头，前面不要写其他内容");
  for (const key of summaryKeys)
    check(
      sections.get(key)!.some((line) => line.trim() !== ""),
      `交付摘要「${key}」没有内容；没有就写「无」`,
    );
  return summaryKeys
    .map((key, index) => {
      const [first, ...rest] = sections.get(key)!;
      return [`${index + 1}. ${key}：${first}`, ...rest].join("\n").replace(/\s+$/, "");
    })
    .join("\n");
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/**
 * Locates the acceptance table: the first run of table lines in the
 * 「## 验收清单」 section, outside code fences. Line indexes refer to the
 * LF-normalised content.
 */
function acceptanceTable(lines: string[]): number[] | null {
  const start = lines.findIndex((line) => /^## 验收清单[ \t]*$/.test(line));
  if (start < 0) return null;
  let fenced = false;
  const table: number[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      if (table.length) break;
      continue;
    }
    if (fenced) continue;
    if (/^## /.test(line)) break;
    if (line.trim().startsWith("|")) table.push(i);
    else if (table.length) break;
  }
  return table;
}

/**
 * Checks the task's acceptance table: every row needs a self-check cell that
 * reads "通过：<证据>" or "不适用：<理由>". Returns the number of rows checked.
 */
export function checkAcceptance(content: string): number {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const found = acceptanceTable(lines);
  check(found, "任务文件缺少「## 验收清单」");
  const table = found.map((i) => lines[i]!);
  check(table.length >= 2 && /^[\s|:-]+$/.test(table[1]!), "验收清单没有条目；交协调者补齐验收要求后再交付");
  const column = cells(table[0]!).indexOf(selfCheckColumn);
  check(column >= 0, `验收清单缺少「${selfCheckColumn}」列：表头末尾加这一列，每行写「通过：证据」或「不适用：理由」`);
  const rows = table.slice(2).map(cells);
  check(rows.length > 0, "验收清单没有条目；交协调者补齐验收要求后再交付");
  const open = rows.filter((row) => !/^(通过|不适用)[:：]\s*\S/.test(row[column] ?? "")).map((row) => row[0] || "（无编号）");
  check(
    !open.length,
    `验收清单自验未完成：${open.join("、")}；逐条自验后写「通过：证据」或「不适用：理由」，做不到就用 task block 登记受阻`,
  );
  return rows.length;
}

/** Empties the acceptance table's self-check column so a rework round cannot reuse last round's passes. */
export function clearSelfChecks(content: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const table = acceptanceTable(lines);
  if (!table || table.length < 3) return content;
  const column = cells(lines[table[0]!]!).indexOf(selfCheckColumn);
  if (column < 0) return content;
  for (const i of table.slice(2)) {
    const row = cells(lines[i]!);
    if (column >= row.length) continue;
    row[column] = "";
    lines[i] = `| ${row.join(" | ")} |`;
  }
  return lines.join(eol);
}
