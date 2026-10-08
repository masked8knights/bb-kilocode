// bb-kilocode — checkpoint rewind: rebuild a Kilo Code session cut back to
// the turn before an edit.
//
// Kilo's ACP `session/fork` clones only at the tip (there is no head
// parameter), so rewinding is done from Kilo Code's own store instead:
//
//   kilo export <source>        → the full session as JSON (messages + parts)
//   truncate to turn N          → keep every message up to (but not including)
//                                 user message N+1 — the checkpoint's count
//   rewrite ids                 → session/messages/parts get fresh ids
//                                 (sessionID, messageID and the parentID chain
//                                 included), or `kilo import` would collide
//                                 with — or silently graft onto — the source
//   kilo import <file>          → a new session, with the process cwd fixed to
//                                 the target directory so the clone runs there
//
// The caller then ACP `session/load`s the new id into its own `kilo acp`
// child (adapter/acp.mjs), so the replayed turn sees the retained history as
// real prior context. Export/import run as detached subprocesses — never on
// the ACP child's stdio — and their stdout is captured in memory (a long
// coding session exports to multiple megabytes; a fixed-size sync buffer
// would truncate it and `JSON.parse` would fail).
//
// Pure pieces (keepMessages, rewriteExport) are side-effect-free so the
// truncation and id rewrite are unit-testable without a kilo binary.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID in Kilo's own id alphabet — time-ordered, collision-safe. */
export function mintUlid() {
  let t = Date.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(Math.random() * 32)];
  return time + rand;
}

/** A session id in Kilo's own format (`ses_` + ULID). */
export function newSessionId() {
  return `ses_${mintUlid()}`;
}

/**
 * Keep messages through the end of turn `keepUserCount`: everything up to,
 * but not including, user message keepUserCount + 1. When the transcript holds
 * fewer user messages than the checkpoint claims, it is returned unchanged —
 * a checkpoint captured from this store can never overshoot it, and cloning
 * fewer messages than asked would silently drop retained history.
 */
export function keepMessages(messages, keepUserCount) {
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.info?.role === "user") {
      seen += 1;
      if (seen > keepUserCount) return messages.slice(0, i);
    }
  }
  return messages;
}

/**
 * A fresh export object for an import: optionally truncated to
 * `truncateTo` user messages, re-id'd as `newSessionId` (default: mint one)
 * and rooted at `directory` when the clone belongs somewhere other than the
 * source session's workspace. Every id a foreign reference can point at is
 * rewritten in one pass — message ids, part `sessionID`/`messageID`, and each
 * message's `parentID` (a parent outside the kept prefix is dropped rather
 * than left dangling).
 */
export function rewriteExport(exported, { truncateTo, newSessionId: sessionId, directory } = {}) {
  const sid = sessionId ?? newSessionId();
  const messages = truncateTo === null || truncateTo === undefined
    ? exported.messages
    : keepMessages(exported.messages, truncateTo);

  const idMap = new Map();
  for (const m of messages) idMap.set(m.info.id, `msg_${mintUlid()}`);

  const info = { ...exported.info, id: sid };
  if (typeof directory === "string" && directory.length > 0) {
    info.directory = directory;
    info.path = directory.replace(/^\//, ""); // Kilo stores it slash-less
  }

  return {
    info,
    messages: messages.map((m) => ({
      ...m,
      info: {
        ...m.info,
        id: idMap.get(m.info.id),
        sessionID: sid,
        ...(m.info.parentID ? { parentID: idMap.get(m.info.parentID) } : {}),
      },
      parts: (m.parts || []).map((p) => ({
        ...p,
        id: `prt_${mintUlid()}`,
        sessionID: sid,
        messageID: idMap.get(m.info.id),
      })),
    })),
  };
}

/**
 * Run a one-shot kilo subcommand (`export`, `import`), capturing stdout and
 * stderr in memory. Resolves with stdout on exit 0; rejects with the exit
 * status and the stderr tail otherwise. Diagnostics never reach the bridge's
 * stderr — they belong in the adapter log.
 */
function runKilo(kiloBin, args, { cwd, timeoutMs, log } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(kiloBin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs ?? 55_000);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      // 512 MB of session export is beyond any real transcript; refuse rather
      // than grow without bound.
      if (outBytes > 512 * 1024 * 1024) {
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errBytes += chunk.length;
      if (errBytes <= 64 * 1024) err.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (timedOut) {
        log?.("kilo subcommand timed out", { args: args[0], timeoutMs });
        reject(new Error(`kilo ${args[0]} did not finish in time.`));
        return;
      }
      if (code !== 0) {
        log?.("kilo subcommand failed", { args: args[0], code, signal, stderr: stderr.slice(-400) });
        const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
        reject(new Error(`kilo ${args[0]} failed (exit ${code}): ${tail || "no diagnostic output"}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Clone `sourceSessionId` cut back to `truncateTo` user messages (null keeps
 * the whole transcript) as a brand-new session living in `cwd`.
 * Returns the new session id; the import has fully committed by then, so the
 * caller may load it over ACP immediately.
 */
export async function cloneSession({ kiloBin, sourceSessionId, truncateTo, cwd, log }) {
  if (typeof sourceSessionId !== "string" || sourceSessionId.length === 0) {
    throw new Error("The rewind source session is missing from the checkpoint.");
  }
  const exportedRaw = await runKilo(kiloBin, ["export", sourceSessionId], { log });
  let exported;
  try {
    exported = JSON.parse(exportedRaw);
  } catch (error) {
    throw new Error(`Kilo Code exported an unreadable transcript: ${String(error?.message || error)}`);
  }
  if (!exported || !Array.isArray(exported.messages)) {
    throw new Error("Kilo Code exported no messages for this session.");
  }

  const target = typeof cwd === "string" && cwd.length > 0 ? cwd : null;
  const rewritten = rewriteExport(exported, { truncateTo, directory: target ?? undefined });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-kilo-clone-"));
  const file = path.join(dir, "fork.json");
  try {
    fs.writeFileSync(file, JSON.stringify(rewritten));
    // The import must run inside the target directory: Kilo takes the session's
    // working directory from the process cwd.
    await runKilo(kiloBin, ["import", file], { cwd: target ?? undefined, log });
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // a leftover temp dir is harmless; never fail the clone over cleanup
    }
  }
  return rewritten.info.id;
}
