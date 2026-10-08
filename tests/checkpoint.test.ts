import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkpointForThread,
  parseCheckpoint,
  readState,
  removeState,
  rewriteOutgoingLine,
  stateDirFrom,
  writeState,
} from "../adapter/checkpoint.mjs";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "kilocode-checkpoint-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

const live = (sessionId: string, userCount: number, extra: Record<string, unknown> = {}) => ({
  kind: "live",
  sessionId,
  bbThreadId: "thr_demo",
  cwd: "/workspace",
  userCount,
  seeded: true,
  updatedAt: 1,
  ...extra,
});

describe("state registry", () => {
  it("resolves the default directory identically everywhere, env override wins", () => {
    expect(stateDirFrom({})).toBe(path.join(os.tmpdir(), "bb-kilo-state"));
    expect(stateDirFrom({ BB_KILO_STATE_DIR: "" })).toBe(path.join(os.tmpdir(), "bb-kilo-state"));
    expect(stateDirFrom({ BB_KILO_STATE_DIR: "/custom/state" })).toBe("/custom/state");
  });

  it("round-trips records atomically and only under safe ids", () => {
    expect(writeState(directory, "ses_abc", live("ses_abc", 2))).toBe(true);
    expect(readState(directory, "ses_abc")).toMatchObject({ kind: "live", userCount: 2 });
    expect(readState(directory, "ses_abc")?.sessionId).toBe("ses_abc");

    // Ids become file names — anything path-shaped must be refused, not escaped.
    expect(writeState(directory, "../escape", live("x", 1))).toBe(false);
    expect(writeState(directory, "a/b", live("x", 1))).toBe(false);
    expect(readState(directory, "../escape")).toBeNull();

    expect(removeState(directory, "ses_abc")).toBe(true);
    expect(readState(directory, "ses_abc")).toBeNull();
    expect(removeState(directory, "ses_abc")).toBe(false); // already gone
  });

  it("parses checkpoints as <sessionId>#<userCount> and rejects every malformation", () => {
    expect(parseCheckpoint("ses_abc#5")).toEqual({ sourceSessionId: "ses_abc", userCount: 5 });
    expect(parseCheckpoint("ses_abc#0")).toEqual({ sourceSessionId: "ses_abc", userCount: 0 });
    expect(parseCheckpoint("kilo-staged-1234#12")).toEqual({
      sourceSessionId: "kilo-staged-1234",
      userCount: 12,
    });

    expect(parseCheckpoint("ses_abc")).toBeNull(); // no separator
    expect(parseCheckpoint("#5")).toBeNull(); // no session id
    expect(parseCheckpoint("ses_abc#")).toBeNull(); // no count
    expect(parseCheckpoint("ses_abc#1.5")).toBeNull(); // not an integer
    expect(parseCheckpoint("ses_abc#-2")).toBeNull(); // negative
    expect(parseCheckpoint("ses_abc#two")).toBeNull();
    expect(parseCheckpoint("bad/id#5")).toBeNull(); // could never be a record
    expect(parseCheckpoint(undefined as unknown as string)).toBeNull();
  });

  it("resolves a thread's checkpoint only from a live, store-confirmed record", () => {
    expect(checkpointForThread(directory, "thr_demo")).toBeNull(); // no record yet

    writeState(directory, "thr_demo", live("ses_abc", 3));
    expect(checkpointForThread(directory, "thr_demo")).toBe("ses_abc#3");

    writeState(directory, "thr_demo", live("ses_abc", 3, { seeded: false }));
    expect(checkpointForThread(directory, "thr_demo")).toBeNull();

    writeState(directory, "thr_demo", { kind: "staged", sessionId: "thr_demo" });
    expect(checkpointForThread(directory, "thr_demo")).toBeNull();

    writeState(directory, "thr_demo", { kind: "live", sessionId: "ses_abc" }); // no count
    expect(checkpointForThread(directory, "thr_demo")).toBeNull();
  });
});

