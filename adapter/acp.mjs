#!/usr/bin/env node
// bb-kilocode — ACP adapter.
//
// Speaks the Agent Client Protocol over stdio (what BB's ACP provider bridge
// launches) and drives the Kilo Code CLI's own `kilo acp` server as a child
// process on stdio. Every JSON-RPC line is forwarded byte-for-byte in both
// directions — this process observes nothing and translates nothing, so Kilo
// Code's own capabilities reach BB unmodified. Usage accounting lives in
// Kilo Code's own store (BB's usage plugin reads it from there), so this
// adapter writes no ledger of its own.
//
// Usage:
//   node adapter/acp.mjs              ACP stdio server (launched by BB)
//   node adapter/acp.mjs --version    print the Kilo CLI version and exit
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// Line-oriented pass-through: stdin is forwarded as soon as a newline lands
// so a long prompt never waits on the child's own buffering.
let stdinBuffer = "";
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk.toString("utf8");
  let index;
  while ((index = stdinBuffer.indexOf("\n")) >= 0) {
    const line = stdinBuffer.slice(0, index + 1);
    stdinBuffer = stdinBuffer.slice(index + 1);
    if (child.stdin.writable) child.stdin.write(line);
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
    process.stdout.write(line);
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
