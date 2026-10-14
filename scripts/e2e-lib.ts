/**
 * 真浏览器 e2e 的共用部分：把模板拷到 .e2e/<名>-app（软链复用 node_modules）、构建并发布到
 * .e2e/<名>-site（专用目录，整个可再生：kit 的 worktree.disposable 登记了它，回收工作树不拦）、起本地静态服务（缓存头按 nginx 样板：更新链文件 no-cache、带哈希资源 immutable）。
 * 每个 e2e 用自己的目录名，互不覆盖。只动 .e2e/ 下的副本，不改模板本身。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve, sep } from "node:path";

export const KIT = resolve(import.meta.dirname, "..");
const TEMPLATE = join(KIT, "templates/webapp");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};
const NO_CACHE = new Set(["/", "/index.html", "/sw.js", "/version.json", "/manifest.webmanifest"]);

/** 每个 kit 包都要有 dist（模板经 workspace 依赖直接吃 dist） */
export function assertPackagesBuilt(): void {
  for (const dir of readdirSync(join(KIT, "packages"))) {
    if (!existsSync(join(KIT, "packages", dir, "package.json"))) continue;
    if (!existsSync(join(KIT, "packages", dir, "dist"))) throw new Error(`packages/${dir}/dist 不存在——先跑 pnpm build`);
  }
}

export function e2eApp(name: string) {
  const APP = join(KIT, `.e2e/${name}-app`);
  const SITE = join(KIT, `.e2e/${name}-site`);
  const tag = `[${name}]`;
  return {
    APP,
    SITE,
    log: (m: string): void => console.log(`${tag} ${m}`),
    prepareApp(): void {
      rmSync(APP, { recursive: true, force: true });
      mkdirSync(APP, { recursive: true });
      cpSync(TEMPLATE, APP, {
        recursive: true,
        filter: (src) => !/[/\\](node_modules|dist)$/.test(src) && !src.endsWith(".build-number"),
      });
      symlinkSync(join(TEMPLATE, "node_modules"), join(APP, "node_modules"));
    },
    build(): void {
      execFileSync("pnpm", ["exec", "vite", "build"], { cwd: APP, stdio: ["ignore", "ignore", "inherit"] });
      execFileSync("node", ["scripts/verify-build.ts"], { cwd: APP, stdio: "inherit" });
      rmSync(SITE, { recursive: true, force: true });
      cpSync(join(APP, "dist"), SITE, { recursive: true });
    },
  };
}

export function serve(site: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    let file = join(site, path === "/" ? "index.html" : path);
    if (!file.startsWith(site + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(site, "index.html");
    res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
    res.setHeader(
      "Cache-Control",
      NO_CACHE.has(path) ? "private, no-cache" : path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    );
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}
