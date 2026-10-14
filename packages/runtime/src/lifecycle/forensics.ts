/**
 * 异常退出取证（机制见 docs/架构算法/日志与诊断.md）：用户说「刚才闪退了」时，开发者要知道上一局是
 * 正常关的还是被系统杀的。
 *
 * 会话表（localStorage `<前缀>.sessions`）：每个会话一行 { openAt, aliveAt, exitAt? }。启动时写本行；
 * 每 heartbeatMs 与切后台时刷新 aliveAt；pagehide 写 exitAt。每次更新都「读整表 → 只改本行 → 写回」，
 * 同一应用开在多个窗口（主屏 PWA 加浏览器标签）时各写各的行，互不覆盖。
 *
 * 判词只针对「本局之外最近开启的那个会话」（多窗口时更早崩溃的会话会被它盖住，不再单独报告）：有 exitAt = 正常；仍在运行（开在别的窗口）= 无法判定；其余 =
 * 疑似异常。「仍在运行」靠 Web Locks 判：每个会话持有一把 `<前缀>.alive.<会话号>` 锁，页面关闭或进程
 * 被杀时浏览器自动释放，所以锁还在 = 活着、锁不在 = 已结束——闪退后马上重开，上一局几秒前刚有心跳，
 * 也能判出疑似异常。查询是异步的：verdict 先给初值，settled 落定后更新；不支持 Web Locks 的环境
 * （Safari 15.4 以前）退回心跳规则：两个心跳周期内还有心跳的判无法判定。疑似异常只说明缺少正常关闭的凭证，不证明死因或死亡时刻：Safari 没有
 * freeze/resume 事件，系统杀进程时 pagehide 不保证执行，用户从多任务里划掉也表现为没有告别。
 * 从往返缓存（bfcache）恢复是同一局复活，要撤销 exitAt，否则下次会误判正常关闭。
 *
 * 表的读写失败不抛错（诊断不能把页面搞挂），同一类失败只记一次日志，免得存储满时每 30 秒刷一条。
 */
import type { LogStore } from "../log/store.ts";
import { errText, formatTime, safeGlobalStorage, type StorageLike } from "../util.ts";

export type ExitVerdict =
  | { kind: "first-run" }
  | { kind: "clean"; endedAt: number }
  /** lastAliveAt：上一局最后有动静的时刻（心跳与日志中最晚的），不是死亡时刻 */
  | { kind: "abrupt"; lastAliveAt: number }
  | { kind: "unknown"; reason: string };

interface Row {
  openAt: number;
  aliveAt: number;
  exitAt?: number;
}
type Table = Record<string, Row>;

/** 会话表保留的其他会话行数（本局与仍有心跳的不计） */
const KEEP_OTHERS = 5;
/** 存活锁查询的等待上限：超时按心跳规则落定，判词不永远悬着 */
const LOCK_QUERY_TIMEOUT_MS = 3000;

function isRow(v: unknown): v is Row {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.openAt === "number" && typeof o.aliveAt === "number" && (o.exitAt === undefined || typeof o.exitAt === "number");
}

/** 会话表原文 → 表；null = 没有；"bad" = 损坏或结构不对 */
function parseTable(raw: string | null): Table | null | "bad" {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return "bad";
    const sessions = (v as Record<string, unknown>).sessions;
    if (typeof sessions !== "object" || sessions === null) return "bad";
    const out: Table = {};
    for (const [id, row] of Object.entries(sessions)) {
      if (!isRow(row)) return "bad";
      out[id] = row;
    }
    return out;
  } catch {
    return "bad";
  }
}

