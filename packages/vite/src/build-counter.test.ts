import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpBuildCounter, ensureBuildCounter, readBuildCounter } from "./build-counter.ts";

let dir: string;

function setup(): { counter: string; lock: string } {
  dir = mkdtempSync(join(tmpdir(), "nexus-counter-"));
  return { counter: join(dir, ".build-number"), lock: join(dir, ".build-number.lock") };
}

/** now 每被调用一次前进 step 毫秒：驱动「等待重试」路径走到超时，不真睡 */
function tickingClock(stepMs = 1000): () => number {
  let t = 0;
  return () => (t += stepMs);
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("ensureBuildCounter", () => {
  it("缺失时以 0 建档并警告（CI/新 clone 从 0 起步不阻断）", () => {
    const { counter } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ensureBuildCounter(counter);
    expect(readFileSync(counter, "utf8")).toBe("0\n");
    // 警告必须指向真实恢复源：线上 version.json / 服务器 releases 目录名
    expect(warn.mock.calls[0]?.[0]).toMatch(/version\.json/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/releases/);
    warn.mockRestore();
  });

  it("已存在时不动文件、不警告", () => {
    const { counter } = setup();
    writeFileSync(counter, "41\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ensureBuildCounter(counter);
    expect(readFileSync(counter, "utf8")).toBe("41\n");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("readBuildCounter", () => {
  it("计数器内容非整数：报损坏", () => {
    const { counter } = setup();
    writeFileSync(counter, "abc\n");
    expect(() => readBuildCounter(counter)).toThrow(/损坏/);
  });

  it("正常读取（容忍首尾空白）", () => {
    const { counter } = setup();
    writeFileSync(counter, " 599\n");
    expect(readBuildCounter(counter)).toBe(599);
  });
});

describe("bumpBuildCounter", () => {
  it("递增并回写文件，随后锁文件已释放", () => {
    const { counter, lock } = setup();
    writeFileSync(counter, "41\n");
    const build = bumpBuildCounter(counter, { lockPath: lock });
    expect(build).toBe(42);
    expect(readFileSync(counter, "utf8")).toBe("42\n");
    expect(existsSync(lock)).toBe(false);
  });

  it("锁被新鲜持有时等待直到超时报错，计数器不被改动", () => {
    const { counter, lock } = setup();
    writeFileSync(counter, "7\n");
    writeFileSync(lock, `${process.pid} ${Date.now()}`);
    expect(() =>
      bumpBuildCounter(counter, {
        lockPath: lock,
        now: tickingClock(),
        sleep: () => {},
        maxWaitMs: 3000,
      }),
    ).toThrow(/锁/);
    expect(readFileSync(counter, "utf8")).toBe("7\n");
  });

  it("内容残缺的锁（刚获锁未写完的窗口）按新鲜等待，不得强破", () => {
    const { counter, lock } = setup();
    writeFileSync(counter, "7\n");
    writeFileSync(lock, ""); // 空内容：可能是刚拿锁的持有者
    expect(() =>
      bumpBuildCounter(counter, {
        lockPath: lock,
        now: tickingClock(),
        sleep: () => {},
        maxWaitMs: 3000,
      }),
    ).toThrow(/锁/); // 若被误强破，bump 会成功而不抛
    expect(readFileSync(counter, "utf8")).toBe("7\n");
  });

  it("陈旧锁（内容时间戳超过陈旧阈值）强破后正常递增", () => {
    const { counter, lock } = setup();
    writeFileSync(counter, "41\n");
    writeFileSync(lock, `${process.pid} ${Date.now() - 60_000}`);
    const build = bumpBuildCounter(counter, { lockPath: lock });
    expect(build).toBe(42);
    expect(existsSync(lock)).toBe(false);
  });

  it("陈旧判定只认锁内容时间戳：文件 mtime 被拨老而内容新鲜时不得强破", () => {
    const { counter, lock } = setup();
    writeFileSync(counter, "1\n");
    writeFileSync(lock, `${process.pid} ${Date.now()}`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(() =>
      bumpBuildCounter(counter, {
        lockPath: lock,
        now: tickingClock(),
        sleep: () => {},
        maxWaitMs: 3000,
      }),
    ).toThrow(/锁/);
    expect(readFileSync(counter, "utf8")).toBe("1\n");
  });

  it("计数器是软链时，默认锁落在真实文件旁（跨工作树共享同一把锁）", () => {
    const { counter } = setup();
    writeFileSync(counter, "9\n");
    const realDir = mkdtempSync(join(tmpdir(), "nexus-counter-real-"));
    try {
      const real = join(realDir, ".build-number");
      writeFileSync(real, "9\n");
      const link = join(dir, "linked-counter");
      symlinkSync(real, link);
      expect(bumpBuildCounter(link)).toBe(10);
      expect(existsSync(`${real}.lock`)).toBe(false); // 用完即删
      expect(existsSync(`${link}.lock`)).toBe(false); // 锁不在软链旁产生
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});
