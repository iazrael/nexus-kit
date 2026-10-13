/**
 * 升级链真机级 e2e（真 Service Worker + 真浏览器）：
 *   1. 把模板拷到 temp/e2e-app（软链复用 node_modules），构建 v1，起本地静态服务（缓存头按
 *      nginx 样板：更新链文件 no-cache）；
 *   2. Chromium 打开，等 SW 接管、记下页面上的版本号；
 *   3. 进位到 v1 的下一个补丁版本并加一条 CHANGELOG 对外条目，重新构建覆盖站点；
 *   4. 点「检查更新」→ 断言弹窗出现、条目可见 → 点「立即更新」→ 断言页面刷新进新版本。
 * 只动 temp/ 下的副本，不改模板本身。用法：pnpm e2e（先 pnpm build 产出各包 dist）。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const KIT = resolve(import.meta.dirname, "..");
const TEMPLATE = join(KIT, "templates/webapp");
const APP = join(KIT, "temp/e2e-app");
const SITE = join(KIT, "temp/e2e-site");
const PORT = Number(process.env.E2E_PORT ?? 4317);
const NOTE = "新增：端到端升级验证条目";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};
const NO_CACHE = new Set(["/", "/index.html", "/sw.js", "/version.json", "/manifest.webmanifest"]);

function log(m: string): void {
  console.log(`[e2e] ${m}`);
}

function prepareApp(): void {
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  cpSync(TEMPLATE, APP, { recursive: true, filter: (src) => !/[/\\](node_modules|dist)$/.test(src) && !src.endsWith(".build-number") });
  symlinkSync(join(TEMPLATE, "node_modules"), join(APP, "node_modules"));
}

function build(): void {
  execFileSync("pnpm", ["exec", "vite", "build"], { cwd: APP, stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("node", ["scripts/verify-build.ts"], { cwd: APP, stdio: "inherit" });
  rmSync(SITE, { recursive: true, force: true });
  cpSync(join(APP, "dist"), SITE, { recursive: true });
}

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

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    let file = join(SITE, path === "/" ? "index.html" : path);
    if (!file.startsWith(SITE) || !existsSync(file) || statSync(file).isDirectory()) file = join(SITE, "index.html");
    res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
    res.setHeader(
      "Cache-Control",
      NO_CACHE.has(path) ? "private, no-cache" : path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    );
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(PORT, "127.0.0.1", () => r(server)));
}

async function main(): Promise<void> {
  for (const pkg of ["pwa", "pwa-react", "vite", "devflow"]) {
    if (!existsSync(join(KIT, "packages", pkg, "dist"))) throw new Error(`packages/${pkg}/dist 不存在——先跑 pnpm build`);
  }
  prepareApp();
  build();
  const server = await serve();
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
