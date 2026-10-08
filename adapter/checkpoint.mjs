// bb-kilocode — checkpoint state registry and outgoing rewrites.
//
// Checkpoint rewind (`bb thread edit-message`) and checkpoint fork work from
// one shared JSON registry: one file per id under BB_KILO_STATE_DIR (default
// <tmp>/bb-kilo-state; server.ts pins the same default into the launch spec
// env so the adapter inherits it, and host.ts learns it from any request that
// carries the launch spec).
//
//   <sessionId>.json   live:   { kind:"live", sessionId, bbThreadId, cwd,
//                                userCount, seeded, updatedAt }
//   <bbThreadId>.json  the same record, so host.ts can resolve the current
//                      session (and its checkpoint) from a thread/delta.
//   staged records     { kind:"staged", sourceSessionId, truncateTo, … } are
//                      written by host.ts when bb rewinds to a checkpoint and
//                      consumed — then deleted — by adapter/acp.mjs when the
//                      replacement thread's session/fork arrives.
//
// A checkpoint id is "<sessionId>#<userCount>": the number of user messages
// Kilo Code's store held when the turn settled. host.ts stamps it onto the
// outgoing `thread/delta` turn.boundary so the completed turn preceding an
// edited message carries providerCheckpointId; without a non-null checkpoint
// there, bb answers `409: This earlier provider turn has no editable history
// checkpoint` — which stays the honest answer whenever `seeded` is false,
// because a count Kilo's store did not confirm must never truncate anything.
//
// Dependency-free and side-effect-free at import time, so both host.ts (bundled
// by bb) and the adapter/tests (plain node) can load it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Launch-spec env key carrying the registry directory. */
export const STATE_DIR_ENV = "BB_KILO_STATE_DIR";

/** Ids become file names: letters, digits, dot, underscore, hyphen only. */
export const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/;

/** Same resolution in host.ts, adapter/acp.mjs, and the tests. */
export function stateDirFrom(env) {
  const custom = env?.[STATE_DIR_ENV];
  if (typeof custom === "string" && custom.length > 0) return custom;
  return path.join(os.tmpdir(), "bb-kilo-state");
}

export function readState(dir, id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

// Atomic (tmp + rename) so readers never see a torn file. Returns whether the
// record landed: host.ts fails closed instead of staging a fork it cannot
// resolve, and the adapter logs what did not publish.
export function writeState(dir, id, record) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${id}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

export function removeState(dir, id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) return false;
  try {
    fs.unlinkSync(path.join(dir, `${id}.json`));
    return true;
  } catch {
    return false; // already gone
  }
}

/**
 * "<sessionId>#<userCount>" → { sourceSessionId, userCount }, or null when
 * the shape is wrong (no "#", a non-integer or negative count, an id that
 * could not be a state file).
 */
export function parseCheckpoint(checkpoint) {
  if (typeof checkpoint !== "string") return null;
  const sep = checkpoint.lastIndexOf("#");
  if (sep <= 0 || sep === checkpoint.length - 1) return null;
  const sourceSessionId = checkpoint.slice(0, sep);
  const userCount = Number(checkpoint.slice(sep + 1));
  if (!Number.isInteger(userCount) || userCount < 0) return null;
  if (!SAFE_ID.test(sourceSessionId)) return null;
  return { sourceSessionId, userCount };
}

/**
 * The checkpoint to stamp on this thread's next turn boundary, or null:
 * null when the adapter has not published state for the thread yet (first
 * prompt not dispatched), and null when the count was never confirmed by
 * Kilo's store (`seeded: false`) — the boundary is then left untouched and
 * editing that turn falls back to bb's honest 409 instead of a fabricated
 * checkpoint that could truncate the wrong messages.
 */
export function checkpointForThread(dir, threadId) {
  const record = readState(dir, threadId);
  if (record === null || record.kind !== "live") return null;
  if (record.seeded === false) return null;
  if (typeof record.sessionId !== "string" || typeof record.userCount !== "number") return null;
  return `${record.sessionId}#${record.userCount}`;
}

/**
 * One outgoing bridge line, rewritten in place:
 *
 *  - the ACP bridge hardcodes its initialize handshake to `fork: "tip"` while
 *    the registration says `checkpoint`, and bb takes the MINIMUM of the two —
 *    without the upgrade prepareThreadRewind throws before it ever reaches us;
 *  - `thread/delta` turn.boundary deltas get the thread's current checkpoint
 *    attached (`providerCheckpointId`), unless one is already present.
 *
 * Returns the rewritten line (trailing newline preserved) or null when the
 * line passes through untouched. Only single-line JSON strings are ever
 * rewritten; anything unparseable is left exactly as it was.
 */
export function rewriteOutgoingLine(line, dir) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;

  let changed = false;

  if (msg?.result?.capabilities?.fork === "tip") {
    msg.result.capabilities.fork = "checkpoint";
    changed = true;
  }

  if (msg?.method === "thread/delta" && Array.isArray(msg?.params?.deltas)) {
    const checkpoint = checkpointForThread(dir, msg.params.threadId);
    if (checkpoint !== null) {
      for (const delta of msg.params.deltas) {
        if (delta && delta.kind === "turn.boundary" && delta.providerCheckpointId === undefined) {
          delta.providerCheckpointId = checkpoint;
          changed = true;
        }
      }
    }
  }

  if (!changed) return null;
  return JSON.stringify(msg) + (line.endsWith("\n") ? "\n" : "");
}
