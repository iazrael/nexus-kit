/**
 * 升级链真机级 e2e（真 Service Worker + 真浏览器）：
 *   1. 把模板拷到 temp/e2e-app（软链复用 node_modules），构建 v1，起本地静态服务（缓存头按
 *      nginx 样板：更新链文件 no-cache）；
 *   2. Chromium 打开，等 SW 接管、记下页面上的版本号；
 *   3. 进位到 v1 的下一个补丁版本并加一条 CHANGELOG 对外条目，重新构建覆盖站点；
 *   4. 点「检查更新」→ 断言弹窗出现、条目可见 → 点「立即更新」→ 断言页面刷新进新版本。
 * 只动 temp/ 下的副本，不改模板本身。用法：pnpm e2e（先 pnpm build 产出各包 dist）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { assertPackagesBuilt, e2eApp, serve } from "./e2e-lib.ts";

const PORT = Number(process.env.E2E_PORT ?? 4317);
const NOTE = "新增：端到端升级验证条目";
const { APP, SITE, prepareApp, build, log } = e2eApp("e2e");

function bumpVersion(): string {
  const pkgPath = join(APP, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  const [maj, min, pat] = pkg.version.split(".").map(Number) as [number, number, number];
  const next = `${maj}.${min}.${pat + 1}`;
  pkg.version = next;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const clPath = join(APP, "CHANGELOG.md");
  const cl = readFileSync(clPath, "utf8").replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${next}] - 2026-10-13\n\n- ${NOTE}\n`);
  writeFileSync(clPath, cl);
  return next;
}

async function main(): Promise<void> {
  assertPackagesBuilt();
  prepareApp();
  build();
  const server = await serve(SITE, PORT);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") log(`页面错误：${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 30_000 });
    const v1 = (await page.getByTestId("app-version").getAttribute("data-version")) ?? "";
    log(`v1 已被 SW 接管：${v1}`);

    const next = bumpVersion();
    build();
    log(`服务器已换成 v${next}`);

    await page.getByRole("button", { name: "检查更新" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: "发现新版本" }).waitFor({ timeout: 15_000 });
    await dialog.getByText(`最新 v${next}`, { exact: false }).waitFor();
    await dialog.getByText(NOTE).waitFor();
    log("升级弹窗出现，条目正确");

    await Promise.all([page.waitForEvent("load", { timeout: 60_000 }), dialog.getByRole("button", { name: "立即更新" }).click()]);
    await page.waitForFunction(
      (want) => document.querySelector('[data-testid="app-version"]')?.getAttribute("data-version")?.startsWith(want),
      `v${next}+`,
      {
        timeout: 30_000,
      },
    );
    const v2 = (await page.getByTestId("app-version").getAttribute("data-version")) ?? "";
    log(`刷新后运行 ${v2}`);
    if (!v2.startsWith(`v${next}+`)) throw new Error(`升级后版本不对：${v2}`);
    await page
      .getByRole("status")
      .filter({ hasText: `已更新到 v${next}` })
      .waitFor({ timeout: 5_000 });
    log("升级成功提示出现");

    // 再次检查：已是最新，不再弹窗
    await page.getByRole("button", { name: "检查更新" }).click();
    await page.getByRole("status").filter({ hasText: "已是最新版本" }).waitFor({ timeout: 15_000 });
    log("通过：检测 → 弹窗 → 确认 → 下载 → 切换 → 刷新进新版，再查为最新");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[e2e] 失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
