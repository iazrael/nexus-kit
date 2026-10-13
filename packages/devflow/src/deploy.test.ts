/**
 * 部署流程单测：假服务器按命令形状应答（软链、releases 目录、回环 curl），覆盖前置校验、
 * 构建号单调、缓存头/gzip/边缘 TTL 预检、上传切换、冒烟失败回滚、回滚失败、清旧。
 */
import { describe, expect, it } from "vitest";
import type { DeployConfig } from "./config.ts";
import { buildOfReleaseDir, cacheControlOf, parseServedFingerprint, pickStaleReleases, runDeploy, type DeployDeps } from "./deploy.ts";

const CFG: DeployConfig = {
  target: "root@host",
  remoteRoot: "/var/www/app",
  publicUrl: "https://app.example",
  localPort: 8888,
  keep: 3,
  branch: "main",
  privateRequired: ["/", "/sw.js"],
  gzipRequired: ["/data/big.bin"],
  edgeTtlProbes: ["/icons/logo.webp"],
};

interface ServerState {
  current: string | null;
  releases: string[];
  /** 每个 release 目录对外报的 version.json 指纹 */
  served: Record<string, string>;
  cacheControl: string;
  gzip: boolean;
  edgeCacheControl: string;
  indexStatus: string;
  failSwitchBack: boolean;
  sshDown: boolean;
}

