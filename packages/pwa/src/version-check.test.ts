import { describe, expect, it } from "vitest";
import {
  collectPendingReleases,
  isNewerVersion,
  parseVersionManifest,
  releaseNotesDigest,
  type RemoteVersionInfo,
} from "./version-check.ts";

const LOCAL = { version: "1.2.0", build: 585 };

const manifestOf = (releases: unknown, extra: object = {}): unknown => ({
  version: "1.2.1",
  build: 590,
  buildTime: "2026-09-30T00:00:00.000Z",
  releases,
  ...extra,
});

const rel = (version: string, notes: unknown = ["x"], date = "2026-09-30") => ({ version, date, notes });

describe("parseVersionManifest", () => {
  it("合法结构原样通过", () => {
    const raw = manifestOf([rel("1.2.1", ["a"], "2026-09-30"), rel("1.2.0", ["b"], "2026-09-23")]);
    expect(parseVersionManifest(raw)).toEqual(raw);
  });

  it("顶层结构非法返回 null（fail-fast，调用方按无更新处理）", () => {
    expect(parseVersionManifest(null)).toBeNull();
    expect(parseVersionManifest("x")).toBeNull();
    expect(parseVersionManifest({})).toBeNull();
    expect(parseVersionManifest(manifestOf("不是数组"))).toBeNull();
    expect(parseVersionManifest(manifestOf([]))?.releases).toEqual([]);
  });

  it("非法条目剔除、合法条目保留（降级不整表作废）", () => {
    const parsed = parseVersionManifest(manifestOf([rel("1.2.1"), { version: "bad" }, rel("1.1.0", "不是数组"), rel("1.0.0")]));
    expect(parsed?.releases.map((release) => release.version)).toEqual(["1.2.1", "1.0.0"]);
  });
});

describe("isNewerVersion", () => {
  it("逐段数值比较，前导 v/V 与预发布后缀不参与", () => {
    expect(isNewerVersion("1.3.0", "1.2.9")).toBe(true);
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerVersion("v1.2.1", "1.2.0")).toBe(true);
    expect(isNewerVersion("V1.2.1", "1.2.0")).toBe(true);
    expect(isNewerVersion("1.2.1", "1.2.1")).toBe(false);
    expect(isNewerVersion("1.2.0", "1.2.0-beta.1")).toBe(false);
    expect(isNewerVersion("垃圾", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.2", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.2.3.4", "1.2.3")).toBe(false);
  });
});

describe("collectPendingReleases", () => {
  const remote: RemoteVersionInfo = parseVersionManifest(manifestOf([rel("1.2.1"), rel("1.2.0"), rel("1.1.0")])) as RemoteVersionInfo;

  it("落后一个版本：只取比本地新的版本，文件序（新在前）", () => {
    expect(collectPendingReleases(LOCAL, remote)?.releases.map((release) => release.version)).toEqual(["1.2.1"]);
  });

  it("落后多个版本：聚合中间全部版本", () => {
    const pending = collectPendingReleases({ version: "1.0.0", build: 400 }, remote);
    expect(pending?.releases.map((release) => release.version)).toEqual(["1.2.1", "1.2.0", "1.1.0"]);
  });

  it("跨版本更新 kind=upgrade", () => {
    expect(collectPendingReleases(LOCAL, remote)?.kind).toBe("upgrade");
  });

  it("同版本重发、本版对外条目未变（指纹一致）：kind=hotfix 且不带条目——玩家已经有了，重列是误导；本地带 v 前缀、远端不带（真实数据形态）", () => {
    const sameNotes = releaseNotesDigest(rel("1.2.0").notes as string[]);
    const pending = collectPendingReleases(
      { version: "v1.2.0", build: 585, notesDigest: sameNotes },
      { ...remote, version: "1.2.0", build: 586 },
    );
    expect(pending).toEqual({ releases: [], hiddenCount: 0, kind: "hotfix" });
  });

  it("同版本重发、本版对外条目变了（指纹不同）：kind=revised，列出该版新条目", () => {
    const pending = collectPendingReleases(
      { version: "v1.2.0", build: 585, notesDigest: releaseNotesDigest(["旧条目"]) },
      { ...remote, version: "1.2.0", build: 586 },
    );
    expect(pending).toEqual({ releases: [rel("1.2.0")], hiddenCount: 0, kind: "revised" });
  });

  it("同版本重发、远端该版没有对外条目（全是内部条目被剔除）：玩家无感，返回 null 不弹窗（下次启动自然更新）", () => {
    const empty = parseVersionManifest(manifestOf([rel("1.1.0")])) as RemoteVersionInfo;
    expect(
      collectPendingReleases(
        { version: "v1.2.0", build: 585, notesDigest: releaseNotesDigest(["旧条目"]) },
        { ...empty, version: "1.2.0", build: 586 },
      ),
    ).toBeNull();
  });

  it("releaseNotesDigest：同内容同指纹、顺序/内容变化即不同", () => {
    expect(releaseNotesDigest(["a", "b"])).toBe(releaseNotesDigest(["a", "b"]));
    expect(releaseNotesDigest(["a", "b"])).not.toBe(releaseNotesDigest(["b", "a"]));
    expect(releaseNotesDigest(["ab"])).not.toBe(releaseNotesDigest(["a", "b"]));
    expect(releaseNotesDigest([])).toMatch(/^[0-9a-f]{8}$/);
  });

  it("已是最新 / 本地更新（回滚场景）返回 null", () => {
    expect(collectPendingReleases(LOCAL, { ...remote, version: "1.2.0", build: 585 })).toBeNull();
    expect(collectPendingReleases({ version: "1.3.0", build: 600 }, remote)).toBeNull();
  });

  it("maxVisible 折叠：展示最新若干版，更早的计入 hiddenCount；0 与负数钳为全折叠", () => {
    const pending = collectPendingReleases({ version: "1.0.0", build: 400 }, remote, { maxVisible: 2 });
    expect(pending?.releases.map((release) => release.version)).toEqual(["1.2.1", "1.2.0"]);
    expect(pending?.hiddenCount).toBe(1);
    const zero = collectPendingReleases({ version: "1.0.0", build: 400 }, remote, { maxVisible: 0 });
    expect(zero?.releases).toEqual([]);
    expect(zero?.hiddenCount).toBe(3);
    expect(collectPendingReleases({ version: "1.0.0", build: 400 }, remote, { maxVisible: -1 })?.hiddenCount).toBe(3);
  });

  it("manifest 非法返回 null", () => {
    expect(collectPendingReleases(LOCAL, parseVersionManifest("bad"))).toBeNull();
  });
});
