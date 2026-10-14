/* eslint-disable no-var -- reloadLatest 与 bootGuard 会被转成内联脚本，必须只用 ES5 语法（guard.test 用 ES5 解析器把关） */
/**
 * 启动兜底的单一源码：「重新加载到最新版」（reloadLatest）与「主包加载失败」兜底（bootGuard）。
 *
 * 两处使用、一份源码：
 * - runtime 里直接调用（整页诊断面板的重新加载，经 lifecycle/reload.ts）；
 * - 宿主构建时用 bootGuardScript 把它们转成内联脚本注入 index.html——主包没加载上时 runtime 也没加载上，
 *   只有不依赖打包产物的内联脚本还能出手。
 * 因此这两个函数的函数体**只许用 ES5 语法**（var、function、无箭头/模板串/解构/默认参数/async），并且只用参数与
 * 全局对象、不引用模块里的任何东西：bootGuardScript 靠 Function.prototype.toString 取源码。guard.test 用 ES5
 * 解析器校验生成的脚本，并独立运行它。
 *
 * reloadLatest：模板的 SW 是提示升级制，修复版下载好后处于等待状态，要用户在升级弹窗里确认才接管；兜底时升级弹窗
 * 不在，单纯刷新拿到的永远是坏的旧版。所以先检查一次更新：没有新版本（检查结束、既无下载中也无等待中）立即刷新；
 * 正在下载就报「正在更新」并等它装好；已有等待版本时也要等检查结束（服务器上可能已有更新的版本），不抢着激活旧的；
 * 拿到等待中的新版本就发 SKIP_WAITING、等接管后刷新（至少留 1 秒给接管；页面没被 SW 控制时收不到接管信号，激活后
 * 稍等即刷新）。检查更新本身最多 6 秒（离线时 update() 可能不返回）。整个过程受 timeoutMs 约束，另有一道绝对时限兜住
 * 任何一步不返回（iOS 上取注册信息偶尔一直不返回）——按钮点了一定刷新，且只刷新一次。
 * 这是「升级必须用户确认」的唯一例外（需求裁决）：应用已经起不来、没有可保存的状态，而且仍是用户点了按钮。
 *
 * bootGuard：主包开始执行时宿主调 markBooted（给 <html> 打 data-boot）。在那之前：主包这类模块脚本加载报错立即
 * 显示「加载失败」页；页面级未捕获错误（旧浏览器解析不了语法等）后 2 秒仍没启动才显示；waitMs 内始终没启动也显示。
 * 图片、样式表、普通脚本的加载失败不算。markBooted 同时撤下已经显示的页（慢网下主包晚到不会被永久盖住）。
 */

/** navigator.serviceWorker 的最小形状 */
export interface SwLike {
  controller: unknown;
  getRegistration(): Promise<
    | {
        waiting: { postMessage(message: unknown): void } | null;
        installing: unknown;
        update(): Promise<unknown>;
      }
    | undefined
  >;
  addEventListener(type: "controllerchange", listener: () => void): void;
}

export interface ReloadLatestOptions {
  sw: SwLike | null;
  /** 等新版本下载、接管的总时限 */
  timeoutMs: number;
  reload: () => void;
  /** 发现新版本正在下载时报 "updating"，界面据此告诉用户在等什么 */
  onProgress?: (stage: "updating") => void;
}

