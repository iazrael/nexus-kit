/**
 * CHANGELOG.md 解析纯逻辑（格式约定见 docs/架构算法/离线与升级.md §5）：
 * 构建时由 vite 插件调用，把已发版条目注入 dist/version.json（升级弹窗展示
 * 「本地版本 → 最新版本」间的变更）。留档前缀（默认「内部：」「WIP：」）条目在此统一
 * 剔除——仅留档（CHANGELOG/git），不进任何用户界面。
 */
/** 未落款小节名：日常条目先记在这里，发版时整合落款为版本号 */
export const UNRELEASED = "Unreleased";
/** 内部条目前缀：以此开头的条目不出现在升级弹窗 */
export const INTERNAL_PREFIX = "内部：";
/** 未开放功能条目前缀：主干上开发中、用户入口未开的功能，同样不进升级弹窗；
 *  发版整合时留在 Unreleased 不随版落款，开放时收成一条对外条目 */
export const WIP_PREFIX = "WIP：";
/** 不进任何用户界面的留档前缀（默认值；宿主可经 ChangelogOptions 覆盖） */
export const DEFAULT_HIDDEN_PREFIXES = [INTERNAL_PREFIX, WIP_PREFIX];
/** 从小节正文提取条目：`- ` / `* ` 列表行，剔除留档条目 */
function extractEntries(body, hidden) {
    return body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- ") || line.startsWith("* "))
        .map((line) => line.slice(2).trim())
        .filter(Boolean)
        .filter((line) => !hidden.some((prefix) => line.startsWith(prefix)));
}
/** 切出全部 `## [名字]` 小节（正文到下一小节标题行为止，标题行整行不进正文） */
function splitSections(markdown) {
    const sectionRe = /^##\s+\[([^\]]+)\](.*)$/gm;
    const heads = [];
    let match;
    while ((match = sectionRe.exec(markdown)) !== null) {
        const lineEnd = markdown.indexOf("\n", match.index);
        heads.push({
            name: match[1] ?? "",
            headerRest: match[2] ?? "",
            headerIndex: match.index,
            bodyStart: lineEnd === -1 ? markdown.length : lineEnd + 1,
        });
    }
    return heads.map((head, i) => ({
        name: head.name,
        headerRest: head.headerRest,
        body: markdown.slice(head.bodyStart, i + 1 < heads.length ? (heads[i + 1]?.headerIndex ?? markdown.length) : markdown.length),
    }));
}
/**
 * 全部已发版历史（version.json 的 releases 数据源）：按文件内小节顺序返回
 * （约定新版本在前），Unreleased 不进历史；剔除内部条目后无条目的小节不出现。
 */
export function parseChangelogHistory(markdown, opts = {}) {
    const hidden = opts.hiddenPrefixes ?? DEFAULT_HIDDEN_PREFIXES;
    return splitSections(markdown)
        .filter((section) => section.name !== UNRELEASED)
        .map((section) => ({
        version: section.name,
        date: /(\d{4}-\d{2}-\d{2})/.exec(section.headerRest)?.[1] ?? "",
        notes: extractEntries(section.body, hidden),
    }))
        .filter((release) => release.notes.length > 0);
}
/** Unreleased 小节条目（留档条目同样剔除），供发版整合参考 */
export function parseUnreleased(markdown, opts = {}) {
    const section = splitSections(markdown).find((s) => s.name === UNRELEASED);
    return section ? extractEntries(section.body, opts.hiddenPrefixes ?? DEFAULT_HIDDEN_PREFIXES) : [];
}
/**
 * 未开放功能泄漏检查：指定小节（未发版 + 当前版本）里的对外条目（剔除内部/WIP 后）
 * 若含未开放功能关键词即为泄漏——这些条目会进升级弹窗。中文没有词边界，放行词
 * （含关键词的无关专有名词）先从条目里剔除再匹配。关键词为空（功能已开放）恒无泄漏。
 */
export function findWipLeaks(markdown, sectionNames, keywords, allow = [], opts = {}) {
    const hidden = opts.hiddenPrefixes ?? DEFAULT_HIDDEN_PREFIXES;
    const leaks = [];
    for (const section of splitSections(markdown)) {
        if (!sectionNames.includes(section.name))
            continue;
        for (const entry of extractEntries(section.body, hidden)) {
            const scrubbed = allow.reduce((text, word) => text.split(word).join(""), entry);
            const keyword = keywords.find((word) => scrubbed.includes(word));
            if (keyword !== undefined)
                leaks.push({ section: section.name, entry, keyword });
        }
    }
    return leaks;
}
