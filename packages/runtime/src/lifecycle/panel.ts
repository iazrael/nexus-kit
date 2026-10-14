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
import { copyText as defaultCopy, deliverTextFile, type DeliverResult } from "./deliver.ts";
import { reloadToLatestVersion } from "./reload.ts";

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
  results: Record<DeliverResult, string> & { copied: string; copyFailed: string; failed: string };
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

let current: { panel: DiagnosticsPanel; root: HTMLElement; mode: DiagnosticsPanelOptions["mode"] } | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 禁用态要看得出来：处理中按钮变暗，免得用户以为点了没反应 */
function setDisabled(button: HTMLButtonElement, disabled: boolean): void {
  button.disabled = disabled;
  button.style.opacity = disabled ? "0.6" : "1";
}

const BUTTON: Partial<CSSStyleDeclaration> = {
  display: "block",
  width: "100%",
  padding: "12px",
  marginTop: "10px",
  border: "0",
  borderRadius: "8px",
  font: "inherit",
  fontSize: "16px",
  cursor: "pointer",
};

/**
 * 打开面板；已有一个开着（且仍在页面上）时返回那一个。例外：要整页（界面崩溃）而开着的是弹层时，换成整页——
 * 否则用户关掉弹层，底下就是白屏，兜底也不会再出现。
 */
export function openDiagnosticsPanel(options: DiagnosticsPanelOptions): DiagnosticsPanel {
  // 先记下打开者再关旧面板：旧面板关闭时会还焦点，先关就记成了旧面板的打开者。body 不算打开者
  const active = document.activeElement;
  if (current !== null) {
    const keep = current.root.isConnected && !(options.mode === "page" && current.mode === "sheet");
    if (keep) return current.panel;
    current.panel.close(); // 被宿主连同 body 内容一起移除了，或要升级成整页：清掉旧的再开
  }
  const { texts, mode } = options;
  const deliver = options.deliver ?? deliverTextFile;
  const copy = options.copy ?? defaultCopy;
  const opener = active instanceof HTMLElement && active !== document.body ? active : null;

  const root = el("div", {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "flex",
    alignItems: mode === "page" ? "center" : "flex-end",
    justifyContent: "center",
    background: mode === "page" ? "#18181b" : "rgba(0,0,0,0.5)",
    padding: "16px",
    paddingBottom: "max(16px, env(safe-area-inset-bottom))",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: "#f4f4f5",
    boxSizing: "border-box",
  });
  const dialog = el("div", {
    width: "100%",
    maxWidth: "420px",
    background: "#27272a",
    borderRadius: "12px",
    padding: "20px",
    boxSizing: "border-box",
  });
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const title = el("h2", { margin: "0 0 8px", fontSize: "18px" }, texts.title);
  title.id = "nexus-diag-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const hint = el("p", { margin: "0 0 6px", fontSize: "14px", lineHeight: "1.5", color: "#d4d4d8" }, texts.hint);
  const statusLine = el("p", { minHeight: "1.5em", margin: "8px 0 0", fontSize: "14px", lineHeight: "1.5", color: "#fde68a" });
  statusLine.setAttribute("role", "status");

  const send = el("button", { ...BUTTON, background: "#f4f4f5", color: "#18181b" }, texts.send);
  const copyBtn = el("button", { ...BUTTON, background: "#3f3f46", color: "#f4f4f5" }, texts.copy);
  /**
   * 处理中两个按钮都禁用：双击「发送」时第二次 share 会因上一次没结束抛 InvalidStateError，落到下载兜底，
   * 平白多下一个文件；结果提示也会被后一次覆盖
   */
  const run = (button: HTMLButtonElement, work: () => Promise<string>): void => {
    if (send.disabled) return;
    setDisabled(send, true);
    setDisabled(copyBtn, true);
    void work()
      .catch(() => texts.results.failed)
      .then((message) => {
        statusLine.textContent = message;
        setDisabled(send, false);
        setDisabled(copyBtn, false);
        // 按钮禁用时浏览器把焦点丢到 body：还给刚点的按钮，键盘与读屏用户不丢位置
        if (root.isConnected && (document.activeElement === null || document.activeElement === document.body)) button.focus();
      });
  };
  send.type = "button";
  send.addEventListener("click", () => run(send, async () => texts.results[await deliver(options.fileName(), options.getText())]));
  copyBtn.type = "button";
  copyBtn.addEventListener("click", () =>
    run(copyBtn, async () =>
      (await copy((options.getCopyText ?? options.getText)()).catch(() => false)) ? texts.results.copied : texts.results.copyFailed,
    ),
  );
  dialog.append(title, hint, send, copyBtn);

  const buttons: HTMLButtonElement[] = [send, copyBtn];
  if (mode === "sheet") {
    const closeBtn = el("button", { ...BUTTON, background: "transparent", color: "#a1a1aa" }, texts.close);
    closeBtn.type = "button";
    closeBtn.addEventListener("click", () => panel.close());
    buttons.push(closeBtn);
  } else {
    const reloadBtn = el("button", { ...BUTTON, background: "transparent", color: "#a1a1aa" }, texts.reload);
    reloadBtn.type = "button";
    // 默认先激活已下载好的新版本再刷新（reloadToLatestVersion）；点下后禁用，防止等待期间重复点
    reloadBtn.addEventListener("click", () => {
      setDisabled(reloadBtn, true);
      reloadBtn.textContent = texts.checking;
      const onUpdating = (): void => {
        reloadBtn.textContent = texts.updating;
      };
      const reload = options.reload ?? ((cb: () => void) => reloadToLatestVersion({ onUpdating: cb }));
      // 宿主的 reload 同步抛错也要接住：退回普通刷新，按钮点了一定有结果
      void Promise.resolve()
        .then(() => reload(onUpdating))
        .catch(() => location.reload());
    });
    buttons.push(reloadBtn);
  }
  dialog.append(...buttons.slice(2), statusLine);

  /** Esc 关弹层；Tab 在面板按钮间循环（aria-modal 要求焦点不跑到背后的页面） */
  const onKey = (event: KeyboardEvent): void => {
    if (!root.isConnected) {
      // 被宿主连同 body 内容一起移除了：不再拦键盘（已有新面板时 close 不管旧的，所以直接摘监听）
      document.removeEventListener("keydown", onKey);
      panel.close();
      return;
    }
    if (event.key === "Escape" && mode === "sheet") {
      panel.close();
      return;
    }
    if (event.key !== "Tab") return;
    const enabled = buttons.filter((b) => !b.disabled);
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.shiftKey ? (at <= 0 ? enabled.length - 1 : at - 1) : at === -1 || at === enabled.length - 1 ? 0 : at + 1;
    event.preventDefault();
    enabled[next]?.focus();
  };
  document.addEventListener("keydown", onKey);
  // 弹层点遮罩关闭（手机上的习惯）；点面板本身不算。整页兜底不可关
  if (mode === "sheet") root.addEventListener("click", (event) => event.target === root && panel.close());
  root.append(dialog);
  document.body.append(root);
  send.focus();

  const panel: DiagnosticsPanel = {
    close() {
      if (current?.panel !== panel) return;
      document.removeEventListener("keydown", onKey);
      root.remove();
      current = null;
      if (opener?.isConnected === true) opener.focus(); // 焦点还给打开前的元素
    },
  };
  current = { panel, root, mode };
  return panel;
}
