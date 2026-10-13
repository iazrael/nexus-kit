/**
 * CHANGELOG.md 解析纯逻辑（格式约定见 docs/架构算法/离线与升级.md §5）：
 * 构建时由 vite 插件调用，把已发版条目注入 dist/version.json（升级弹窗展示
 * 「本地版本 → 最新版本」间的变更）。留档前缀（默认「内部：」「WIP：」）条目在此统一
 * 剔除——仅留档（CHANGELOG/git），不进任何用户界面。
 */
/** 未落款小节名：日常条目先记在这里，发版时整合落款为版本号 */
export declare const UNRELEASED = "Unreleased";
/** 内部条目前缀：以此开头的条目不出现在升级弹窗 */
export declare const INTERNAL_PREFIX = "\u5185\u90E8\uFF1A";
/** 未开放功能条目前缀：主干上开发中、用户入口未开的功能，同样不进升级弹窗；
 *  发版整合时留在 Unreleased 不随版落款，开放时收成一条对外条目 */
export declare const WIP_PREFIX = "WIP\uFF1A";
/** 不进任何用户界面的留档前缀（默认值；宿主可经 ChangelogOptions 覆盖） */
export declare const DEFAULT_HIDDEN_PREFIXES: readonly string[];
export interface ChangelogOptions {
    /** 留档前缀：以此开头的条目不进升级弹窗 */
    hiddenPrefixes?: readonly string[];
}
/** version.json 里的单个已发版本 */
export interface ChangelogRelease {
    version: string;
    /** 标题行日期（YYYY-MM-DD），缺失为空串 */
    date: string;
    notes: string[];
}
/**
 * 全部已发版历史（version.json 的 releases 数据源）：按文件内小节顺序返回
 * （约定新版本在前），Unreleased 不进历史；剔除内部条目后无条目的小节不出现。
 */
export declare function parseChangelogHistory(markdown: string, opts?: ChangelogOptions): ChangelogRelease[];
/** Unreleased 小节条目（留档条目同样剔除），供发版整合参考 */
export declare function parseUnreleased(markdown: string, opts?: ChangelogOptions): string[];
/** 一条泄漏：对外条目提到了未开放功能 */
export interface WipLeak {
    section: string;
    entry: string;
    keyword: string;
}
/**
 * 未开放功能泄漏检查：指定小节（未发版 + 当前版本）里的对外条目（剔除内部/WIP 后）
 * 若含未开放功能关键词即为泄漏——这些条目会进升级弹窗。中文没有词边界，放行词
 * （含关键词的无关专有名词）先从条目里剔除再匹配。关键词为空（功能已开放）恒无泄漏。
 */
export declare function findWipLeaks(markdown: string, sectionNames: readonly string[], keywords: readonly string[], allow?: readonly string[], opts?: ChangelogOptions): WipLeak[];