/** 会话表原文 → 上一局判词（纯函数）。excludeSession 是本局（启动早期表里还没有本局，可不传） */
export function interpretLastExit(
  raw: string | null,
  now: number,
  heartbeatMs: number,
  excludeSession?: string,
  /** 仍在运行的会话（Web Locks 查得）；不知道时不传，退回心跳规则 */
  running?: ReadonlySet<string>,
): { verdict: ExitVerdict; previousSession: string | null } {
  const table = parseTable(raw);
  if (table === "bad") return { verdict: { kind: "unknown", reason: "会话表损坏" }, previousSession: null };
  const others = Object.entries(table ?? {}).filter(([id]) => id !== excludeSession);
  if (others.length === 0) return { verdict: { kind: "first-run" }, previousSession: null };
  const [id, row] = others.reduce((a, b) => (b[1].openAt > a[1].openAt ? b : a));
  if (row.exitAt !== undefined) return { verdict: { kind: "clean", endedAt: row.exitAt }, previousSession: id };
  if (running !== undefined) {
    if (running.has(id)) return { verdict: { kind: "unknown", reason: "上一会话仍开在其他窗口里" }, previousSession: id };
    return { verdict: { kind: "abrupt", lastAliveAt: row.aliveAt }, previousSession: id };
  }
  if (now - row.aliveAt <= heartbeatMs * 2) {
    const ago = Math.round((now - row.aliveAt) / 1000);
    return {
      verdict: { kind: "unknown", reason: `上一会话 ${ago} 秒前还有心跳，可能仍开在其他窗口里` },
      previousSession: id,
    };
  }
  return { verdict: { kind: "abrupt", lastAliveAt: row.aliveAt }, previousSession: id };
}

/** Web Locks 的最小形状（生产即 navigator.locks） */
export interface LockManagerLike {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: ReadonlyArray<{ name?: string }> }>;
}

export interface ForensicsOptions {
  /** 会话表键 `${prefix}.sessions` */
  prefix: string;
  store: LogStore;
  /** 默认 localStorage（拿不到 = 不取证，判词为无法判定） */
  storage?: StorageLike | null;
  /** 默认 Date.now */
  clock?: () => number;
  /** 存活心跳间隔，默认 30 秒 */
  heartbeatMs?: number;
  /** 默认 navigator.locks；传 null 或不支持时退回心跳规则 */
  locks?: LockManagerLike | null;
}

export interface Forensics {
  /** 当前判词：Web Locks 查询落定前是初值 */
  readonly verdict: ExitVerdict;
  /** 落定后的判词 */
  readonly settled: Promise<ExitVerdict>;
  readonly previousSession: string | null;
  dispose(): void;
}

function defaultLocks(): LockManagerLike | null {
  try {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    return locks === undefined ? null : (locks as unknown as LockManagerLike);
  } catch {
    return null;
  }
}

const VERDICT_TEXT: Record<ExitVerdict["kind"], string> = {
  "first-run": "首次启动（没有上一局记录）",
  clean: "上一局正常关闭",
  abrupt: "疑似异常退出（没有正常告别记录）",
  unknown: "无法判定",
};

