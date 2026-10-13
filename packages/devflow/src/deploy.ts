/**
 * 生产部署（机制见 docs/架构算法/部署与回滚.md）：把应用 dist 部署到自有服务器。
 *
 * 前置（交付规范「部署」节）：工作树干净、质量门禁全绿、主仓刚构建完。本流程不构建、
 * 不改源码，只做四件事：
 *   1. 校验：主仓（非工作树）+ 指定分支 + 干净 + dist 版本与 package.json 一致 + 产物构建号
 *      自洽（bundle 注入值 == version.json 的 build，防半新半旧产物）。
 *   2. 上传到 releases/.upload-<名>/（先把上一版硬链接克隆过来再 rsync --checksum，未变文件
 *      零传输），传完改名为 releases/<版本>+<构建号>/，再原子切换 current 软链（mv -T）。
 *   3. 服务器回环冒烟（version.json 指纹 + index 200）；失败自动切回部署前版本并确认指纹。
 *      缓存头（更新链关键文件带 private）、gzip、公网边缘 TTL 在上传前对现役响应预检，
 *      不对直接中止、不动线上（首次部署无现役，改在冒烟阶段查）。
 *   4. 清旧版本目录，保留最近 keep 版。
 *
 * 副作用（命令执行、日志）全部经 DeployDeps 注入：决策逻辑单测覆盖，真实执行由 cli 接线。
 */
import { join, resolve } from "node:path";
import type { DeployConfig } from "./config.ts";

export interface DeployDeps {
  /** 本机执行命令，返回 stdout；失败抛错（错误对象带 status） */
  run(cmd: string, args: readonly string[]): string;
  /** 远端执行 shell 命令，返回 stdout；失败抛错（ssh 自身失败 status=255） */
  ssh(remoteCmd: string): string;
  log(message: string): void;
  readFile(path: string): string;
  exists(path: string): boolean;
  /** dist/assets 下全部 JS 文本 */
  readBundleCodes(assetsDir: string): string[];
  /** 断言 bundle 里有构建号字面量（@nexus-kit/vite assertInjectedBuild） */
  assertInjectedBuild(codes: readonly string[], build: number): void;
}

export interface DeployInput {
  config: DeployConfig;
  /** 应用根绝对路径 */
  appRoot: string;
}

export interface DeployResult {
  releaseName: string;
  previous: string | null;
  removed: string[];
}

const SSH_STATUS_CONNECT_FAIL = 255;

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error ? (error as { status?: number }).status : undefined;
}

/** 服务器 version.json 正文 → 「版本+构建号」；非 JSON 抛错 */
export function parseServedFingerprint(body: string): string {
  let served: { version?: unknown; build?: unknown };
  try {
    served = JSON.parse(body) as typeof served;
  } catch {
    throw new Error(`[deploy] 冒烟失败：version.json 不是合法 JSON（前 80 字符：${body.slice(0, 80)}）`);
  }
  return `${String(served.version)}+${String(served.build)}`;
}

/** 从 `ls releases` 输出挑出要清的旧版本（按构建号倒序，保留 keep 版，含本次） */
export function pickStaleReleases(listing: string, keep: number, current: string): string[] {
  return listing
    .split("\n")
    .map((name) => name.trim())
    .map((name) => ({ name, build: Number.parseInt(name.split("+").pop() ?? "", 10) }))
    .filter((e) => e.name !== "" && !e.name.startsWith(".") && Number.isInteger(e.build) && e.name !== current)
    .sort((a, b) => b.build - a.build)
    .slice(Math.max(0, keep - 1))
    .map((e) => e.name);
}

/** 现役目录名 → 构建号（解析不出返回 null） */
export function buildOfReleaseDir(dir: string): number | null {
  const name = dir.split("/").pop() ?? "";
  const build = Number.parseInt(name.split("+")[1] ?? "", 10);
  return Number.isInteger(build) ? build : null;
}

export function cacheControlOf(headers: string): string {
  return /^cache-control:\s*(.*)$/im.exec(headers)?.[1]?.trim() ?? "";
}