describe("rewriteOutgoingLine", () => {
  const line = (message: unknown, newline = true): string =>
    JSON.stringify(message) + (newline ? "\n" : "");

  it("upgrades the bridge's hardcoded fork capability from tip to checkpoint", () => {
    const rewritten = rewriteOutgoingLine(
      line({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          capabilities: { fork: "tip", steerMode: "queue", sessionRestore: false },
        },
      }),
      directory,
    );
    expect(rewritten).not.toBeNull();
    const message = JSON.parse(rewritten!);
    expect(message.result.capabilities.fork).toBe("checkpoint");
    // Everything else on the line — the queue steer mode above all — untouched.
    expect(message.result.capabilities.steerMode).toBe("queue");
    expect(message.result.capabilities.sessionRestore).toBe(false);
    expect(message.id).toBe(1);
    expect(rewritten!.endsWith("\n")).toBe(true);
  });

  it("leaves a handshake that already claims checkpoint, and foreign shapes, alone", () => {
    expect(
      rewriteOutgoingLine(line({ id: 1, result: { capabilities: { fork: "checkpoint" } } }), directory),
    ).toBeNull();
    expect(rewriteOutgoingLine(line({ id: 2, result: { agentInfo: { name: "Kilo" } } }), directory)).toBeNull();
    expect(rewriteOutgoingLine("not json at all\n", directory)).toBeNull();
    expect(rewriteOutgoingLine("{broken\n", directory)).toBeNull();
    expect(rewriteOutgoingLine("plain text\n", directory)).toBeNull();
    expect(rewriteOutgoingLine(line({ id: 9, error: { code: -1 } }), directory)).toBeNull();
  });

  it("stamps providerCheckpointId on turn boundaries from the thread's record", () => {
    writeState(directory, "thr_demo", live("ses_abc", 4));
    const rewritten = rewriteOutgoingLine(
      line({
        jsonrpc: "2.0",
        method: "thread/delta",
        params: {
          threadId: "thr_demo",
          deltas: [
            { kind: "turn.open" },
            { kind: "turn.boundary", status: "completed" },
          ],
        },
      }),
      directory,
    );
    expect(rewritten).not.toBeNull();
    const deltas = JSON.parse(rewritten!).params.deltas;
    expect(deltas[0]).toEqual({ kind: "turn.open" });
    expect(deltas[1].providerCheckpointId).toBe("ses_abc#4");
    expect(deltas[1].status).toBe("completed"); // the delta itself is untouched
  });

  it("never overwrites a checkpoint that is already on the boundary", () => {
    writeState(directory, "thr_demo", live("ses_abc", 4));
    const rewritten = rewriteOutgoingLine(
      line({
        method: "thread/delta",
        params: {
          threadId: "thr_demo",
          deltas: [{ kind: "turn.boundary", providerCheckpointId: "ses_abc#3" }],
        },
      }),
      directory,
    );
    expect(rewritten).toBeNull();
  });

  it("stamps nothing for an unseeded or unknown thread — the honest 409 path", () => {
    const boundary = (threadId: string) =>
      line({
        method: "thread/delta",
        params: { threadId, deltas: [{ kind: "turn.boundary", status: "completed" }] },
      });

    expect(rewriteOutgoingLine(boundary("thr_missing"), directory)).toBeNull();

    writeState(directory, "thr_demo", live("ses_abc", 4, { seeded: false }));
    expect(rewriteOutgoingLine(boundary("thr_demo"), directory)).toBeNull();
  });

  it("keeps the trailing newline exactly as the bridge wrote it", () => {
    writeState(directory, "thr_demo", live("ses_abc", 1));
    const withNewline = rewriteOutgoingLine(
      line({ method: "thread/delta", params: { threadId: "thr_demo", deltas: [{ kind: "turn.boundary" }] } }, true),
      directory,
    );
    expect(withNewline!.endsWith("\n")).toBe(true);
    const withoutNewline = rewriteOutgoingLine(
      line({ method: "thread/delta", params: { threadId: "thr_demo", deltas: [{ kind: "turn.boundary" }] } }, false),
      directory,
    );
    expect(withoutNewline!.endsWith("\n")).toBe(false);
  });
});
