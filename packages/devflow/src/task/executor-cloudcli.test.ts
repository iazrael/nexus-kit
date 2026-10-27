import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudcliExecutor } from "./executor-cloudcli.ts";

const config = {
  endpoint: "http://127.0.0.1:3030/mcp/execution",
  tokenEnv: "CLOUDCLI_EXECUTION_TOKEN",
  provider: "zcode",
  model: "test",
  permissionMode: "default",
};

describe("CloudCLI executor", () => {
  it("validates the local endpoint and explicit authorization without storing a secret", () => {
    const settings = cloudcliExecutor.parseSettings(config);
    expect(settings.model).toBe("test");
    for (const endpoint of ["https://remote.example/mcp", "http://user:secret@127.0.0.1/mcp", "http://127.0.0.1/mcp?token=secret"])
      expect(() => cloudcliExecutor.parseSettings({ ...config, endpoint })).toThrow();
    expect(() => cloudcliExecutor.parseSettings({ ...config, permissionMode: "auto" })).toThrow();
    expect(() => cloudcliExecutor.parseSettings({ ...config, tokenEnv: "invalid-name" })).toThrow();
    expect(() => cloudcliExecutor.parseSettings({ ...config, command: ["ignored"] })).toThrow();
  });
  it("writes an idempotent request and reads only the CloudCLI receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "executor-cloudcli-"));
    try {
      const out = join(root, "stdout.log");
      const launch = cloudcliExecutor.invocation(cloudcliExecutor.parseSettings(config), "original-session", root, out, "do task");
      const request = JSON.parse(readFileSync(join(root, "cloudcli-request.json"), "utf8"));
      expect(request.sessionId).toBe("original-session");
      expect(request.requestId).toBeTruthy();
      expect(request.prompt).toBe("do task");
      expect(readFileSync(join(root, "cloudcli-request.json"), "utf8")).not.toContain("Bearer");
      writeFileSync(
        launch.sessionLog,
        JSON.stringify({ sessionId: "original-session", runId: "run-1", state: "running", stopConfirmed: false }),
      );
      expect(cloudcliExecutor.sessionScanner(launch, "original-session")()).toBe("original-session");
      expect(() => cloudcliExecutor.sessionScanner(launch, "different-session")()).toThrow(/会话/);
      writeFileSync(out, JSON.stringify({ sessionId: "original-session", state: "succeeded", stopConfirmed: true, response: "done" }));
      expect(cloudcliExecutor.receipt(out)).toEqual({ conversationId: "original-session", response: "done" });
      writeFileSync(out, JSON.stringify({ sessionId: "original-session", state: "failed", stopConfirmed: true, error: "quota" }));
      expect(() => cloudcliExecutor.receipt(out)).toThrow();
      expect(cloudcliExecutor.salvage(out)?.failure?.message).toBe("quota");
      writeFileSync(out, JSON.stringify({ sessionId: "original-session", state: "succeeded", stopConfirmed: false }));
      expect(() => cloudcliExecutor.receipt(out)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
