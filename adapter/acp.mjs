#!/usr/bin/env node
// bb-kilocode — ACP adapter.
//
// Speaks the Agent Client Protocol over stdio (what BB's ACP provider bridge
// launches) and drives the Kilo Code CLI's own `kilo acp` server as a child
// process on stdio. Every JSON-RPC line is forwarded byte-for-byte in both
// directions — Kilo Code's own capabilities reach BB unmodified.
//
// On top of that pass-through sit bb's checkpoint duties (the registry and
// its record shapes are documented in adapter/checkpoint.mjs):
//
//   publish   on `session/new` / `session/prompt` / `session/load` /
//             `session/fork`, count the session's user messages — from
//             Kilo's own store (`~/.local/share/kilo/kilo.db`) when it can
//             confirm them, else from the registry, else as `seeded:false`
//             — and write the record under both the session id and
//             BB_THREAD_ID, so host.ts can stamp providerCheckpointIds onto
//             turn boundaries. The settled-turn recount runs *before* the
//             prompt response is forwarded, i.e. before the bridge emits the
//             boundary that carries it.
//   rebuild   when host.ts staged a rewind, `session/fork` is answered here
//             instead of reaching Kilo's tip-only fork: `kilo export` →
//             truncate to the checkpoint's count → rewrite ids → `kilo
//             import` into the target directory → `session/load` into our own
//             child → respond with the new session id (adapter/rewind.mjs).
//   forward   every other line, including plain tip forks, goes to `kilo acp`
//             untouched; a tip fork's new session is re-counted from the
//             store on its response.
//
// Usage accounting lives in Kilo Code's own store (BB's usage plugin reads it
// from there), so this adapter writes no ledger of its own.
//
// Usage:
//   node adapter/acp.mjs              ACP stdio server (launched by BB)
//   node adapter/acp.mjs --version    print the Kilo CLI version and exit
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readState, removeState, stateDirFrom, writeState } from "./checkpoint.mjs";
import { cloneSession } from "./rewind.mjs";
import { resolveKiloBin } from "./kilo-bin.mjs";

// ---------------------------------------------------------------------------
// logging — stdout is the ACP channel, so diagnostics go to a file
// ---------------------------------------------------------------------------
const LOG_PATH =
  process.env.KILO_ADAPTER_LOG ||
  path.join(os.tmpdir(), `bb-kilocode-${process.pid}.log`);