/** 启动早期调用（渲染之前）：得出上局判词、写本局一行、挂告别与心跳 */
export function startForensics(options: ForensicsOptions): Forensics {
  const { prefix, store } = options;
  const storage = options.storage === undefined ? safeGlobalStorage("localStorage") : options.storage;
  const clock = options.clock ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const log = store.log("lifecycle");
  const key = `${prefix}.sessions`;
  const me = store.session;
  const startedAt = clock();
  const failedOnce = new Set<string>();
  const locks = options.locks === undefined ? defaultLocks() : options.locks;
  const lockPrefix = `${prefix}.alive.`;
  // 本局持有自己的存活锁：回调返回的 Promise 不结束锁就一直在。pagehide 时主动放掉（页面在离开或进往返
  // 缓存，都不算「还在运行」），从往返缓存恢复时重新拿。拿锁失败不影响页面
  let releaseLock: (() => void) | null = null;
  const holdLock = (): void => {
    if (locks === null || releaseLock !== null) return;
    void locks.request(`${lockPrefix}${me}`, () => new Promise<void>((resolve) => (releaseLock = resolve))).catch(() => undefined);
  };
  const dropLock = (): void => {
    releaseLock?.();
    releaseLock = null;
  };
  holdLock();

  /** 读整表 → 改本行 → 写回；顺带裁掉旧行。同一失败原因只记第一次 */
  const update = (what: string, change: (row: Row | undefined, now: number) => Row): void => {
    if (storage === null) return;
    try {
      const parsed = parseTable(storage.getItem(key));
      const table: Table = parsed === null || parsed === "bad" ? {} : parsed;
      const now = clock();
      table[me] = change(table[me], now);
      const others = Object.entries(table)
        .filter(([id]) => id !== me)
        .sort((a, b) => b[1].openAt - a[1].openAt);
      const kept: Table = { [me]: table[me] };
      others.forEach(([id, row], i) => {
        if (i < KEEP_OTHERS || (row.exitAt === undefined && now - row.aliveAt <= heartbeatMs * 2)) kept[id] = row;
      });
      storage.setItem(key, JSON.stringify({ v: 1, sessions: kept }));
    } catch (error) {
      // 按失败原因去重：存储满时开启、心跳、告别都会失败，原因相同只记一次
      const reason = errText(error);
      if (failedOnce.has(reason)) return;
      failedOnce.add(reason);
      log.warn("取证会话表写入失败（同一原因不再重复记录）", { what, error: reason });
    }
  };

  // ── 判词：读表在写本行之前；Web Locks 查询落定后再算一次 ──
  let raw: string | null = null;
  let readError: string | null = storage === null ? "存储不可用" : null;
  if (storage !== null) {
    try {
      raw = storage.getItem(key);
    } catch (error) {
      readError = `读取会话表失败：${errText(error)}`;
    }
  }
  const judge = (running?: ReadonlySet<string>): { verdict: ExitVerdict; previousSession: string | null } => {
    if (readError !== null) return { verdict: { kind: "unknown", reason: readError }, previousSession: null };
    const r = interpretLastExit(raw, startedAt, heartbeatMs, me, running);
    if (r.verdict.kind === "abrupt" && r.previousSession !== null) {
      const lastLog = store.lastEntryAt(r.previousSession);
      if (lastLog !== null) r.verdict = { kind: "abrupt", lastAliveAt: Math.max(lastLog, r.verdict.lastAliveAt) };
    }
    return r;
  };
  let result = judge();
  const announce = (): ExitVerdict => {
    const v = result.verdict;
    if (v.kind === "abrupt") log.warn("上一局疑似异常退出", { previousSession: result.previousSession, lastAliveAt: v.lastAliveAt });
    else log.info("上一局收场", { verdict: v.kind, previousSession: result.previousSession });
    return v;
  };
  const settled: Promise<ExitVerdict> =
    locks === null || readError !== null
      ? Promise.resolve(announce())
      : Promise.race([
          locks.query(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${LOCK_QUERY_TIMEOUT_MS}ms 未返回`)), LOCK_QUERY_TIMEOUT_MS),
          ),
        ]).then(
          (snapshot) => {
            const running = new Set(
              (snapshot.held ?? []).flatMap((l) => (l.name?.startsWith(lockPrefix) === true ? [l.name.slice(lockPrefix.length)] : [])),
            );
            running.delete(me);
            result = judge(running);
            return announce();
          },
          (error: unknown) => {
            log.warn("查询存活锁失败，按心跳规则判定", { error: errText(error) });
            return announce();
          },
        );

  const detail = (): string[] => {
    const verdict = result.verdict;
    const lines = [`判词：${VERDICT_TEXT[verdict.kind]}`];
    if (result.previousSession !== null) lines.push(`上一会话：${result.previousSession}`);
    if (verdict.kind === "clean") lines.push(`关闭时刻：${formatTime(verdict.endedAt)}`);
    if (verdict.kind === "abrupt") {
      const gap = Math.round((startedAt - verdict.lastAliveAt) / 1000);
      lines.push(`最后有动静：${formatTime(verdict.lastAliveAt)}（距本次启动 ${gap} 秒）`);
      lines.push("说明：没有告别只说明缺少正常关闭的凭证，不能证明被系统杀掉或崩溃；用户从多任务里划掉也是这样。");
    }
    if (verdict.kind === "unknown") lines.push(`原因：${verdict.reason}`);
    return lines;
  };
  const offSection = store.registerSection("上次退出", detail);

  // ── 本局 ──
  update("open", (_row, now) => ({ openAt: now, aliveAt: now }));

  const onPageHide = (): void => {
    dropLock();
    update("exit", (row, now) => ({ openAt: row?.openAt ?? startedAt, aliveAt: now, exitAt: now }));
    log.info("页面告别");
    store.flush();
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    holdLock();
    update("revive", (row, now) => ({ openAt: row?.openAt ?? startedAt, aliveAt: now }));
    log.info("从往返缓存恢复，同一会话继续");
  };
  const alive = (): void => update("alive", (row, now) => ({ ...(row ?? { openAt: startedAt }), aliveAt: now }));
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") alive();
  };
  const heartbeat = setInterval(alive, heartbeatMs);
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  return {
    get verdict() {
      return result.verdict;
    },
    settled,
    get previousSession() {
      return result.previousSession;
    },
    dispose() {
      clearInterval(heartbeat);
      dropLock();
      offSection();
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("pageshow", onPageShow);
      }
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
