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

const stateDir = () => path.join(directory, "state");

const record = (id: string): any | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
};

const launch = () => {
  driver = new AcpDriver({
    KILO_BIN: kilo,
    KILO_ADAPTER_LOG: path.join(directory, "adapter.log"),
    // HOME points into the sandbox, so anything the adapter writes by
    // default would land under the temp directory — where the test looks.
    HOME: directory,
    // …and Kilo's store must not be readable either: counts in these tests
    // come from the adapter's own publish paths, never from a real database.
    XDG_DATA_HOME: path.join(directory, "xdg"),
    BB_KILO_STATE_DIR: stateDir(),
    BB_THREAD_ID: "thr_proxy_test",
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

  describe("checkpoint registry", () => {
    const writeRecord = (id: string, value: unknown) => {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(path.join(stateDir(), `${id}.json`), JSON.stringify(value));
    };

    it("publishes a live record on session/new and advances it with every prompt", async () => {
      const acp = launch();
      await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const session = await acp.request("session/new", { cwd: directory, mcpServers: [] });

      // Written under the session id and the bb thread id, and observable the
      // moment the response reaches the bridge — the turn boundary that
      // follows this turn already has a checkpoint to stamp.
      expect(record(session.sessionId)).toMatchObject({
        kind: "live",
        sessionId: session.sessionId,
        bbThreadId: "thr_proxy_test",
        cwd: directory,
        userCount: 0,
        seeded: true,
      });
      expect(record("thr_proxy_test")).toMatchObject({
        sessionId: session.sessionId,
        userCount: 0,
      });

      // Prompt arrival: no store to confirm it yet, so the live count + 1.
      await acp.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "ping" }],
      });
      expect(record(session.sessionId)).toMatchObject({ userCount: 1, seeded: true });

      await acp.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "ping again" }],
      });
      expect(record(session.sessionId)).toMatchObject({ userCount: 2, seeded: true });
      expect(record("thr_proxy_test")).toMatchObject({
        sessionId: session.sessionId,
        userCount: 2,
      });
      await acp.shutdown();
    }, 20_000);

    it("seeds on session/load and stays seeded:false when nothing can confirm the count", async () => {
      const acp = launch();
      await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });

      // Unknown session, no store: the record says so rather than guessing —
      // host.ts then stamps no checkpoint and an edit honestly 409s.
      await acp.request("session/load", { sessionId: "ses_loaded_unknown", cwd: directory, mcpServers: [] });
      expect(record("ses_loaded_unknown")).toMatchObject({
        kind: "live",
        userCount: 0,
        seeded: false,
      });

      // A record an earlier process left behind seeds the resumed session.
      writeRecord("ses_loaded_hinted", {
        kind: "live",
        sessionId: "ses_loaded_hinted",
        bbThreadId: null,
        cwd: directory,
        userCount: 3,
        seeded: true,
        updatedAt: Date.now(),
      });
      await acp.request("session/load", { sessionId: "ses_loaded_hinted", cwd: directory, mcpServers: [] });
      expect(record("ses_loaded_hinted")).toMatchObject({
        kind: "live",
        userCount: 3,
        seeded: true,
      });

      // Same honesty for a prompt aimed at a session nobody could confirm.
      await acp.request("session/prompt", {
        sessionId: "ses_unconfirmable",
        prompt: [{ type: "text", text: "ping" }],
      });
      expect(record("ses_unconfirmable")).toMatchObject({ userCount: 1, seeded: false });
      await acp.shutdown();
    }, 20_000);

    it("carries a tip fork's history over to the fork target", async () => {
      const acp = launch();
      await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      writeRecord("ses_live_source", {
        kind: "live",
        sessionId: "ses_live_source",
        bbThreadId: null,
        cwd: directory,
        userCount: 4,
        seeded: true,
        updatedAt: Date.now(),
      });

      const fork = await acp.request("session/fork", {
        sessionId: "ses_live_source",
        cwd: directory,
        mcpServers: [],
      });
      expect(fork.sessionId).toMatch(/^ses_/u);
      expect(fork.sessionId).not.toBe("ses_live_source");
      // No store to recount from, so the source's record decides — the fork
      // target starts at the same turn as its source.
      expect(record(fork.sessionId)).toMatchObject({
        kind: "live",
        userCount: 4,
        seeded: true,
        bbThreadId: "thr_proxy_test",
      });
      // Only the target was rewritten: this was a plain tip fork, not a staged
      // rewind, so the source record survives untouched.
      expect(record("ses_live_source")).toMatchObject({ kind: "live", userCount: 4 });
      await acp.shutdown();
    }, 20_000);
  });

  describe("staged rewind (session/fork rebuild)", () => {
    it("truncates the export, rewrites every id, consumes the record, and loads the clone", async () => {
      const acp = launch();
      await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });

      const workspace = path.join(directory, "workspace");
      fs.mkdirSync(workspace, { recursive: true });

      // What host.ts leaves behind when bb rewinds to "<sessionId>#1".
      const stagedId = "kilo-staged-fixture";
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir(), `${stagedId}.json`),
        JSON.stringify({
          kind: "staged",
          sessionId: stagedId,
          sourceSessionId: "ses_source",
          truncateTo: 1,
          requestThreadId: "thr_proxy_test",
          createdAt: Date.now(),
        }),
      );

      const fork = await acp.request("session/fork", {
        sessionId: stagedId,
        cwd: workspace,
        mcpServers: [],
      });

      // The bridge is answered with a real, distinct session id.
      expect(typeof fork.sessionId).toBe("string");
      expect(fork.sessionId).toMatch(/^ses_/u);
      expect(fork.sessionId).not.toBe(stagedId);

      // …the staged record it answered from is consumed…
      expect(record(stagedId)).toBeNull();
      // …and the replacement session is published at the rewind point.
      expect(record(fork.sessionId)).toMatchObject({
        kind: "live",
        sessionId: fork.sessionId,
        userCount: 1,
        seeded: true,
        bbThreadId: "thr_proxy_test",
        cwd: workspace,
      });
      expect(record("thr_proxy_test")).toMatchObject({ sessionId: fork.sessionId, userCount: 1 });

      // `kilo import` received the truncated, re-id'd transcript, in the
      // target directory (the fixture's four messages are two turns; keeping
      // turn 1 keeps the first user+assistant pair).
      const journal = JSON.parse(fs.readFileSync(path.join(directory, "imported.json"), "utf8"));
      expect(journal.cwd).toBe(workspace);
      const imported = journal.data;
      expect(imported.info.id).toBe(fork.sessionId);
      expect(imported.info.directory).toBe(workspace);
      expect(imported.info.path).toBe(workspace.replace(/^\//u, ""));
      expect(imported.messages).toHaveLength(2);
      expect(imported.messages.map((message: any) => message.info.id)).not.toContain("msg_u1");
      expect(imported.messages.map((message: any) => message.info.id)).not.toContain("msg_a1");
      expect(imported.messages.every((message: any) => message.info.sessionID === fork.sessionId)).toBe(
        true,
      );
      // Fresh ids in a fresh chain: the kept parent is the rewritten one, the
      // root keeps no parent, and nothing can point back at the source.
      expect(imported.messages[0].info.parentID).toBeUndefined();
      expect(imported.messages[1].info.parentID).toBe(imported.messages[0].info.id);
      expect(
        imported.messages.every(
          (message: any) => !Object.values(message.info).includes("msg_u1"),
        ),
      ).toBe(true);
      expect(
        imported.messages.every((message: any) =>
          (message.parts ?? []).every(
            (part: any) =>
              part.id !== "prt_u1" &&
              part.sessionID === fork.sessionId &&
              part.messageID === message.info.id,
          ),
        ),
      ).toBe(true);

      // The clone is loaded into our own kilo child — journalled by the fake
      // CLI, since its answer is swallowed by the adapter.
      const load = JSON.parse(fs.readFileSync(path.join(directory, "load-params.json"), "utf8"));
      expect(load.sessionId).toBe(fork.sessionId);
      expect(load.cwd).toBe(workspace);

      // Nothing the adapter injected into the child may leak to the bridge.
      const out = acp.stdoutLines.map((line) => JSON.parse(line));
      expect(out).toHaveLength(2); // initialize + this fork, and nothing else
      expect(out.every((message) => typeof message.id !== "number" || message.id < 0x40000000)).toBe(
        true,
      );
      await acp.shutdown();
    }, 30_000);

    it("answers with an error, not silence, when the rebuild fails", async () => {
      const acp = launch();
      await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });

      // The staged record points at a source the fake CLI cannot export
      // (its fixture only knows "ses_source"), so the clone fails after the
      // export and the bridge still gets an answer for its id.
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir(), "kilo-staged-broken.json"),
        JSON.stringify({
          kind: "staged",
          sessionId: "kilo-staged-broken",
          sourceSessionId: "ses_missing",
          truncateTo: 1,
          requestThreadId: "thr_proxy_test",
          createdAt: Date.now(),
        }),
      );

      await expect(
        acp.request("session/fork", {
          sessionId: "kilo-staged-broken",
          cwd: directory,
          mcpServers: [],
        }),
      ).rejects.toThrow(/could not rebuild the session/u);

      // A failed clone consumes nothing: the record survives for a retry (and
      // for thread/discard to clean up if bb abandons the edit).
      expect(record("kilo-staged-broken")).toMatchObject({ kind: "staged" });
      await acp.shutdown();
    }, 20_000);
  });
});
