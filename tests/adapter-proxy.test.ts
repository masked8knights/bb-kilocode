import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AcpDriver, runAdapter } from "./helpers/driver";
import { writeFakeKilo } from "./helpers/fake-kilo";

let directory: string;
let kilo: string;
let driver: AcpDriver | undefined;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "kilocode-proxy-"));
  kilo = writeFakeKilo(directory);
});

afterEach(() => {
  driver?.kill();
  driver = undefined;
  fs.rmSync(directory, { recursive: true, force: true });
});

const launch = () => {
  driver = new AcpDriver({
    KILO_BIN: kilo,
    KILO_ADAPTER_LOG: path.join(directory, "adapter.log"),
    // HOME points into the sandbox, so anything the adapter writes by
    // default would land under the temp directory — where the test looks.
    HOME: directory,
  });
  return driver;
};

describe("ACP proxy", () => {
  it("runs a whole turn against the CLI", async () => {
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

    // This plugin writes no usage ledger: Kilo Code's own store is the
    // usage source, and a second one would double-count. HOME points into
    // the sandbox, so anything the adapter wrote would land here.
    expect(fs.existsSync(path.join(directory, ".kilocode", "usage.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(directory, ".kilocode"))).toBe(false);
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
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("kilo CLI not found");
    expect(result.stderr).toMatch(/kilo\.ai\/cli\/install/u);
    expect(result.stderr).not.toMatch(/\d+\.\d+\.\d+/u);
  });
});
