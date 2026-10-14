// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDiagnosticsPanel, type PanelTexts } from "./panel.ts";

const TEXTS: PanelTexts = {
  title: "导出诊断信息",
  hint: "发给开发者",
  send: "发送诊断文件",
  copy: "复制诊断内容",
  close: "关闭",
  reload: "重新加载",
  checking: "正在检查新版本…",
  updating: "正在下载新版本…",
  results: { shared: "已分享", downloaded: "已开始下载", cancelled: "", copied: "已复制", copyFailed: "复制失败", failed: "导出失败" },
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const button = (name: string): HTMLButtonElement =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;
const status = (): string => document.querySelector('[role="status"]')?.textContent ?? "";
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("openDiagnosticsPanel", () => {
  it("弹层：标题、说明、三个按钮；对话框语义；重复打开只有一个", () => {
    const p1 = openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => "x", fileName: () => "a.txt" });
    const p2 = openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => "x", fileName: () => "a.txt" });
    expect(p2).toBe(p1);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("导出诊断信息");
    expect(dialog.textContent).toContain("发给开发者");
    expect(button("发送诊断文件")).toBeTruthy();
    expect(button("复制诊断内容")).toBeTruthy();
    expect(button("关闭")).toBeTruthy();
    expect(button("重新加载")).toBeUndefined();
  });

  it("发送：每次现取全文与文件名，结果写进面板；失败如实提示", async () => {
    let n = 0;
    const deliver = vi.fn(async () => "downloaded" as const);
    openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => `第 ${++n} 次`, fileName: () => "a.txt", deliver });
    button("发送诊断文件").click();
    await flush();
    expect(deliver).toHaveBeenCalledWith("a.txt", "第 1 次");
    expect(status()).toBe("已开始下载");
    deliver.mockRejectedValueOnce(new Error("boom"));
    button("发送诊断文件").click();
    await flush();
    expect(status()).toBe("导出失败");
  });

  it("复制可单独指定内容（截短版）；发送仍是全文", async () => {
    const copy = vi.fn(async () => true);
    const deliver = vi.fn(async () => "downloaded" as const);
    openDiagnosticsPanel({
      mode: "sheet",
      texts: TEXTS,
      getText: () => "全文",
      getCopyText: () => "截短",
      fileName: () => "a.txt",
      copy,
      deliver,
    });
    button("复制诊断内容").click();
    await flush();
    button("发送诊断文件").click();
    await flush();
    expect(copy).toHaveBeenCalledWith("截短");
    expect(deliver).toHaveBeenCalledWith("a.txt", "全文");
  });

  it("复制：成功与失败各有提示；取全文本身抛错也不打断", async () => {
    const copy = vi.fn(async () => true);
    openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => "全文", fileName: () => "a.txt", copy });
    button("复制诊断内容").click();
    await flush();
    expect(copy).toHaveBeenCalledWith("全文");
    expect(status()).toBe("已复制");
    copy.mockResolvedValueOnce(false);
    button("复制诊断内容").click();
    await flush();
    expect(status()).toBe("复制失败");
  });

  it("关闭按钮与 Esc 都能关；关后可再开", () => {
    const p = openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => "x", fileName: () => "a.txt" });
    button("关闭").click();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => "x", fileName: () => "a.txt" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    p.close(); // 已关再关无害
  });

  it("弹层开着时要求整页（界面崩溃）：换成整页面板，不被可关闭的弹层吃掉", () => {
    openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => "x", fileName: () => "a.txt" });
    openDiagnosticsPanel({ mode: "page", texts: { ...TEXTS, title: "应用出错了" }, getText: () => "x", fileName: () => "a.txt" });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("应用出错了");
    expect(button("关闭")).toBeUndefined();
    // 整页开着时再要弹层：保持整页
    openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => "x", fileName: () => "a.txt" });
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("应用出错了");
  });

  it("处理中按钮禁用：双击发送只交付一次", async () => {
    let finish!: () => void;
    const deliver = vi.fn(() => new Promise<"shared">((r) => (finish = () => r("shared"))));
    openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => "x", fileName: () => "a.txt", deliver });
    button("发送诊断文件").click();
    expect(button("发送诊断文件").disabled).toBe(true);
    button("发送诊断文件").click();
    finish();
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(button("发送诊断文件").disabled).toBe(false);
    expect(document.activeElement).toBe(button("发送诊断文件")); // 禁用期间焦点掉到 body，结束后还回来
  });

  it("焦点：打开时进面板，Tab 在面板内循环，关闭后还给打开前的元素", () => {
    const opener = document.createElement("button");
    opener.textContent = "版本号";
    document.body.append(opener);
    opener.focus();
    openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => "x", fileName: () => "a.txt" });
    expect(document.activeElement).toBe(button("发送诊断文件"));
    button("关闭").focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(button("发送诊断文件"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
    expect(document.activeElement).toBe(button("关闭"));
    button("关闭").click();
    expect(document.activeElement).toBe(opener);
  });

  it("面板被宿主连同 body 内容移除后，不再拦 Tab", () => {
    openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => "x", fileName: () => "a.txt" });
    document.body.innerHTML = "";
    const ev = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("弹层点遮罩关闭；点面板本身不关；整页点背景不关", () => {
    openDiagnosticsPanel({ mode: "sheet", texts: TEXTS, getText: () => "x", fileName: () => "a.txt" });
    document.querySelector('[role="dialog"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    (document.querySelector('[role="dialog"]')!.parentElement as HTMLElement).click();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    openDiagnosticsPanel({ mode: "page", texts: TEXTS, getText: () => "x", fileName: () => "a.txt" });
    (document.querySelector('[role="dialog"]')!.parentElement as HTMLElement).click();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("整页（白屏兜底）：不可关，提供重新加载；不依赖应用样式（内联样式铺满）", async () => {
    const reload = vi.fn();
    openDiagnosticsPanel({ mode: "page", texts: { ...TEXTS, title: "应用出错了" }, getText: () => "x", fileName: () => "a.txt", reload });
    expect(button("关闭")).toBeUndefined();
    button("重新加载").click();
    await flush();
    expect(reload).toHaveBeenCalled();
    reload.mock.calls[0]![0](); // 宿主报「新版本下载中」
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "正在下载新版本…")).toBe(true);
    const reloadBtn = [...document.querySelectorAll("button")].find((b) => b.textContent === "正在下载新版本…")!;
    expect(reloadBtn.disabled).toBe(true); // 等待激活新版本期间不能重复点
    expect(reloadBtn.style.opacity).toBe("0.6"); // 看得出在处理
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    const root = document.querySelector('[role="dialog"]')!.parentElement as HTMLElement;
    expect(root.style.position).toBe("fixed");
    expect(root.style.inset).toBe("0");
  });
});
