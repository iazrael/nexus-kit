/**
 * 发版一条命令与发版锁（机制见 docs/架构算法/并行开发与发版.md；取材 旧项目A scripts/release.mjs）。
 *
 * 发版锁 = <git 公共目录>/nexus-release.lock（JSON：version、token、ref、startedAt、expires 为 epoch 秒、pid）。
 * reference-transaction 钩子（hooks.ts）读它：锁在、未过期、事务要改锁住的主干、环境变量
 * NEXUS_RELEASE_TOKEN 与锁内 token 不符 → 拒绝。快进合并不触发 pre-merge-commit，一切引用变更都
 * 经过 reference-transaction，所以锁只能挂在这一层。锁防的是不知情的并发合入；git -c core.hooksPath=
 * 可整体跳钩子，存心绕过不在防范范围内。
 *
 * 固定链：前置校验（主仓库 + 主干 + 干净 + 落款小节合格 + tag 未占用）→ 不带 ack 报范围与门禁后拒绝
 * → 放锁（或认领 release --lock 放的锁）→ release.steps 逐步执行、每步后核对 HEAD 未变 → 打 tag →
 * 推送主干与 tag → GitHub Release（可选）→ 收锁（finally，失败也收）。
 *
 * 命令执行、时钟、令牌、CHANGELOG 解析经 ReleaseDeps 注入；锁文件读写走真文件系统。
 */
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseConfig } from "./config.ts";

export const RELEASE_LOCK = "nexus-release.lock";
/** 发版执行人持令豁免的环境变量 */
export const TOKEN_ENV = "NEXUS_RELEASE_TOKEN";

export interface ReleaseLock {
  /** 发布中的版本；release --lock 放锁时还不知道，记 "pending" */
  version: string;
  token: string;
  /** 被冻结的引用，如 refs/heads/main */
  ref: string;
  startedAt: string;
  /** 失效时刻（epoch 秒，与钩子里 date +%s 同单位） */
  expires: number;
  pid: number;
}

/** 读锁（不存在、不是 JSON、缺字段 → null） */
export function readReleaseLock(path: string): ReleaseLock | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.expires !== "number" || !Number.isFinite(o.expires) || typeof o.token !== "string" || typeof o.ref !== "string") {
    return null;
  }
  return {
    version: typeof o.version === "string" ? o.version : "?",
    token: o.token,
    ref: o.ref,
    startedAt: typeof o.startedAt === "string" ? o.startedAt : "",
    expires: o.expires,
    pid: typeof o.pid === "number" ? o.pid : 0,
  };
}

const epochSec = (d: Date): number => Math.floor(d.getTime() / 1000);

function lockBody(lock: ReleaseLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** 原地更新锁：写临时文件再改名，钩子任何时刻读到的都是完整内容（读到残缺会 fail-open 放行） */
function rewriteLockFile(path: string, lock: ReleaseLock): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, lockBody(lock));
  renameSync(temp, path);
}

/** 独占创建锁文件（wx）：两个放锁同时过存在性检查时，后到的在这里失败，不放双锁 */
function createLockFile(path: string, lock: ReleaseLock): void {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch {
    throw new Error(`[release] 发版锁刚被并发创建（${path}）——不重复放锁`);
  }
  try {
    writeSync(fd, lockBody(lock));
  } finally {
    closeSync(fd);
  }
}

/**
 * 手动放锁（release --lock）：发版令下达即冻结主干，直到发版链收锁。已有未过期锁拒绝重放；
 * 过期锁替换。返回新锁（调用方把 token 告诉发版执行人）。
 */
export function holdReleaseLock(
  commonDir: string,
  opts: { ref: string; ttlMin: number; now: Date; token: string; pid: number },
): ReleaseLock {
  const path = join(commonDir, RELEASE_LOCK);
  const existing = readReleaseLock(path);
  if (existing !== null && existing.expires > epochSec(opts.now)) {
    throw new Error(
      `[release] 发版锁已在放（${path}，v${existing.version}，至 ${new Date(existing.expires * 1000).toLocaleTimeString()}）——` +
        "主干已冻结，无需重放；确认是残留可 release --unlock",
    );
  }
  if (existsSync(path)) rmSync(path);
  const lock: ReleaseLock = {
    version: "pending",
    token: opts.token,
    ref: opts.ref,
    startedAt: opts.now.toISOString(),
    expires: epochSec(opts.now) + opts.ttlMin * 60,
    pid: opts.pid,
  };
  createLockFile(path, lock);
  return lock;
}

