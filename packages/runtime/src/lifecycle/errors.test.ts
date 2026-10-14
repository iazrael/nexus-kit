// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createLogStore } from "../log/store.ts";
import { captureGlobalErrors } from "./errors.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

function setup(opts: { maxPerMinute?: number } = {}) {
  let now = 0;
  const store = createLogStore({ key: "e.log", storage: null, sessionStorage: null, console: null, env: () => [], clock: () => now });
  const off = captureGlobalErrors(store, { clock: () => now, ...opts });
  disposers.push(off, () => store.dispose());
  return { store, advance: (ms: number) => (now += ms) };
}

function fireError(message: string, error?: unknown): void {
  window.dispatchEvent(new ErrorEvent("error", { message, error, filename: "https://a.com/app.js?v=1", lineno: 3, colno: 9 }));
}

function fireRejection(reason: unknown): void {
  const ev = new Event("unhandledrejection") as Event & { reason?: unknown };
  Object.defineProperty(ev, "reason", { value: reason });
  window.dispatchEvent(ev);
}

describe("captureGlobalErrors", () => {
  it("未捕获异常与未处理的 Promise 拒绝都记 error，带堆栈与出错位置", () => {
    const { store } = setup();
    fireError("x is not defined", new ReferenceError("x is not defined"));
    fireRejection(new Error("请求失败"));
    fireRejection("纯字符串原因");
    const [a, b, c] = store.entries();
    expect(a).toMatchObject({ lv: "error", m: "error", msg: "未捕获异常：x is not defined" });
    expect(a!.data).toMatchObject({ error: { name: "ReferenceError" }, at: "https://a.com/app.js?v=1:3:9" });
    expect(b).toMatchObject({ msg: "未处理的 Promise 拒绝：请求失败" });
    expect(c).toMatchObject({ msg: "未处理的 Promise 拒绝：纯字符串原因" });
  });

  it("同一条错误一分钟内只记一次，下次记录时带上期间重复的次数", () => {
    const { store, advance } = setup();
    for (let i = 0; i < 50; i++) fireError("循环报错");
    expect(store.entries()).toHaveLength(1);
    advance(61_000);
    fireError("循环报错");
    expect(store.entries()).toHaveLength(3);
    // 跨窗口的重复次数在窗口翻转时补记成一条汇总，之后再出现算新一轮的首条
    expect(store.entries().map((e) => e.msg)).toContain("上一分钟「未捕获异常：循环报错」又重复了 49 次");
  });

  it("每分钟总数有上限：超出的只计数，上限解除后补记一条被压下的数量", () => {
    const { store, advance } = setup({ maxPerMinute: 3 });
    for (let i = 0; i < 10; i++) fireError(`不同错误 ${i}`);
    expect(store.entries()).toHaveLength(3);
    advance(61_000);
    fireError("新的一分钟");
    const msgs = store.entries().map((e) => e.msg);
    expect(msgs).toContain("上一分钟有 7 条未捕获异常超出记录上限，未逐条记录");
    expect(msgs.at(-1)).toBe("未捕获异常：新的一分钟");
  });

  it("只刷了一阵就不再出现的错误：下一分钟补记被跳过的次数，旧记录随之清掉", () => {
    const { store, advance } = setup();
    for (let i = 0; i < 30; i++) fireError("只刷一阵");
    advance(61_000);
    fireError("别的错误");
    expect(store.entries().map((e) => e.msg)).toContain("上一分钟「未捕获异常：只刷一阵」又重复了 29 次");
    advance(61_000);
    fireError("只刷一阵");
    // 旧记录已清：这次是新一轮的首条，不带重复次数
    expect(store.entries().at(-1)!.data).not.toHaveProperty("repeatedSinceLast");
  });

  it("注销后不再记录", () => {
    const { store } = setup();
    disposers.shift()!();
    fireError("之后的错误");
    expect(store.entries()).toHaveLength(0);
  });
});
