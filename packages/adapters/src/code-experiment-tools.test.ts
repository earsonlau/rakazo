import { describe, expect, it, vi } from "vitest";
import {
  codeExperimentsEnabled,
  codeExperimentTool,
  executeCodeExperimentTool,
  parseCodeExperimentRequest,
} from "./code-experiment-tools.js";

describe("code experiment tool boundary", () => {
  it("exports a delivery artifact without returning raw patch contents to the effect history", async () => {
    const execute = vi.fn(async () => ({
      ref: "branch-a",
      base: "base-a",
      patch: "binary-capable patch",
    }));
    const connection = { spaceId: "space-a", userId: "owner-a", provider: { execute } };
    const scope = {
      ...connection,
      operationId: "call-a",
      traceId: "trace-a",
      botId: "bot-a",
      signal: new AbortController().signal,
    };
    const save = vi.fn(async () => ({ path: "experiments/result.patch", bytes: 20 }));
    const args = { action: "export", experiment: "winner" };
    expect(await executeCodeExperimentTool(connection, scope, args, save)).toEqual({
      ref: "branch-a",
      base: "base-a",
      path: "experiments/result.patch",
      bytes: 20,
    });
    expect(save).toHaveBeenCalledWith("winner", "binary-capable patch");
    expect(execute).toHaveBeenCalledWith(args, scope);
    await expect(
      executeCodeExperimentTool(connection, { ...scope, userId: "other" }, args, save),
    ).rejects.toThrow("owner and space");
    await expect(
      executeCodeExperimentTool(connection, scope, { ...args, botId: "other" }, save),
    ).rejects.toThrow("Unexpected");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("requires the configured owner and space", () => {
    const connection = {
      spaceId: "space-a",
      userId: "owner-a",
      provider: { execute: async () => ({}) },
    };
    expect(codeExperimentsEnabled(null, connection)).toBe(false);
    expect(codeExperimentsEnabled(connection, connection)).toBe(true);
    expect(codeExperimentsEnabled(connection, { spaceId: "space-b", userId: "owner-a" })).toBe(
      false,
    );
    expect(codeExperimentsEnabled(connection, { spaceId: "space-a", userId: "owner-b" })).toBe(
      false,
    );
  });

  it("accepts only the documented fields and bounded values", () => {
    expect(
      parseCodeExperimentRequest({ action: "run", experiment: "cache-fix", command: "npm test" }),
    ).toHaveProperty("command", "npm test");
    expect(
      parseCodeExperimentRequest({
        action: "write",
        experiment: "fix",
        path: "/a.ts",
        content: "",
      }),
    ).toHaveProperty("content", "");
    for (const args of [
      { action: "fork", experiment: "../main" },
      { action: "fork", experiment: "fix", botId: "someone-else" },
      { action: "run", experiment: "fix", command: "echo x", env: { TOKEN: "secret" } },
      { action: "read", ref: "main", path: "/../etc/passwd" },
      { action: "read", ref: "main", path: "relative" },
      { action: "read", ref: "main", path: "/x", startLine: 4, endLine: 2 },
      { action: "history", ref: "main", offset: -1 },
      { action: "history", ref: "main", offset: 0.5 },
      { action: "run", experiment: "fix", command: "" },
      { action: "run", experiment: "fix", command: "bad\0command" },
      { action: "publish", experiment: "fix" },
    ])
      expect(() => parseCodeExperimentRequest(args)).toThrow();
    expect(JSON.stringify(codeExperimentTool.inputSchema)).not.toContain('"publish"');
    expect(JSON.stringify(codeExperimentTool.inputSchema)).not.toContain('"force"');
  });
});
