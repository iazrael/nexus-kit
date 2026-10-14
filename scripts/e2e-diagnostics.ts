/**
 * 日志与异常退出取证的真浏览器 e2e：
 *   1. 模板构建发布到 .e2e/e2e-diag-site，Chromium 打开（会话一）；
 *   2. 刷新（会话一正常告别 → 会话二），断言上一会话的日志读回来了；
 *   3. 等日志落盘后用 CDP Page.crash 杀掉渲染进程（不会有 pagehide），新开页面（会话三）；
 *   4. 会话三里抛一个没人处理的 Promise 拒绝（消息带 ?token=secret 的 URL）；
 *   5. 按版本号的固定坐标连点 5 次（手指不会追着元素走）打开诊断面板，点「下载诊断文件」（桌面上不弹分享）；断言提示出现后
 *      版本号没被挤动，断言：判词为疑似异常退出、三个会话都在、会话一那段有「页面告别」、
 *      未捕获异常进了日志且 URL 的查询串已去掉；性能段（启动画像、走势）与 JSONL 附录都在，前几局的水位读得回来。
 *   6. 面板里点「复制诊断内容」，读剪贴板，断言是完整的诊断全文、不带 JSONL 附录；
 *   7. 新开页面让入口代码找不到 #root（启动即抛错），断言出现整页兜底，从兜底页导出的文件记着启动失败。
 *   8. 新的浏览器上下文（屏蔽 SW，否则主包由缓存供给拦不住）里拦掉主包请求，断言 index.html 的内联兜底
 *      立即出现「加载失败」与「重新加载」；样式表失败 + 主包晚到不误报；页面级报错 + 主包晚到时加载失败页
 *      会先出现、主包一启动即撤下。
 * 导出走下载兜底：测试前去掉 navigator.share，免得 headless 下弹系统分享面板卡住。
 */
import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { assertPackagesBuilt, e2eApp, serve } from "./e2e-lib.ts";

const PORT = Number(process.env.E2E_DIAG_PORT ?? 4318);
const URL = `http://127.0.0.1:${PORT}/`;
const LOG_KEY = "nexus-app.log";
const { SITE, prepareApp, build, log } = e2eApp("e2e-diag");

function expect(cond: boolean, what: string): void {
  if (!cond) throw new Error(`断言失败：${what}`);
  log(`✓ ${what}`);
}

async function persistedSessions(page: Page): Promise<string[]> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    const list = raw === null ? [] : (JSON.parse(raw) as Array<{ s: string }>);
    return [...new Set(list.map((e) => e.s))];
  }, LOG_KEY);
}