/** 只许 ES5 语法（见文件头） */
export function reloadLatest(o: ReloadLatestOptions): void {
  var done = false;
  function finish(): void {
    if (done) return;
    done = true;
    o.reload();
  }
  // 绝对时限：任何一步不返回也会刷新
  setTimeout(finish, o.timeoutMs + 1000);
  var sw = o.sw;
  if (!sw) {
    finish();
    return;
  }
  var container = sw;
  var deadline = Date.now() + o.timeoutMs;
  var reported = false;
  container.getRegistration().then(function (reg) {
    if (!reg) {
      finish();
      return;
    }
    var registration = reg;
    var checked = false;
    // 检查更新本身的时限：离线时 update() 可能一直不返回，到点就当检查完成，不在「正在检查」停满总时限
    setTimeout(
      function () {
        checked = true;
      },
      Math.min(6000, o.timeoutMs),
    );
    try {
      registration.update().then(
        function () {
          checked = true;
        },
        function () {
          checked = true;
        },
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- ES5 不允许省略 catch 的参数
    } catch (e) {
      checked = true;
    }
    function activate(worker: { postMessage(message: unknown): void }): void {
      if (container.controller) {
        container.addEventListener("controllerchange", finish);
        // 至少留 1 秒给接管：时限边缘才激活时，0 毫秒后刷新会赶在接管之前、回到旧版（绝对时限多留的 1 秒覆盖它）
        setTimeout(finish, Math.max(1000, deadline - Date.now()));
      } else {
        // 页面没被 SW 控制（例如绕过 SW 的强制刷新）收不到接管信号：激活后稍等即刷新
        setTimeout(finish, 1000);
      }
      worker.postMessage({ type: "SKIP_WAITING" });
    }
    function poll(): void {
      if (done) return;
      if (registration.installing) {
        if (!reported && o.onProgress) {
          reported = true;
          o.onProgress("updating");
        }
      } else if (registration.waiting) {
        // 检查更新还在途时不抢先激活：服务器上可能已有更新的版本，马上就会出现在 installing
        if (checked || Date.now() >= deadline) {
          activate(registration.waiting);
          return;
        }
      } else if (checked) {
        finish();
        return;
      }
      if (Date.now() >= deadline) {
        if (registration.waiting && !registration.installing) activate(registration.waiting);
        else finish();
        return;
      }
      setTimeout(poll, 50);
    }
    poll();
  }, finish);
}

export interface BootGuardTexts {
  title: string;
  hint: string;
  reload: string;
  /** 点了重新加载后按钮上的字（正在检查新版本） */
  checking: string;
  /** 发现新版本正在下载时按钮上的字 */
  updating: string;
}

/** 只许 ES5 语法（见文件头） */
export function bootGuard(win: Window, reloadFn: (o: ReloadLatestOptions) => void, texts: BootGuardTexts, waitMs: number): void {
  var doc = win.document;
  var root: HTMLElement | null = null;
  function booted(): boolean {
    return doc.documentElement.hasAttribute("data-boot");
  }
  function el(tag: string, css: string, text: string): HTMLElement {
    var node = doc.createElement(tag);
    node.style.cssText = css;
    node.textContent = text;
    return node;
  }
  function show(): void {
    if (root || booted()) return;
    var overlay = el(
      "div",
      "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:#18181b;color:#f4f4f5;font-family:system-ui,-apple-system,sans-serif",
      "",
    );
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("data-nexus-boot-fallback", "");
    overlay.setAttribute("aria-label", texts.title);
    var box = el("div", "max-width:420px;width:100%;background:#27272a;border-radius:12px;padding:20px;box-sizing:border-box", "");
    var button = el(
      "button",
      "display:block;width:100%;margin-top:16px;padding:12px;border:0;border-radius:8px;font-size:16px;background:#f4f4f5;color:#18181b",
      texts.reload,
    ) as HTMLButtonElement;
    button.type = "button";
    button.onclick = function () {
      button.disabled = true;
      button.style.opacity = "0.6";
      button.textContent = texts.checking;
      reloadFn({
        sw: (win.navigator.serviceWorker as unknown as SwLike) || null,
        timeoutMs: 15000,
        reload: function () {
          win.location.reload();
        },
        onProgress: function () {
          button.textContent = texts.updating;
        },
      });
    };
    box.appendChild(el("h2", "margin:0 0 8px;font-size:18px", texts.title));
    box.appendChild(el("p", "margin:0;font-size:14px;line-height:1.5;color:#d4d4d8", texts.hint));
    box.appendChild(button);
    overlay.appendChild(box);
    root = overlay;
    (doc.body || doc.documentElement).appendChild(overlay);
  }
  win.addEventListener(
    "error",
    function (event) {
      if (booted()) return;
      var target = event.target as (EventTarget & { tagName?: string; type?: string }) | null;
      if (target && target.tagName) {
        // 元素加载失败：只认模块脚本（主包）；图片、样式表、普通脚本不算
        if (target.tagName === "SCRIPT" && target.type === "module") show();
        return;
      }
      win.setTimeout(show, 2000);
    },
    true,
  );
  win.setTimeout(show, waitMs);
}

/** 主包已开始执行：内联兜底不再出手，已经显示的「加载失败」页撤下（慢网下主包晚到时它可能已经弹出） */
export function markBooted(): void {
  document.documentElement.setAttribute("data-boot", "");
  for (const el of document.querySelectorAll("[data-nexus-boot-fallback]")) el.remove();
}

/**
 * 生成注入 index.html 的内联脚本（构建期在 Node 里调用；宿主的 vite 配置用 transformIndexHtml 放进 <head>，
 * 要赶在主包 <script> 之前执行）。waitMs = 主包多久没启动算加载失败，默认 15 秒
 */
export function bootGuardScript(texts: BootGuardTexts, waitMs = 15000): string {
  return `(${bootGuard.toString()})(window, ${reloadLatest.toString()}, ${JSON.stringify(texts)}, ${waitMs});`;
}
