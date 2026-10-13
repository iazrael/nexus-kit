/**
 * 从模板生成新应用：pnpm init-app <目标目录> [--name <包名>] [--title <应用名>] [--app-id <缓存前缀>]
 *
 * - 拷贝 templates/webapp（不带 node_modules/dist/构建计数器）到目标目录；
 * - kit 包的 workspace:* 依赖改写为 git 依赖并钉到当前 kit 版本 tag；
 * - 替换包名、应用名、缓存前缀；目标目录已存在且非空即拒绝（不覆盖任何东西）。
 * 生成后按打印的下一步执行：git init、pnpm install、填 nexus.config.json 的 deploy 段。
 */
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { rewriteKitDeps, KIT_REPO } from "./init-app-lib.ts";

const KIT = resolve(import.meta.dirname, "..");
const TEMPLATE = join(KIT, "templates/webapp");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { name: { type: "string" }, title: { type: "string" }, "app-id": { type: "string" } },
});
const target = positionals[0];
if (target === undefined) {
  console.error("用法：pnpm init-app <目标目录> [--name <包名>] [--title <应用名>] [--app-id <缓存前缀>]");
  process.exit(2);
}
const dest = resolve(process.cwd(), target);
if (existsSync(dest) && readdirSync(dest).length > 0) {
  console.error(`[init-app] ${dest} 已存在且非空，拒绝覆盖`);
  process.exit(1);
}
const name = values.name ?? basename(dest);
const title = values.title ?? name;
const appId = values["app-id"] ?? name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
if (!/^[a-z0-9][a-z0-9-]*$/.test(appId)) {
  console.error(`[init-app] 缓存前缀 ${appId} 非法（只用小写字母、数字、连字符），用 --app-id 指定`);
  process.exit(1);
}

cpSync(TEMPLATE, dest, {
  recursive: true,
  filter: (src) => !/[/\\](node_modules|dist)$/.test(src) && !/\.build-number(\.lock)?$/.test(src),
});

const kitVersion = (JSON.parse(readFileSync(join(KIT, "packages/pwa/package.json"), "utf8")) as { version: string }).version;
const pkgPath = join(dest, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
pkg.name = name;
writeFileSync(pkgPath, `${JSON.stringify(rewriteKitDeps(pkg, kitVersion), null, 2)}\n`);

// pnpm 10 默认拦截依赖的 install 脚本：放行 esbuild，免得每次安装都弹警告（模板在 kit workspace 里由 kit 根配置放行）
writeFileSync(join(dest, "pnpm-workspace.yaml"), "onlyBuiltDependencies:\n  - esbuild\n");

const replaceIn = (rel: string, pairs: Array<[string, string]>): void => {
  const p = join(dest, rel);
  let s = readFileSync(p, "utf8");
  for (const [a, b] of pairs) s = s.split(a).join(b);
  writeFileSync(p, s);
};
replaceIn("pwa.config.ts", [
  ['APP_ID = "nexus-app"', `APP_ID = "${appId}"`],
  ['APP_NAME = "Nexus App"', `APP_NAME = "${title}"`],
]);
replaceIn("index.html", [["Nexus App", title]]);
replaceIn("src/app.tsx", [["Nexus App", title]]);
replaceIn("src/pwa.ts", [['storagePrefix: "nexus-app"', `storagePrefix: "${appId}"`]]);
replaceIn("CLAUDE.md", [["Nexus App", title]]);

console.log(`[init-app] 已生成 ${dest}（kit v${kitVersion}，依赖来自 ${KIT_REPO}）
下一步：
  cd ${target}
  git init -b main && pnpm install && pnpm hooks
  # 换掉 public/ 下的占位图标；填 nexus.config.json 的 deploy 段；改 docs/需求/需求.md
  pnpm check`);
