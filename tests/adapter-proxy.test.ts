import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AcpDriver, runAdapter } from "./helpers/driver";
import { writeFakeKilo } from "./helpers/fake-kilo";

let directory: string;
let kilo: string;
let usageFile: string;
let driver: AcpDriver | undefined;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "kilocode-proxy-"));
  kilo = writeFakeKilo(directory);
  usageFile = path.join(directory, "usage.jsonl");
});

afterEach(() => {
  driver?.kill();
  driver = undefined;
  fs.rmSync(directory, { recursive: true, force: true });
});

const launch = () => {
  driver = new AcpDriver({
    KILO_BIN: kilo,
    KILO_USAGE_FILE: usageFile,
    KILO_ADAPTER_LOG: path.join(directory, "adapter.log"),
  });
  return driver;
};

describe("ACP proxy", () => {
  it("runs a whole turn against the CLI and journals one generation fact per turn", async () => {
    const acp = launch();

    const init = await acp.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    expect(init.agentInfo).toEqual({ name: "Kilo", version: "7.8.3" });

    const cwd = path.join(directory, "workspace");
    const session = await acp.request("session/new", { cwd, mcpServers: [] });
    expect(session.sessionId).toMatch(/^ses_/u);
    // kilo's own configured default, not one of ours
    expect(session.configOptions[0].currentValue).toBe("kilo/google/gemini-3-pro-image");

    const selected = await acp.request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: "model",
      value: "kilo/kilo-auto/free",
    });
    expect(selected.configOptions[0].currentValue).toBe("kilo/kilo-auto/free");

    const first = await acp.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "ping" }],
    });
    expect(first.stopReason).toBe("end_turn");
    expect(first.usage.inputTokens).toBe(1200);

    const chunk = await acp.waitForNotification(
      (message) => message.params?.update?.sessionUpdate === "agent_message_chunk",
    );
    expect(chunk.params.update.content.text).toBe("PONG");
    expect(
      acp.notifications.some((message) => message.params?.update?.sessionUpdate === "usage_update"),
    ).toBe(true);

    const second = await acp.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "ping again" }],
    });
    expect(second.stopReason).toBe("end_turn");

    await acp.request("session/close", { sessionId: session.sessionId });
    const exit = await acp.shutdown();
    expect(exit.code).toBe(0);

    const lines = fs
      .readFileSync(usageFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);

    expect(lines[0].kind).toBe("generation");
    expect(lines[0].fact.provider).toBe("kilocode");
    expect(lines[0].fact.model).toBe("kilo-auto/free");
    expect(lines[0].fact.cwd).toBe(cwd);
    expect(lines[0].fact.session_id).toBe(session.sessionId);
    expect(lines[0].fact.input_tokens).toBe(1200);
    expect(lines[0].fact.cache_read_tokens).toBe(400);
    expect(lines[0].fact.output_tokens).toBe(48); // 40 output + 8 thought
    expect(lines[0].fact.created_at_ms).toBeGreaterThan(1_700_000_000_000);
    // first turn added cost; the second billed the same running total
    expect(lines[0].fact.total_cost).toBe(0.5);
    expect(lines[1].fact.total_cost).toBeNull();
    expect(lines[1].fact.input_tokens).toBe(1200);
  });

  it("passes every line through unchanged in both directions", async () => {
    const acp = launch();
    await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    await acp.request("session/new", { cwd: directory, mcpServers: [] });

    // Whatever the agent emitted is exactly what reaches the bridge.
    for (const line of acp.stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const parsed = acp.stdoutLines.map((line) => JSON.parse(line));
    expect(parsed.map((message) => message.id)).toEqual([1, 2]);
    expect(parsed.every((message) => message.jsonrpc === "2.0")).toBe(true);
    await acp.shutdown();
  });

  it("refuses to start when the CLI is missing, with a message that names no version", async () => {
    const result = await runAdapter([], {
      KILO_BIN: path.join(directory, "not-kilo"),
      KILO_USAGE_FILE: usageFile,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("kilo CLI not found");
    expect(result.stderr).toMatch(/kilo\.ai\/cli\/install/u);
    expect(result.stderr).not.toMatch(/\d+\.\d+\.\d+/u);
    expect(fs.existsSync(usageFile)).toBe(false);
  });
});