const log = (msg, extra) => {
  try {
    fs.appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} ${msg}${
        extra === undefined ? "" : " " + JSON.stringify(extra)
      }\n`,
    );
  } catch {}
};

// Free of digit.digit.digit patterns on purpose: BB's health probe reads
// `--version` output for a semver, and a missing CLI must report no version
// rather than a number lifted out of the error text.
const KILO_MISSING =
  "kilo CLI not found on this machine: set KILO_BIN to its path, or install it from https://kilo.ai/cli/install";

const argv = process.argv.slice(2);
if (argv.length > 0 && ["--version", "-v", "-V"].includes(argv[0])) {
  const bin = resolveKiloBin();
  if (bin === null) {
    process.stderr.write(`${KILO_MISSING}\n`);
    process.exit(1);
  }
  const probe = spawnSync(bin, ["--version"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  if (probe.error) {
    process.stderr.write(`${KILO_MISSING}\n`);
    process.exit(1);
  }
  process.exit(probe.status === null ? 1 : probe.status);
}

const kiloBin = resolveKiloBin();
if (kiloBin === null) {
  process.stderr.write(`${KILO_MISSING}\n`);
  log("kilo CLI not found");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// checkpoint state — publish counts, resolve seeded sessions
// ---------------------------------------------------------------------------
const STATE_DIR = stateDirFrom(process.env);
const BB_THREAD_ID = process.env.BB_THREAD_ID || null;

function publish(sessionId, { cwd = null, userCount, seeded }) {
  if (typeof sessionId !== "string") return;
  const record = {
    kind: "live",
    sessionId,
    bbThreadId: BB_THREAD_ID,
    cwd,
    userCount,
    seeded: seeded !== false,
    updatedAt: Date.now(),
  };
  if (!writeState(STATE_DIR, sessionId, record)) {
    log("state write failed", { id: sessionId });
  }
  if (BB_THREAD_ID !== null && !writeState(STATE_DIR, BB_THREAD_ID, record)) {
    log("state write failed", { id: BB_THREAD_ID });
  }
  log("state published", {
    sessionId,
    bbThreadId: BB_THREAD_ID,
    userCount: record.userCount,
    seeded: record.seeded,
  });
}

// node:sqlite is loaded lazily and never fatally: on a node too old for it,
// or a machine without Kilo's store, counts fall back to the registry (or
// `seeded:false`) and nothing about a turn changes.
const requireBuiltin = createRequire(import.meta.url);
let DatabaseSyncCache; // undefined = not tried yet, null = unavailable
function databaseSync() {
  if (DatabaseSyncCache === undefined) {
    try {
      DatabaseSyncCache = requireBuiltin("node:sqlite").DatabaseSync;
    } catch {
      DatabaseSyncCache = null;
    }
  }
  return DatabaseSyncCache;
}

function kiloDbPath() {
  const candidates = [];
  if (process.env.XDG_DATA_HOME) {
    candidates.push(path.join(process.env.XDG_DATA_HOME, "kilo", "kilo.db"));
  }
  candidates.push(path.join(os.homedir(), ".local", "share", "kilo", "kilo.db"));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // unreadable parent — keep looking
    }
  }
  return null;
}

// The count a checkpoint is allowed to trust: `kilo export` truncation counts
// role:"user" messages, so counting the same rows here keeps capture and cut
// on the same definition — a store-confirmed count can never truncate a
// different set of messages than the one it was captured from.
function dbUserCount(sessionId) {
  const DatabaseSync = databaseSync();
  if (DatabaseSync === null) return null;
  const file = kiloDbPath();
  if (file === null) return null;
  let db = null;
  try {
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch {
      db = new DatabaseSync(file); // older node:sqlite without the option
    }
    try {
      db.exec("PRAGMA busy_timeout = 1000");
    } catch {
      // not fatal — a busy store just fails the query below
    }
    const rows = db.prepare("SELECT data FROM message WHERE session_id = ?").all(sessionId);
    let count = 0;
    for (const row of rows) {
      try {
        if (JSON.parse(row.data)?.role === "user") count += 1;
      } catch {
        // one unreadable row must not invalidate the whole count
      }
    }
    return count;
  } catch (error) {
    log("db user count failed", { sessionId, error: String(error?.message || error) });
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

// First sight of a session (resume, fork): the store decides, then a record
// an earlier process left behind; with nothing to confirm the count the
// record publishes `seeded:false` and host.ts stamps nothing — an edit then
// honestly 409s instead of cutting against a guessed history.
function seedAndPublish(sessionId, { cwd = null, hints = [] } = {}) {
  const db = dbUserCount(sessionId);
  if (db !== null) {
    publish(sessionId, { cwd, userCount: db, seeded: true });
    return;
  }
  for (const hint of hints) {
    if (
      hint !== null &&
      hint !== undefined &&
      hint.kind === "live" &&
      hint.seeded !== false &&
      typeof hint.userCount === "number"
    ) {
      publish(sessionId, {
        cwd: cwd ?? hint.cwd ?? null,
        userCount: hint.userCount,
        seeded: true,
      });
      return;
    }
  }
  publish(sessionId, { cwd, userCount: 0, seeded: false });
}

// A tip fork carries the source's history: from the new session's store when
// Kilo has committed the copy, else the source's store, else the source's
// registry record; only when none can confirm the count does the target
// publish `seeded:false` (the first prompt re-seeds it from the store).
function publishForkTarget(newId, sourceId, cwd) {
  const db = dbUserCount(newId);
  if (db !== null && db > 0) {
    publish(newId, { cwd, userCount: db, seeded: true });
    return;
  }
  const sourceDb = sourceId !== null ? dbUserCount(sourceId) : null;
  if (sourceDb !== null) {
    publish(newId, { cwd, userCount: sourceDb, seeded: true });
    return;
  }
  const sourceRecord = sourceId !== null ? readState(STATE_DIR, sourceId) : null;
  if (
    sourceRecord !== null &&
    sourceRecord.kind === "live" &&
    sourceRecord.seeded !== false &&
    typeof sourceRecord.userCount === "number"
  ) {
    publish(newId, { cwd, userCount: sourceRecord.userCount, seeded: true });
    return;
  }
  if (db !== null) {
    publish(newId, { cwd, userCount: db, seeded: true });
    return;
  }
  publish(newId, { cwd, userCount: 0, seeded: false });
}

// A prompt is about to be forwarded: the store does not hold it yet, so the
// count this turn will settle at is the store's count + 1 (or the registry's
// + 1 when the store cannot be read).
function observePromptArrival(params) {
  const sessionId = params?.sessionId;
  if (typeof sessionId !== "string") return;
  const record = readState(STATE_DIR, sessionId);
  const db = dbUserCount(sessionId);
  if (db !== null) {
    publish(sessionId, { cwd: record?.cwd ?? null, userCount: db + 1, seeded: true });
    return;
  }
  if (record !== null && record.kind === "live" && typeof record.userCount === "number") {
    publish(sessionId, {
      cwd: record?.cwd ?? null,
      userCount: record.userCount + 1,
      seeded: record.seeded !== false,
    });
    return;
  }
  publish(sessionId, { cwd: record?.cwd ?? null, userCount: 1, seeded: false });
}

// The prompt settled: recount against the store so a prompt Kilo did not
// record (an auth refusal, a cancel before receipt) cannot leave the estimate
// one message ahead of what `kilo export` will later return. Runs before the
// response is forwarded — the bridge emits this turn's boundary from it.
function observePromptSettled(sessionId) {
  const db = dbUserCount(sessionId);
  if (db === null) return;
  const record = readState(STATE_DIR, sessionId);
  if (
    record !== null &&
    record.kind === "live" &&
    record.userCount === db &&
    record.seeded !== false
  ) {
    return;
  }
  publish(sessionId, { cwd: record?.cwd ?? null, userCount: db, seeded: true });
}

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------
log("starting", { kilo: kiloBin, adapter: fileURLToPath(import.meta.url) });

const child = spawn(kiloBin, ["acp"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });

child.on("error", (error) => {
  const detail = String((error && error.message) || error);
  process.stderr.write(`${KILO_MISSING}: ${detail}\n`);
  log("spawn failed", { error: detail });
  process.exit(1);
});

// Bridge requests we may need to observe (or answer) later, keyed by their
// JSON-RPC id. Requests we inject into the child live in a separate id space
// so an answer can never be mistaken for the bridge's.
const INJECTED_ID_BASE = 0x40000000; // 2^30 — far past any bridge id counter
let injectedSeq = 0;
const pendingInjected = new Map();
const pendingBridge = new Map();

function childRequest(method, params, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (!child.stdin.writable) {
      reject(new Error("The Kilo Code ACP server is not running."));
      return;
    }
    const id = INJECTED_ID_BASE + ++injectedSeq;
    const timer = setTimeout(() => {
      pendingInjected.delete(id);
      reject(new Error(`Kilo Code did not answer ${method} within ${timeoutMs}ms.`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    pendingInjected.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function respondResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function forwardToChild(line) {
  if (child.stdin.writable) child.stdin.write(line);
}

function forwardToBridge(line) {
  process.stdout.write(line);
}

function parseMessage(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const message = JSON.parse(trimmed);
    return typeof message === "object" && message !== null ? message : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// outgoing: child → bridge. Injected answers are consumed here, observed
// bridge responses are recounted first, and the original line always travels
// on untouched.
// ---------------------------------------------------------------------------
function observeBridgeResponse(tracked, message) {
  const { method, params } = tracked;
  if (method === "session/new") {
    const sessionId = message?.result?.sessionId;
    if (typeof sessionId === "string") {
      publish(sessionId, { cwd: params?.cwd ?? null, userCount: 0, seeded: true });
    }
    return;
  }
  if (method === "session/load") {
    if (message.error !== undefined || !message.result) return; // bridge falls back to session/new
    const sessionId = params?.sessionId;
    if (typeof sessionId === "string") {
      seedAndPublish(sessionId, {
        cwd: params?.cwd ?? null,
        hints: [readState(STATE_DIR, sessionId)],
      });
    }
    return;
  }
  if (method === "session/fork") {
    const newId = message?.result?.sessionId;
    if (typeof newId !== "string") return;
    const sourceId = typeof params?.sessionId === "string" ? params.sessionId : null;
    publishForkTarget(newId, sourceId, params?.cwd ?? null);
    return;
  }
  if (method === "session/prompt") {
    if (typeof params?.sessionId === "string") observePromptSettled(params.sessionId);
  }
}

function handleChildLine(line) {
  const message = parseMessage(line);
  if (message !== null) {
    const id = message.id;
    if (typeof id === "number" && id >= INJECTED_ID_BASE && pendingInjected.has(id)) {
      const pending = pendingInjected.get(id);
      pendingInjected.delete(id);
      if (message.error !== undefined) {
        pending.reject(
          new Error(message.error?.message || JSON.stringify(message.error)),
        );
      } else {
        pending.resolve(message.result);
      }
      return; // our own answer — the bridge must never see this id
    }
    const tracked = id === undefined ? undefined : pendingBridge.get(id);
    if (tracked !== undefined) {
      pendingBridge.delete(id);
      try {
        observeBridgeResponse(tracked, message);
      } catch (error) {
        log("response observation failed", {
          method: tracked.method,
          error: String(error?.message || error),
        });
      }
    }
  }
  forwardToBridge(line);
}

// ---------------------------------------------------------------------------
// incoming: bridge → child. Only a staged rewind's session/fork is pulled off
// the wire; everything else is forwarded as it arrived.
// ---------------------------------------------------------------------------
let forkQueue = Promise.resolve();

function queueStagedFork(id, params, staged) {
  forkQueue = forkQueue
    .then(() => runStagedFork(id, params, staged))
    .catch((error) => {
      log("staged fork queue error", { error: String(error?.message || error) });
    });
}

async function runStagedFork(id, params, staged) {
  const cwd = typeof params?.cwd === "string" && params.cwd.length > 0 ? params.cwd : process.cwd();
  const stagedId = params.sessionId;
  try {
    const newId = await cloneSession({
      kiloBin,
      sourceSessionId: staged.sourceSessionId,
      truncateTo: typeof staged.truncateTo === "number" ? staged.truncateTo : null,
      cwd,
      log,
    });
    // Consumed: a later thread/discard for this id is a no-op.
    removeState(STATE_DIR, stagedId);

    const loadResult = await childRequest(
      "session/load",
      { sessionId: newId, cwd, mcpServers: params?.mcpServers ?? [] },
      60_000,
    );
    const db = dbUserCount(newId);
    const fallback = typeof staged.truncateTo === "number" ? staged.truncateTo : 0;
    publish(newId, { cwd, userCount: db !== null && db > 0 ? db : fallback, seeded: true });
    respondResult(id, {
      ...(loadResult !== null && typeof loadResult === "object" ? loadResult : {}),
      sessionId: newId,
    });
    log("staged fork completed", { stagedId, newId, truncateTo: staged.truncateTo });
  } catch (error) {
    const message = String(error?.message || error);
    log("staged fork failed", { stagedId, error: message });
    respondError(
      id,
      -32603,
      `Kilo Code could not rebuild the session for this rewind: ${message}`,
    );
  }
}

function handleBridgeLine(line) {
  const message = parseMessage(line);
  if (message !== null && typeof message.method === "string") {
    const { id, method, params } = message;
    const hasId = typeof id === "number" || typeof id === "string";

    if (method === "session/fork" && hasId) {
      const sourceId = typeof params?.sessionId === "string" ? params.sessionId : null;
      const staged = sourceId !== null ? readState(STATE_DIR, sourceId) : null;
      if (staged !== null && staged.kind === "staged") {
        // A rewind host.ts staged: Kilo's tip-only fork cannot cut history
        // back, so the clone is rebuilt here and the bridge is answered only
        // once the replacement session exists and is loaded.
        log("staged session/fork", {
          stagedId: sourceId,
          sourceSessionId: staged.sourceSessionId,
          truncateTo: staged.truncateTo,
        });
        queueStagedFork(id, params, staged);
        return;
      }
      if (hasId) pendingBridge.set(id, { method, params });
      forwardToChild(line);
      return;
    }

    if (method === "session/new" || method === "session/load" || method === "session/prompt") {
      if (hasId) pendingBridge.set(id, { method, params });
      if (method === "session/prompt") {
        try {
          observePromptArrival(params);
        } catch (error) {
          log("prompt count failed", { error: String(error?.message || error) });
        }
      }
      forwardToChild(line);
      return;
    }
  }
  forwardToChild(line);
}

// Line-oriented pass-through: stdin is forwarded as soon as a newline lands
// so a long prompt never waits on the child's own buffering.
let stdinBuffer = "";
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk.toString("utf8");
  let index;
  while ((index = stdinBuffer.indexOf("\n")) >= 0) {
    const line = stdinBuffer.slice(0, index + 1);
    stdinBuffer = stdinBuffer.slice(index + 1);
    handleBridgeLine(line);
  }
});
process.stdin.on("error", () => {});
process.stdin.on("end", () => {
  if (child.stdin.writable) child.stdin.end();
});

let stdoutBuffer = "";
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  let index;
  while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, index + 1);
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    handleChildLine(line);
  }
});
child.stdout.on("error", () => {});

// The CLI's own diagnostics: forwarded verbatim so BB's session error keeps
// the agent's tail (BB already records the child's IO).
child.stderr.on("data", (chunk) => {
  try {
    process.stderr.write(chunk);
  } catch {}
});

let exiting = false;
function exitWith(code) {
  if (exiting) return;
  exiting = true;
  const done = () => process.exit(code);
  if (stdoutBuffer !== "") {
    const tail = stdoutBuffer;
    stdoutBuffer = "";
    process.stdout.write(tail, () => done());
    return;
  }
  done();
}

child.on("exit", (code, signal) => {
  log("kilo acp exited", { code, signal });
  exitWith(code === null ? 0 : code);
});

const forwardSignal = (signal) => () => {
  log("signal", { signal });
  try {
    child.kill(signal);
  } catch {}
  const timer = setTimeout(() => exitWith(0), 2_000);
  if (typeof timer.unref === "function") timer.unref();
};
process.on("SIGTERM", forwardSignal("SIGTERM"));
process.on("SIGINT", forwardSignal("SIGINT"));
process.on("SIGHUP", forwardSignal("SIGHUP"));
process.on("exit", () => {
  try {
    child.kill("SIGTERM");
  } catch {}
});