function harness(
  over: Partial<ServerState> = {},
  local: { branch?: string; dirty?: boolean; worktree?: boolean; version?: string; build?: number } = {},
) {
  const state: ServerState = {
    current: "/var/www/app/releases/1.0.0+10",
    releases: ["1.0.0+8", "1.0.0+9", "1.0.0+10"],
    served: {},
    cacheControl: "private, no-cache",
    gzip: true,
    edgeCacheControl: "private, no-cache",
    indexStatus: "200",
    failSwitchBack: false,
    sshDown: false,
    ...over,
  };
  const logs: string[] = [];
  const sshCalls: string[] = [];
  const runCalls: string[][] = [];
  const version = local.version ?? "1.1.0";
  const build = local.build ?? 12;
  let switches = 0;
  const deps: DeployDeps = {
    run(cmd, args) {
      runCalls.push([cmd, ...args]);
      if (cmd === "git") {
        const a = args.join(" ");
        if (a === "rev-parse --git-dir") return local.worktree ? ".git/worktrees/x\n" : ".git\n";
        if (a === "rev-parse --git-common-dir") return ".git\n";
        if (a === "rev-parse --abbrev-ref HEAD") return `${local.branch ?? "main"}\n`;
        if (a === "status --porcelain") return local.dirty ? " M a.ts\n" : "";
      }
      if (cmd === "curl") return `HTTP/2 200\ncache-control: ${state.edgeCacheControl}\n`;
      return "";
    },
    ssh(remote) {
      sshCalls.push(remote);
      if (state.sshDown) throw Object.assign(new Error("ssh down"), { status: 255 });
      let m: RegExpExecArray | null;
      if ((m = /^test ! -d '(.+)'$/.exec(remote))) {
        if (state.releases.includes(m[1]!.split("/").pop()!)) throw Object.assign(new Error("exists"), { status: 1 });
        return "";
      }
      if (remote.startsWith("readlink")) return state.current ? `${state.current}\n` : "\n";
      if (remote.includes("Accept-Encoding: gzip")) return state.gzip ? "content-encoding: gzip\n" : "content-type: x\n";
      if (remote.startsWith("curl -fsSI")) return `cache-control: ${state.cacheControl}\n`;
      if (remote.includes("/version.json")) {
        const name = state.current!.split("/").pop()!;
        return JSON.stringify({
          version: (state.served[name] ?? name).split("+")[0],
          build: Number((state.served[name] ?? name).split("+")[1]),
        });
      }
      if (remote.includes("%{http_code}")) return state.indexStatus;
      if ((m = /^mv -T '.+\/\.upload-(.+)' '.+'$/.exec(remote))) {
        state.releases.push(m[1]!);
        return "";
      }
      if ((m = /ln -sfn '([^']+)'/.exec(remote))) {
        switches += 1;
        if (state.failSwitchBack && switches > 1) throw new Error("switch failed");
        state.current = m[1]!;
        return "";
      }
      if (remote.startsWith("ls -1")) return state.releases.join("\n");
      if ((m = /^rm -rf (.+)$/.exec(remote))) {
        const names = [...m[1]!.matchAll(/releases\/([^']+)'/g)].map((x) => x[1]!);
        state.releases = state.releases.filter((r) => !names.includes(r));
        return "";
      }
      return "";
    },
    log: (msg) => logs.push(msg),
    readFile: (p) => (p.endsWith("package.json") ? JSON.stringify({ version }) : JSON.stringify({ version: "1.1.0", build })),
    exists: () => true,
    readBundleCodes: () => [`const b=${build};`],
    assertInjectedBuild: (codes, b) => {
      if (!codes.some((c) => c.includes(String(b)))) throw new Error("no build");
    },
  };
  return { deps, state, logs, sshCalls, runCalls, input: { config: CFG, appRoot: "/app" } };
}

describe("纯函数", () => {
  it("parseServedFingerprint / buildOfReleaseDir / cacheControlOf", () => {
    expect(parseServedFingerprint('{"version":"1.0.0","build":3}')).toBe("1.0.0+3");
    expect(() => parseServedFingerprint("<html>")).toThrow(/不是合法 JSON/);
    expect(buildOfReleaseDir("/var/www/app/releases/1.0.0+42")).toBe(42);
    expect(buildOfReleaseDir("/var/www/app/releases/odd")).toBeNull();
    expect(cacheControlOf("HTTP/1.1 200\nCache-Control: private, no-cache\n")).toBe("private, no-cache");
    expect(cacheControlOf("HTTP/1.1 200\n")).toBe("");
  });

  it("pickStaleReleases：按构建号倒序保留 keep 版（含本次），跳过暂存目录与杂项", () => {
    const listing = "1.0.0+8\n1.0.0+10\n.upload-1.1.0+11\n1.0.0+9\nREADME\n1.1.0+12\n";
    expect(pickStaleReleases(listing, 3, "1.1.0+12")).toEqual(["1.0.0+8"]);
    expect(pickStaleReleases(listing, 1, "1.1.0+12")).toEqual(["1.0.0+10", "1.0.0+9", "1.0.0+8"]);
  });
});

describe("runDeploy", () => {
  it("正常路径：预检 → 硬链接克隆暂存 → rsync → 改名 → 切换 → 冒烟 → 清旧", () => {
    const h = harness();
    const result = runDeploy(h.input, h.deps);
    expect(result).toEqual({ releaseName: "1.1.0+12", previous: "/var/www/app/releases/1.0.0+10", removed: ["1.0.0+8"] });
    expect(h.state.current).toBe("/var/www/app/releases/1.1.0+12");
    expect(h.sshCalls.some((c) => c.includes("cp -al '/var/www/app/releases/1.0.0+10' '/var/www/app/releases/.upload-1.1.0+12'"))).toBe(
      true,
    );
    expect(h.runCalls).toContainEqual([
      "rsync",
      "-az",
      "--delete",
      "--checksum",
      "/app/dist/",
      "root@host:/var/www/app/releases/.upload-1.1.0+12/",
    ]);
    expect(h.runCalls.some((c) => c[0] === "curl" && c.at(-1) === "https://app.example/icons/logo.webp")).toBe(true);
    expect(h.state.releases).toEqual(["1.0.0+9", "1.0.0+10", "1.1.0+12"]);
  });

  it("首次部署：无克隆、冒烟阶段才查缓存头", () => {
    const h = harness({ current: null, releases: [] });
    expect(runDeploy(h.input, h.deps).previous).toBeNull();
    expect(h.sshCalls.some((c) => c.includes("cp -al"))).toBe(false);
  });

  it.each([
    [{ worktree: true }, /工作树/],
    [{ branch: "feature/x" }, /当前分支 feature\/x/],
    [{ branch: "HEAD" }, /游离 HEAD/],
    [{ dirty: true }, /不干净/],
    [{ version: "1.2.0" }, /dist 版本过期/],
  ])("前置校验拦截 %#", (local, err) => {
    const h = harness({}, local);
    expect(() => runDeploy(h.input, h.deps)).toThrow(err);
    expect(h.sshCalls).toEqual([]);
  });

  it("dist 缺 version.json / build 非数字 / 构建号未注入：拦截", () => {
    const a = harness();
    a.deps.exists = () => false;
    expect(() => runDeploy(a.input, a.deps)).toThrow(/version\.json 不存在/);
    const b = harness();
    b.deps.readFile = (p) => (p.endsWith("package.json") ? '{"version":"1.1.0"}' : '{"version":"1.1.0","build":"12"}');
    expect(() => runDeploy(b.input, b.deps)).toThrow(/build 必须是正整数/);
    const c = harness();
    c.deps.readBundleCodes = () => ["nothing"];
    expect(() => runDeploy(c.input, c.deps)).toThrow(/no build/);
  });

  it("version.json 的版本带引号等非法字符：拦截，不拼进 ssh 命令", () => {
    const h = harness();
    h.deps.readFile = (p) =>
      p.endsWith("package.json") ? `{"version":"1.1.0'; rm -rf / #"}` : `{"version":"1.1.0'; rm -rf / #","build":12}`;
    expect(() => runDeploy(h.input, h.deps)).toThrow(/纯 X\.Y\.Z/);
    expect(h.sshCalls).toEqual([]);
  });

  it("同名构建拒绝重部署；ssh 连不上单独报出", () => {
    const a = harness({ releases: ["1.1.0+12"] });
    expect(() => runDeploy(a.input, a.deps)).toThrow(/已存在/);
    const b = harness({ sshDown: true });
    expect(() => runDeploy(b.input, b.deps)).toThrow(/连不上/);
  });

  it("构建号不大于现役：拦截（计数器回退）", () => {
    const h = harness({ current: "/var/www/app/releases/1.0.0+20" });
    expect(() => runDeploy(h.input, h.deps)).toThrow(/≤ 线上现役 20/);
  });

  it.each([
    [{ cacheControl: "no-cache" }, /缺 private/],
    [{ gzip: false }, /未 gzip/],
    [{ edgeCacheControl: "public, max-age=14400" }, /覆写了浏览器 TTL/],
  ])("上传前预检不过即中止，不动线上 %#", (over, err) => {
    const h = harness(over);
    expect(() => runDeploy(h.input, h.deps)).toThrow(err);
    expect(h.state.current).toBe("/var/www/app/releases/1.0.0+10");
    expect(h.runCalls.some((c) => c[0] === "rsync")).toBe(false);
  });

  it("公网探针取不到：中止并说明", () => {
    const h = harness();
    const run = h.deps.run;
    h.deps.run = (cmd, args) => {
      if (cmd === "curl") throw new Error("timeout");
      return run(cmd, args);
    };
    expect(() => runDeploy(h.input, h.deps)).toThrow(/公网探针取不到/);
  });

  it("publicUrl 为空：跳过边缘探针", () => {
    const h = harness({ edgeCacheControl: "public, max-age=99" });
    expect(() => runDeploy({ ...h.input, config: { ...CFG, publicUrl: "" } }, h.deps)).not.toThrow();
  });

  it("冒烟指纹不符：自动回滚并确认回滚后的指纹", () => {
    const h = harness({ served: { "1.1.0+12": "1.0.0+10" } });
    expect(() => runDeploy(h.input, h.deps)).toThrow(/冒烟失败：服务器 version\.json=1\.0\.0\+10/);
    expect(h.state.current).toBe("/var/www/app/releases/1.0.0+10");
    expect(h.logs.some((l) => l.includes("已回滚") && l.includes("1.0.0+10"))).toBe(true);
  });

  it("index 非 200：回滚", () => {
    const h = harness({ indexStatus: "502" });
    expect(() => runDeploy(h.input, h.deps)).toThrow(/index\.html 状态 502/);
    expect(h.state.current).toBe("/var/www/app/releases/1.0.0+10");
  });

  it("回滚本身失败：两个原因都带出来", () => {
    const h = harness({ indexStatus: "502", failSwitchBack: true });
    expect(() => runDeploy(h.input, h.deps)).toThrow(/switch failed/);
    expect(h.logs.some((l) => l.includes("回滚失败"))).toBe(true);
    expect(h.logs.some((l) => l.includes("index.html 状态 502"))).toBe(true);
  });

  it("首次部署冒烟失败：无可回滚，如实说明后抛出", () => {
    const h = harness({ current: null, releases: [], indexStatus: "500" });
    expect(() => runDeploy(h.input, h.deps)).toThrow(/500/);
    expect(h.logs.some((l) => l.includes("没有现役版本可回滚"))).toBe(true);
  });

  it("回滚后指纹确认失败：记为无法确认", () => {
    const h = harness({ indexStatus: "502" });
    const ssh = h.deps.ssh;
    let rolled = false;
    h.deps.ssh = (remote) => {
      if (remote.includes("ln -sfn '/var/www/app/releases/1.0.0+10'")) rolled = true;
      if (rolled && remote.includes("/version.json")) throw new Error("curl failed");
      return ssh(remote);
    };
    expect(() => runDeploy(h.input, h.deps)).toThrow(/502/);
    expect(h.logs.some((l) => l.includes("无法确认"))).toBe(true);
  });
});
