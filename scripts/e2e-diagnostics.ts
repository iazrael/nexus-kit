/**
 * 日志与异常退出取证的真浏览器 e2e：
 *   1. 模板构建发布到 temp/e2e-diag-site，Chromium 打开（会话一）；
 *   2. 刷新（会话一正常告别 → 会话二），断言上一会话的日志读回来了；
 *   3. 等日志落盘后用 CDP Page.crash 杀掉渲染进程（不会有 pagehide），新开页面（会话三）；
 *   4. 会话三里抛一个没人处理的 Promise 拒绝（消息带 ?token=secret 的 URL）；
 *   5. 按版本号的固定坐标连点 5 次（手指不会追着元素走），导出诊断文件；断言提示出现后版本号没被挤动，断言：判词为疑似异常退出、三个会话都在、会话一那段有「页面告别」、
 *      未捕获异常进了日志且 URL 的查询串已去掉。
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
    const [download] = await Promise.all([
      page3.waitForEvent("download", { timeout: 10_000 }),
      (async () => {
        for (let i = 0; i < 2; i++) await page3.mouse.click(x, y);
      })(),
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
    await page3.getByRole("status").filter({ hasText: "已开始下载诊断文件" }).waitFor({ timeout: 5_000 });
    log("通过：日志跨会话保留 → 杀进程后判疑似异常 → 连点导出诊断文件");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[e2e-diag] 失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