async function main(): Promise<void> {
  assertPackagesBuilt();
  prepareApp();
  build();
  const server = await serve(SITE, PORT);
  const browser = await chromium.launch();
  try {
    // 手机视口：评审在 375 宽上复现过「提示一出现把版本号挤走、按原坐标连点点空」
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 375, height: 667 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL });
    await context.addInitScript(() => {
      delete (Navigator.prototype as { share?: unknown }).share;
      delete (Navigator.prototype as { canShare?: unknown }).canShare;
    });

    const page = await context.newPage();
    await page.goto(URL);
    await page.getByTestId("app-version").waitFor();
    await page.reload();
    await page.getByTestId("app-version").waitFor();
    // 落盘有 1 秒防抖：轮询到两个会话都落盘为止，不靠固定等待
    let afterReload: string[] = [];
    for (let i = 0; i < 50 && afterReload.length < 2; i++) {
      await page.waitForTimeout(100);
      afterReload = await persistedSessions(page);
    }
    expect(afterReload.length === 2, `刷新后持久化里有两个会话（实际 ${afterReload.length}）`);

    const cdp = await context.newCDPSession(page);
    // 渲染进程被杀后 CDP 收不到回包，send 的 Promise 永远不结束：不等它，只等页面的 crash 事件
    const crashed = page.waitForEvent("crash", { timeout: 10_000 });
    void cdp.send("Page.crash").catch(() => undefined);
    await crashed;
    log("会话二的渲染进程已被杀掉");

    const page3 = await context.newPage();
    await page3.goto(URL);
    const badge = page3.getByTestId("app-version");
    await badge.waitFor();
    await page3.evaluate(() => {
      void Promise.reject(new Error("拉取 https://api.test/v1/me?token=secret 失败"));
    });
    const box = await badge.boundingBox();
    if (box === null) throw new Error("版本号没有渲染出可点区域");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    for (let i = 0; i < 3; i++) await page3.mouse.click(x, y);
    await page3.getByRole("status").filter({ hasText: "再点 2 次" }).waitFor({ timeout: 2_000 });
    const moved = await badge.boundingBox();
    expect(moved !== null && moved.x === box.x && moved.y === box.y, "进度提示出现后版本号位置不变");
    for (let i = 0; i < 2; i++) await page3.mouse.click(x, y);
    const panel = page3.getByRole("dialog", { name: "导出诊断信息" });
    await panel.waitFor({ timeout: 2_000 });
    log("连点 5 次打开了诊断面板");
    const [download] = await Promise.all([
      page3.waitForEvent("download", { timeout: 10_000 }),
      panel.getByRole("button", { name: "下载诊断文件" }).click(),
    ]);
    const path = await download.path();
    const text = readFileSync(path, "utf8");
    expect(/^nexus-app-诊断-\d{8}-\d{6}\.txt$/.test(download.suggestedFilename()), `诊断文件名 ${download.suggestedFilename()}`);
    expect(text.includes("## 上次退出\n判词：疑似异常退出"), "上次退出判词为疑似异常退出");
    expect(/版本：v\d+\.\d+\.\d+（构建 \d+）/.test(text), "环境头带版本与构建号");
    const sessions = text.match(/^--- 会话 /gm)?.length ?? 0;
    expect(sessions === 3, `诊断文件含三个会话（实际 ${sessions}）`);
    const blocks = text.split(/^--- 会话 /m).slice(1);
    expect(blocks[0]?.includes("[lifecycle] 页面告别") === true, "会话一那段有页面告别（刷新时正常收场）");
    expect(blocks[1]?.includes("[lifecycle] 页面告别") === false, "会话二那段没有页面告别（被杀进程）");
    expect(text.includes("[error] 未处理的 Promise 拒绝：拉取 https://api.test/v1/me 失败"), "未捕获异常进了日志，URL 保留来源与路径");
    expect(!text.includes("secret"), "诊断文件里没有 URL 查询串里的凭证");
    expect(text.includes("WARN  [lifecycle] 上一局疑似异常退出"), "会话三启动时记下了疑似异常");
    // 性能采集：启动画像、走势段、附录 JSONL（本局长线 + 前几局最后的水位 + 挂载时间点）
    expect(/## 启动画像\n\S+ · v[^\n]*· (mounted|loaded) · /.test(text), "诊断文件有挂载或 load 后采的启动画像");
    expect(text.includes("## 性能走势\n"), "诊断文件有性能走势段");
    const jsonl = text.split("## 性能数据（JSONL）\n")[1] ?? "";
    const kinds = new Set(
      jsonl
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => (JSON.parse(l) as { kind: string }).kind),
    );
    expect(
      ["meta", "trend", "vital", "savedVital", "boot", "milestone"].every((k) => kinds.has(k)),
      `附录 JSONL 有各类行（实际 ${[...kinds].join(",")}）`,
    );
    expect(/"kind":"milestone","name":"mounted"/.test(jsonl), "附录记着挂载时间点");
    const killedSid = /^(\S+?)[，（ ]/.exec(blocks[1] ?? "")?.[1] ?? "?";
    expect(jsonl.includes(`"kind":"savedVital","session":"${killedSid}"`), `附录有被杀那一局（${killedSid}）最后的水位`);
    await panel.getByRole("status").filter({ hasText: "已开始下载" }).waitFor({ timeout: 5_000 });

    await panel.getByRole("button", { name: "复制诊断内容" }).click();
    await panel.getByRole("status").filter({ hasText: "已复制" }).waitFor({ timeout: 5_000 });
    const copied = await page3.evaluate(() => navigator.clipboard.readText());
    expect(copied.startsWith("# 诊断日志") && copied.includes("## 上次退出") && copied.includes("## 日志"), "复制到剪贴板的是完整诊断全文");
    expect(copied.includes("## 性能走势") && !copied.includes("性能数据（JSONL）"), "复制的内容有性能走势、不带 JSONL 附录");
    await panel.getByRole("button", { name: "关闭" }).click();

    // 白屏兜底：让入口代码拿不到 #root，启动即抛错
    const page4 = await context.newPage();
    await page4.addInitScript(() => {
      const original = Document.prototype.getElementById;
      Document.prototype.getElementById = function (id: string) {
        return id === "root" ? null : original.call(this, id);
      };
    });
    await page4.goto(URL);
    const fallback = page4.getByRole("dialog", { name: "应用出错了" });
    await fallback.waitFor({ timeout: 10_000 });
    log("启动失败时出现了整页兜底");
    const [crashDownload] = await Promise.all([
      page4.waitForEvent("download", { timeout: 10_000 }),
      fallback.getByRole("button", { name: "下载诊断文件" }).click(),
    ]);
    const crashText = readFileSync(await crashDownload.path(), "utf8");
    expect(crashText.includes("应用没能启动") && crashText.includes("index.html 缺 #root"), "兜底页导出的诊断文件记着启动失败原因");
    expect(await fallback.getByRole("button", { name: "重新加载" }).isVisible(), "兜底页提供重新加载");
    // 主包加载失败：runtime 的兜底没装上，只能靠 index.html 的内联脚本
    const bare = await browser.newContext({ serviceWorkers: "block" });
    await bare.route(/\/assets\/index-[\w-]+\.js$/, (route) => route.abort());
    const page5 = await bare.newPage();
    const started = Date.now();
    await page5.goto(URL);
    const bootFail = page5.getByRole("alertdialog", { name: "加载失败" });
    await bootFail.waitFor({ timeout: 5_000 });
    expect(Date.now() - started < 5_000, `主包加载失败后 ${Date.now() - started}ms 内出现内联兜底`);
    expect(await bootFail.getByRole("button", { name: "重新加载" }).isVisible(), "内联兜底提供重新加载");
    expect((await page5.evaluate(() => document.documentElement.hasAttribute("data-boot"))) === false, "主包确实没执行（没有启动标记）");
    await bare.close();

    // 误报防线一：样式表加载失败、主包晚到——不算主包失败，不出加载失败页
    const slowCss = await browser.newContext({ serviceWorkers: "block" });
    await slowCss.route(/\.css$/, (route) => route.abort());
    await slowCss.route(/\/assets\/index-[\w-]+\.js$/, async (route) => {
      await new Promise((r) => setTimeout(r, 4_000));
      await route.continue();
    });
    const page6 = await slowCss.newPage();
    await page6.goto(URL);
    await page6.getByTestId("app-version").waitFor({ timeout: 15_000 });
    expect((await page6.getByRole("alertdialog", { name: "加载失败" }).count()) === 0, "样式表失败 + 主包晚到：没有误报加载失败页");
    await slowCss.close();

    // 误报防线二：启动时有页面级报错、主包晚到——加载失败页 2 秒后出现，主包一启动就撤下
    const slowMain = await browser.newContext({ serviceWorkers: "block" });
    await slowMain.addInitScript(() => {
      setTimeout(() => window.dispatchEvent(new ErrorEvent("error", { message: "注入脚本报错" })), 500); // 页面解析之后（兜底脚本已装好）才报错，与真实注入脚本一致
    });
    await slowMain.route(/\/assets\/index-[\w-]+\.js$/, async (route) => {
      await new Promise((r) => setTimeout(r, 4_000));
      await route.continue();
    });
    const page7 = await slowMain.newPage();
    // 不等 load：load 要等被推迟的主包，等到时兜底页早已出现又撤下
    await page7.goto(URL, { waitUntil: "commit" });
    await page7.getByRole("alertdialog", { name: "加载失败" }).waitFor({ timeout: 4_000 });
    await page7.getByTestId("app-version").waitFor({ timeout: 15_000 });
    expect((await page7.getByRole("alertdialog", { name: "加载失败" }).count()) === 0, "主包晚到启动后，已弹出的加载失败页撤下");
    await slowMain.close();

    log("通过：日志跨会话保留 → 杀进程后判疑似异常 → 连点打开面板导出与复制 → 白屏兜底可导出 → 主包加载失败有内联兜底");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[e2e-diag] 失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