export function runDeploy(input: DeployInput, deps: DeployDeps): DeployResult {
  const { config: cfg } = input;
  const appRoot = resolve(input.appRoot);
  const dist = join(appRoot, "dist");
  const local = `http://127.0.0.1:${cfg.localPort}`;
  const step = (m: string): void => deps.log(`[deploy] ${m}`);
  const switchCurrent = (dir: string): void => {
    deps.ssh(
      `set -e; ln -sfn '${dir}' '${cfg.remoteRoot}/.current.new' && mv -T '${cfg.remoteRoot}/.current.new' '${cfg.remoteRoot}/current'`,
    );
  };
  const fetchServed = (): string => parseServedFingerprint(deps.ssh(`curl -fsS --max-time 20 ${local}/version.json`));

  const checkHeaders = (): void => {
    const uncompressed = cfg.gzipRequired.filter((path) => {
      const headers = deps.ssh(`curl -fsS -o /dev/null -D - -H 'Accept-Encoding: gzip' --max-time 30 '${local}${path}'`);
      return !/^content-encoding:\s*gzip/im.test(headers);
    });
    if (uncompressed.length > 0) throw new Error(`[deploy] 压缩检查失败：${uncompressed.join(", ")} 未 gzip 下发（检查 nginx gzip_types）`);
    const missing = cfg.privateRequired.filter(
      (path) => !/\bprivate\b/i.test(cacheControlOf(deps.ssh(`curl -fsSI --max-time 20 '${local}${path}'`))),
    );
    if (missing.length > 0)
      throw new Error(`[deploy] 缓存头检查失败：${missing.join(", ")} 的 Cache-Control 缺 private（检查服务器 nginx 配置）`);
    if (cfg.publicUrl === "") return;
    const overridden = cfg.edgeTtlProbes
      .map((path) => {
        let headers: string;
        try {
          headers = deps.run("curl", ["-fsSI", "--max-time", "20", `${cfg.publicUrl}${path}`]);
        } catch (error) {
          throw new Error(`[deploy] 公网探针取不到 ${cfg.publicUrl}${path}（${String(error).slice(0, 120)}）`, { cause: error });
        }
        return { path, value: cacheControlOf(headers) };
      })
      .filter(({ value }) => /max-age=[1-9]/i.test(value));
    if (overridden.length > 0) {
      throw new Error(
        `[deploy] 缓存头检查失败：${overridden.map((o) => `${o.path}「${o.value}」`).join("、")} 被 CDN 覆写了浏览器 TTL——检查 CDN 缓存规则「浏览器 TTL 遵循源站」`,
      );
    }
  };

  // 1. 前置校验
  const gitDir = deps.run("git", ["rev-parse", "--git-dir"]).trim();
  const commonDir = deps.run("git", ["rev-parse", "--git-common-dir"]).trim();
  if (gitDir !== commonDir) throw new Error(`[deploy] 当前在工作树（${gitDir}）——生产部署只在主仓执行`);
  const branch = deps.run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch !== cfg.branch) {
    throw new Error(`[deploy] ${branch === "HEAD" ? "处于游离 HEAD" : `当前分支 ${branch}`}——生产部署只发 ${cfg.branch}`);
  }
  if (deps.run("git", ["status", "--porcelain"]).trim() !== "") throw new Error("[deploy] 工作树不干净——部署前必须全部提交");
  if (!deps.exists(join(dist, "version.json"))) throw new Error("[deploy] dist/version.json 不存在——先在主仓构建");
  const pkg = JSON.parse(deps.readFile(join(appRoot, "package.json"))) as { version?: unknown };
  const manifest = JSON.parse(deps.readFile(join(dist, "version.json"))) as { version?: unknown; build?: unknown };
  if (manifest.version !== pkg.version) {
    throw new Error(`[deploy] dist 版本过期：version.json=${String(manifest.version)}，仓库=${String(pkg.version)}——重新构建`);
  }
  // 版本与构建号会拼进 ssh 命令与远端目录名：只认纯 X.Y.Z 与正整数，杜绝引号注入
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error(`[deploy] version.json 的 version 必须是纯 X.Y.Z：${String(manifest.version)}`);
  }
  if (typeof manifest.build !== "number" || !Number.isInteger(manifest.build) || manifest.build < 1) {
    throw new Error("[deploy] version.json 的 build 必须是正整数");
  }
  deps.assertInjectedBuild(deps.readBundleCodes(join(dist, "assets")), manifest.build);

  const releaseName = `${String(manifest.version)}+${manifest.build}`;
  const releaseDir = `${cfg.remoteRoot}/releases/${releaseName}`;
  step(`目标 ${cfg.target}:${releaseDir}`);
  // 同名目录已存在 = 该构建号部署过；重跑会原地改写可能正被 current 指着的版本，打穿「旧版可回滚」
  try {
    deps.ssh(`test ! -d '${releaseDir}'`);
  } catch (error) {
    if (statusOf(error) === SSH_STATUS_CONNECT_FAIL)
      throw new Error(`[deploy] 连不上 ${cfg.target}（ssh 退出码 255）——检查网络后重跑`, { cause: error });
    throw new Error(`[deploy] ${releaseDir} 已存在——同名构建拒绝重部署，重新构建取新构建号`, { cause: error });
  }
  const previous = deps.ssh(`readlink '${cfg.remoteRoot}/current' || true`).trim() || null;
  // 构建号单调防线：升级检测只认「本地 build < 远端 build」，号回退的版本上线后老用户升级弹窗永久失明
  if (previous !== null) {
    const servedBuild = buildOfReleaseDir(previous);
    if (servedBuild !== null && manifest.build <= servedBuild) {
      throw new Error(
        `[deploy] 新构建号 ${manifest.build} ≤ 线上现役 ${servedBuild}——构建计数器疑似回退：把线上 version.json 的 build 写回计数器再重新构建`,
      );
    }
    checkHeaders();
  }

  // 2. 上传 → 改名 → 原子切换
  const staging = `${cfg.remoteRoot}/releases/.upload-${releaseName}`;
  deps.ssh(
    `set -e; mkdir -p '${cfg.remoteRoot}/releases'; rm -rf '${staging}'` +
      (previous !== null ? ` && cp -al '${previous}' '${staging}'` : ""),
  );
  deps.run("rsync", ["-az", "--delete", "--checksum", `${dist}/`, `${cfg.target}:${staging}/`]);
  deps.ssh(`mv -T '${staging}' '${releaseDir}'`);
  step("上传完成，切换 current 软链");
  switchCurrent(releaseDir);

  // 3. 冒烟；失败即回滚
  try {
    const served = fetchServed();
    if (served !== releaseName) throw new Error(`[deploy] 冒烟失败：服务器 version.json=${served}，应为 ${releaseName}`);
    const status = deps.ssh(`curl -fsSo /dev/null --max-time 20 -w '%{http_code}' ${local}/`).trim();
    if (!status.endsWith("200")) throw new Error(`[deploy] 冒烟失败：index.html 状态 ${status}`);
    if (previous === null) checkHeaders();
  } catch (error) {
    if (previous === null) {
      step("冒烟失败，且部署前没有现役版本可回滚——线上保持新版本，请人工处理");
      throw error;
    }
    try {
      switchCurrent(previous);
    } catch (rollbackError) {
      step(`回滚失败！current 仍指向 ${releaseDir}（冒烟未通过），需要立刻人工切回 ${previous}`);
      step(`冒烟失败原因：${String(error).slice(0, 300)}`);
      throw rollbackError;
    }
    let rolledBack: string;
    try {
      rolledBack = fetchServed();
    } catch (verifyError) {
      rolledBack = `无法确认（${String(verifyError).slice(0, 120)}）`;
    }
    step(`冒烟失败，已回滚 current → ${previous}（线上 version.json=${rolledBack}）`);
    throw error;
  }
  step("冒烟通过（version.json 指纹一致，index.html 200）");

  // 4. 清旧
  const removed = pickStaleReleases(deps.ssh(`ls -1 '${cfg.remoteRoot}/releases'`), cfg.keep, releaseName);
  if (removed.length > 0) {
    deps.ssh(`rm -rf ${removed.map((n) => `'${cfg.remoteRoot}/releases/${n}'`).join(" ")}`);
    step(`清理旧版本：${removed.join(", ")}`);
  }
  step(`完成：现役 ${releaseName}`);
  return { releaseName, previous, removed };
}
