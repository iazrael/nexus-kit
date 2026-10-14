/**
 * 诊断面板：原生 DOM，不依赖任何框架和应用样式——白屏兜底时 React 和 CSS 都可能没起来，面板照样要能显示。
 *
 * 两种模式：sheet = 浮层（用户主动打开，可关闭、Esc 关闭）；page = 整页（白屏兜底，不可关闭，提供重新加载）。
 * 三条导出路：发送诊断文件（deliverTextFile：触屏分享、桌面下载）、复制诊断内容（copyText）、关闭/重新加载。
 * 每次点按钮都现取全文与文件名（面板开着期间日志还在增长）；结果写进面板里的状态行，失败如实提示。
 * 复制与分享都要求用户手势：按钮点击本身就是手势，所以面板必须让用户点，不能自动触发。
 *
 * 文案全部由宿主传入（kit 不内置文案）。
 */
import { type DeliverResult } from "./deliver.ts";
export interface PanelTexts {
    title: string;
    hint: string;
    send: string;
    copy: string;
    close: string;
    reload: string;
    /** 点了「重新加载」后按钮上的字（正在检查新版本） */
    checking: string;
    /** 发现新版本正在下载时按钮上的字 */
    updating: string;
    results: Record<DeliverResult, string> & {
        copied: string;
        copyFailed: string;
        failed: string;
    };
}
export interface DiagnosticsPanelOptions {
    mode: "sheet" | "page";
    texts: PanelTexts;
    /** 诊断全文（每次点按钮现取） */
    getText: () => string;
    /** 复制用的文本（每次现取）；默认同 getText。聊天应用贴不进太长的内容，宿主可传截短版（truncateExport） */
    getCopyText?: () => string;
    /** 下载/分享用的文件名（每次现取，带时刻） */
    fileName: () => string;
    /**
     * page 模式「重新加载」；默认 reloadToLatestVersion（先激活已下载好的新版本再刷新）。
     * onUpdating 在发现新版本正在下载时调用，面板据此改按钮上的字
     */
    reload?: (onUpdating: () => void) => void | Promise<unknown>;
    /** 注入点（测试与宿主自定义交付）；默认 deliverTextFile / copyText */
    deliver?: (name: string, text: string) => Promise<DeliverResult>;
    copy?: (text: string) => Promise<boolean>;
}
export interface DiagnosticsPanel {
    close(): void;
}
/**
 * 打开面板；已有一个开着（且仍在页面上）时返回那一个。例外：要整页（界面崩溃）而开着的是弹层时，换成整页——
 * 否则用户关掉弹层，底下就是白屏，兜底也不会再出现。
 */
export declare function openDiagnosticsPanel(options: DiagnosticsPanelOptions): DiagnosticsPanel;
