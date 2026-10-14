import { describe, expect, it } from "vitest";
import type { StorageLike } from "../util.ts";
import { createVitalsPersist } from "./persist.ts";
import type { VitalSample } from "./vitals.ts";

function mem(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}
const samples = (n: number, from = 0): VitalSample[] => Array.from({ length: n }, (_, i) => ({ t: from + i * 5000, v: { a: i } }));

describe("createVitalsPersist", () => {
  it("每个会话一行，只留最后 keepSamples 个点；读其他会话按最近更新排在前", () => {
    const storage = mem();
    const a = createVitalsPersist({ key: "k", storage, session: "A", keepSamples: 3 });
    a.save(samples(10), 100);
    const b = createVitalsPersist({ key: "k", storage, session: "B", keepSamples: 3 });
    b.save(samples(2), 200);
    expect(b.others()).toEqual([{ session: "A", updatedAt: 100, samples: samples(10).slice(7) }]);
    expect(a.others().map((o) => o.session)).toEqual(["B"]);
  });

  it("两个窗口交替写：各写各的行，互不覆盖", () => {
    const storage = mem();
    const a = createVitalsPersist({ key: "k", storage, session: "A" });
    const b = createVitalsPersist({ key: "k", storage, session: "B" });
    a.save(samples(1), 1);
    b.save(samples(1), 2);
    a.save(samples(2), 3);
    const c = createVitalsPersist({ key: "k", storage, session: "C" });
    expect(c.others().map((o) => [o.session, o.samples.length])).toEqual([
      ["A", 2],
      ["B", 1],
    ]);
  });

  it("只留最近 sessionsKept 个会话（含本局）", () => {
    const storage = mem();
    for (const [i, id] of ["A", "B", "C", "D"].entries())
      createVitalsPersist({ key: "k", storage, session: id, sessionsKept: 3 }).save(samples(1), i);
    expect(Object.keys((JSON.parse(storage.data.get("k")!) as { sessions: object }).sessions).sort()).toEqual(["B", "C", "D"]);
  });

  it("坏数据、写失败：不抛，原因交给 onError 且同一原因只报一次；坏行被丢弃不影响好行", () => {
    const storage = mem();
    storage.setItem(
      "k",
      JSON.stringify({ v: 1, sessions: { X: { updatedAt: 1, samples: [{ t: "坏" }] }, Y: { updatedAt: 2, samples: samples(1) } } }),
    );
    const errors: string[] = [];
    const p = createVitalsPersist({ key: "k", storage, session: "S", onError: (e) => errors.push(e) });
    expect(p.others().map((o) => o.session)).toEqual(["Y"]);
    const broken: StorageLike = {
      getItem: () => "{坏",
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    const q = createVitalsPersist({ key: "k", storage: broken, session: "S", onError: (e) => errors.push(e) });
    q.save(samples(1), 1);
    q.save(samples(1), 2);
    expect(q.others()).toEqual([]);
    expect(errors.filter((e) => /Quota/.test(e))).toHaveLength(1);
    expect(createVitalsPersist({ key: "k", storage: null, session: "S" }).others()).toEqual([]);
  });

  it("整表不是合法 JSON：报一次「损坏」再按空表处理（下次写盘覆盖掉），不静默", () => {
    const storage = mem();
    storage.setItem("k", "{坏");
    const errors: string[] = [];
    const p = createVitalsPersist({ key: "k", storage, session: "S", onError: (e) => errors.push(e) });
    expect(p.others()).toEqual([]);
    p.save(samples(1), 1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/损坏/);
  });
});
