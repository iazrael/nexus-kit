/**
 * 活文档审计（文档写法规范的机器门禁）：
 * - 活文档（docs/ 下除存档目录外的 .md）头部前 20 行必须有「基准：」行；
 * - 设计稿目录下的文档头部还必须有「状态：」行（进度的唯一记录处）；
 * - 每篇活文档必须登记在索引文件（默认 CLAUDE.md）里；
 * - 相对链接必须指向存在的文件或目录。
 * 返回问题清单（空 = 通过）；读盘经注入，单测用内存树。
 */
import { dirname, relative, resolve, sep } from "node:path";
function linkTarget(raw) {
    const withoutTitle = raw
        .trim()
        .replace(/^<|>$/gu, "")
        .split(/\s+["']/u, 1)[0] ?? "";
    const path = withoutTitle.split("#", 1)[0] ?? "";
    if (path === "" || /^(?:[a-z]+:|\/)/iu.test(path))
        return null;
    try {
        return decodeURIComponent(path);
    }
    catch {
        return path;
    }
}
export function auditDocs(opts, fs) {
    const root = resolve(opts.repoRoot);
    const rel = (p) => relative(root, p).split(sep).join("/");
    const archive = rel(resolve(root, opts.archiveDir)) + "/";
    const design = rel(resolve(root, opts.designDir)) + "/";
    const indexPath = resolve(root, opts.index);
    const index = fs.exists(indexPath) ? fs.read(indexPath) : "";
    const errors = [];
    if (index === "")
        errors.push(`${opts.index}: 索引文件不存在或为空`);
    const active = fs.listMarkdown(resolve(root, opts.docsRoot)).filter((p) => !rel(p).startsWith(archive));
    for (const file of active) {
        const r = rel(file);
        const text = fs.read(file);
        const head = text.split(/\r?\n/u).slice(0, 20).join("\n");
        if (!/基准(?:\*\*)?\s*[：:]/u.test(head))
            errors.push(`${r}: 头部前 20 行缺少「基准」`);
        if (r.startsWith(design) && !/状态(?:\*\*)?\s*[：:]/u.test(head))
            errors.push(`${r}: 设计稿头部前 20 行缺少「状态」`);
        if (!index.includes(r))
            errors.push(`${r}: 未登记到 ${opts.index} 文档索引`);
        for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
            const target = linkTarget(match[1] ?? "");
            if (target === null)
                continue;
            if (!fs.exists(resolve(dirname(file), target)))
                errors.push(`${r}: 相对链接不存在：${match[1]}`);
        }
    }
    return { errors, checked: active.length };
}