/** 清锁；返回是否真删了 */
export function clearReleaseLock(commonDir: string): boolean {
  const path = join(commonDir, RELEASE_LOCK);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export interface ReleaseDeps {
  /** 在调用目录执行 git，返回去掉首尾空白的 stdout；失败抛错 */
  git(args: readonly string[]): string;
  /** 执行发版步骤（输出直通终端）；失败抛错 */
  run(cmd: string, args: readonly string[]): void;
  log(message: string): void;
  now(): Date;
  /** 随机令牌 */
  token(): string;
  pid: number;
  /** CHANGELOG 里 `## [version]` 小节的日期与全量条目（含留档条目）；没有该小节 → null */
  changelogSection(markdown: string, version: string): { date: string; entries: string[] } | null;
  internalPrefix: string;
  wipPrefix: string;
}

export interface ReleaseInput {
  /** 调用目录（必须是主仓库根） */
  repoRoot: string;
  /** 应用根绝对路径（package.json 与 dist/ 所在） */
  appRoot: string;
  changelogPath: string;
  /** 主干分支 */
  base: string;
  config: ReleaseConfig;
  /** 发版前两道门禁（全量变更整体评审 + 对外条目实机走查）已完成 */
  ack: boolean;
}

/** 本地时区的今天（YYYY-MM-DD）：落款日期按发版人所在时区写，北京时间凌晨发版时 UTC 还是昨天 */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function runRelease(input: ReleaseInput, deps: ReleaseDeps): void {
  const step = (m: string): void => deps.log(`[release] ${m}`);
  const now = deps.now();
  const today = localDay(now);

  // ─── 1. 前置校验：主仓库 + 主干 + 干净 ───
  const gitDir = resolve(input.repoRoot, deps.git(["rev-parse", "--git-dir"]));
  const commonDir = resolve(input.repoRoot, deps.git(["rev-parse", "--git-common-dir"]));
  if (gitDir !== commonDir) throw new Error("[release] 当前在工作树里——发版在主仓库执行（落款在工作树完成并合回主干后再发）");
  const branch = deps.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== input.base) throw new Error(`[release] 当前分支 ${branch} 不是 ${input.base}——发版只发主干`);
  if (deps.git(["status", "--porcelain"]) !== "") throw new Error("[release] 工作区不干净——先全部提交再发版");

  // ─── 2. 认领 release --lock 放的锁：续期并写入实际版本号 ───
  // 放在落款校验之前：持锁续期是发版窗口内的事，后面的校验失败不该让锁掉线
  const lockPath = join(commonDir, RELEASE_LOCK);
  const ref = `refs/heads/${input.base}`;
  const pkg = readJson(join(input.appRoot, "package.json"));
  const version = typeof pkg?.version === "string" ? pkg.version : "";
  if (version === "") throw new Error(`[release] ${join(input.appRoot, "package.json")} 读不到 version`);
  const ttlSec = input.config.lockTtlMin * 60;
  let adopted: ReleaseLock | null = null;
  if (existsSync(lockPath)) {
    const st = readReleaseLock(lockPath);
    if (st === null || st.expires <= epochSec(now)) {
      throw new Error(`[release] 发版锁已存在但已过期或损坏（${lockPath}）——确认没有发版在跑后 release --unlock 再重试`);
    }
    adopted = { ...st, version, ref, expires: epochSec(now) + ttlSec, pid: deps.pid };
    rewriteLockFile(lockPath, adopted);
    step(`认领已放的发版锁（主干冻结中），续期 ${input.config.lockTtlMin} 分钟——链末自动收锁`);
  }

  // ─── 3. 落款小节与 tag ───
  const section = deps.changelogSection(readFileSync(input.changelogPath, "utf8"), version);
  if (section === null) {
    throw new Error(`[release] CHANGELOG 缺 [${version}] 落款小节——先把 Unreleased 整合为 \`## [${version}] - ${today}\` 并合回主干`);
  }
  const external = section.entries.filter((e) => !e.startsWith(deps.internalPrefix) && !e.startsWith(deps.wipPrefix));
  if (external.length === 0) throw new Error(`[release] [${version}] 小节没有对外条目（全是内部/WIP）——对外为空的版本不发`);
  const wip = section.entries.filter((e) => e.startsWith(deps.wipPrefix));
  if (wip.length > 0) {
    throw new Error(`[release] [${version}] 小节混入 ${wip.length} 条「${deps.wipPrefix}」条目——未开放功能不随版落款，先挪回 Unreleased`);
  }
  if (section.date !== today) throw new Error(`[release] [${version}] 小节日期不是今天（${section.date || "缺"} ≠ ${today}）——先改正再发`);
  let tagTaken = true;
  try {
    deps.git(["rev-parse", "-q", "--verify", `refs/tags/v${version}`]);
  } catch {
    tagTaken = false;
  }
  if (tagTaken) {
    throw new Error(
      `[release] tag v${version} 已存在——上次发版走到了 tag 之后。核对线上与远端：只差 Release 没建就单独补；` +
        `确认要重跑整链，先删远端与本地 tag（git push origin :refs/tags/v${version} && git tag -d v${version}）`,
    );
  }

  // ─── 4. 发版范围（评审范围提示）───
  let range = "HEAD";
  try {
    range = `${deps.git(["describe", "--abbrev=0", "--tags", "--match=v*"])}..HEAD`;
  } catch {
    // 首次发版没有 tag：范围是全部历史
  }
  const count = deps.git(["rev-list", "--count", range]);
  step(`发版 v${version}：${range} 共 ${count} 个提交，对外条目 ${external.length} 条`);

  if (!input.ack) {
    throw new Error(
      `[release] 未带 --ack：发版前两道门禁还没确认——\n` +
        `  ① 整体评审：对 ${range} 的全量变更跑一遍独立代码评审（抓批次之间互相踩脚）；\n` +
        `  ② 实机走查：本版 ${external.length} 条对外条目逐条在真机上过一遍。\n` +
        "两道做完再 release --ack。",
    );
  }

  // ─── 5. 放锁 + 固定链 ───
  let mine: ReleaseLock;
  if (adopted === null) {
    mine = { version, token: deps.token(), ref, startedAt: now.toISOString(), expires: epochSec(now) + ttlSec, pid: deps.pid };
    createLockFile(lockPath, mine);
    step(`发版锁已放：${input.base} 冻结（每步开始前续期 ${input.config.lockTtlMin} 分钟，链末自动收）`);
  } else {
    mine = adopted;
  }
  /** 每步开始前续期：链比有效期长时主干不中途解冻；锁被别人清除或替换即中止 */
  const renew = (): void => {
    if (readReleaseLock(lockPath)?.token !== mine.token) {
      throw new Error(`[release] 发版锁在链中被清除或替换（${lockPath}）——中止，确认没有另一场发版后重发`);
    }
    mine = { ...mine, expires: epochSec(deps.now()) + ttlSec };
    rewriteLockFile(lockPath, mine);
  };
  const startSha = deps.git(["rev-parse", "HEAD"]);
  try {
    for (const [cmd, ...args] of input.config.steps) {
      renew();
      step([cmd, ...args].join(" "));
      deps.run(cmd!, args);
      const head = deps.git(["rev-parse", "HEAD"]);
      if (head !== startSha) {
        throw new Error(
          `[release] HEAD 在链中变化（${startSha.slice(0, 8)} → ${head.slice(0, 8)}）——中止，线上可能已与本地代码脱节，人工核对后重发`,
        );
      }
    }

    renew();
    step(`打 tag v${version}`);
    deps.git(["tag", `v${version}`]);
    if (input.config.push) {
      step(`推送 ${input.base} 与 v${version} 到 origin`);
      deps.git(["push", "origin", input.base, `v${version}`]);
    }
    if (input.config.githubRelease) {
      const manifest = readJson(join(input.appRoot, "dist", "version.json"));
      const build = typeof manifest?.build === "number" ? `+b${manifest.build}` : "";
      const tmp = mkdtempSync(join(tmpdir(), "nexus-release-"));
      const notes = join(tmp, "notes.md");
      writeFileSync(notes, `${section.entries.map((e) => `- ${e}`).join("\n")}\n\n---\n构建 ${version}${build} · ${today}\n`);
      try {
        step("创建 GitHub Release");
        deps.run("gh", ["release", "create", `v${version}`, "--title", `v${version}`, "--notes-file", notes]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  } finally {
    // 只收自己的锁：链中被人 --unlock 后又重放的锁不归本链
    if (readReleaseLock(lockPath)?.token === mine.token) {
      rmSync(lockPath);
      step(`发版锁已收：${input.base} 解冻`);
    }
  }
  step(`完成：v${version} 已发布`);
}
