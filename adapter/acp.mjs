#!/usr/bin/env node
// bb-kilocode — ACP adapter.
//
// Speaks the Agent Client Protocol over stdio (what BB's ACP provider bridge
// launches) and drives the Kilo Code CLI's own `kilo acp` server as a child
// process on stdio. Every JSON-RPC line is forwarded byte-for-byte in both
// directions — this process observes traffic, it does not translate it — and
// journals one `{"kind":"generation","fact":{...}}` line per settled turn into
// ~/.kilocode/usage.jsonl (adapter/usage.mjs), because the kilo CLI keeps no
// usage ledger of its own in a stable, parseable shape.
//
// Usage:
//   node adapter/acp.mjs              ACP stdio server (launched by BB)
//   node adapter/acp.mjs --version    print the Kilo CLI version and exit
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendUsageLine,
  buildUsageFact,
  defaultUsageFile,
  hasUsage,
  usageLine,
} from "./usage.mjs";

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

// ---------------------------------------------------------------------------
// kilo binary
// ---------------------------------------------------------------------------
const isExecutable = (candidate) => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function resolveKiloBin(env, homedir) {
  const source = env ?? process.env;
  const home = homedir ?? os.homedir();
  const override = (source.KILO_BIN || "").trim();
  // An explicit override is honored exactly: a wrong path must fail loudly
  // instead of silently running a different kilo than the operator named.
  if (override !== "") return isExecutable(override) ? override : null;
  const dataHome = (source.XDG_DATA_HOME || "").trim() || path.join(home, ".local", "share");
  const candidates = [path.join(home, ".kilo", "bin", "kilo"), path.join(dataHome, "kilo", "bin", "kilo")];
  for (const candidate of candidates) if (isExecutable(candidate)) return candidate;
  for (const dir of (source.PATH || "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, "kilo");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

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
// observed state
// ---------------------------------------------------------------------------
// sessionId -> { cwd, model, cost, promptCostBaseline }
const sessions = new Map();
// request id -> { method, params }
const pending = new Map();

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const modelFromConfigOptions = (configOptions) => {
  if (!Array.isArray(configOptions)) return undefined;
  const model = configOptions.find((option) => option && option.id === "model");
  return typeof model?.currentValue === "string" ? model.currentValue : undefined;
};

const touchSession = (sessionId, patch) => {
  if (typeof sessionId !== "string" || sessionId === "") return;
  const existing = sessions.get(sessionId) || { cwd: undefined, model: undefined, cost: 0 };
  sessions.set(sessionId, { ...existing, ...patch });
};

/**
 * Journal the turn that just settled. Tokens come from the prompt result;
 * cost is the delta of the session-cumulative figure kilo reports in
 * `usage_update`, recorded only when it actually grew (a free tier reports
 * 0, and null is more honest than an invented number).
 */
function recordTurn(sessionId, result) {
  try {
    const usage = result && result.usage;
    if (!hasUsage(usage)) return;
    const session = sessions.get(sessionId);
    const baseline = num(session && session.promptCostBaseline);
    const cost = num(session && session.cost);
    const fact = buildUsageFact({
      usage,
      model: session && session.model,
      cwd: session && session.cwd,
      sessionId,
      costDelta: cost - baseline,
    });
    const file = defaultUsageFile();
    appendUsageLine(file, usageLine(fact));
    if (session) session.promptCostBaseline = cost;
    log("usage recorded", {
      file,
      model: fact.model,
      input_tokens: fact.input_tokens,
      output_tokens: fact.output_tokens,
      total_cost: fact.total_cost,
    });
  } catch (error) {
    // Never let the journal break the turn.
    log("usage record failed", { error: String((error && error.message) || error) });
  }
}

function observeClientLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== "object") return;
  if (message.method === "session/prompt") {
    // A prompt starting resets the cost baseline its result is measured against.
    const session = sessions.get(message.params && message.params.sessionId);
    if (session) session.promptCostBaseline = num(session.cost);
  }
  if (typeof message.method === "string" && message.id !== undefined) {
    pending.set(message.id, { method: message.method, params: message.params });
  }
}

function observeClientResponse(message) {
  const request = pending.get(message.id);
  if (request === undefined) return;
  pending.delete(message.id);
  if (message.error !== undefined) return;

  const result = message.result;
  const params = request.params || {};
  if (request.method === "session/new") {
    touchSession(result && result.sessionId, {
      cwd: typeof params.cwd === "string" ? params.cwd : undefined,
      model: modelFromConfigOptions(result && result.configOptions),
      cost: 0,
      promptCostBaseline: 0,
    });
    return;
  }
  if (request.method === "session/fork" || request.method === "session/resume") {
    touchSession(result && result.sessionId, {
      cwd: typeof params.cwd === "string" ? params.cwd : undefined,
      model: modelFromConfigOptions(result && result.configOptions),
      cost: 0,
      promptCostBaseline: 0,
    });
    return;
  }
  if (request.method === "session/set_config_option" && params.configId === "model") {
    if (typeof params.value === "string") touchSession(params.sessionId, { model: params.value });
    return;
  }
  if (request.method === "session/set_model") {
    if (typeof params.modelId === "string") touchSession(params.sessionId, { model: params.modelId });
    return;
  }
  if (request.method === "session/prompt") recordTurn(params.sessionId, result);
}

function observeAgentLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== "object") return;

  if (message.method === undefined && message.id !== undefined) {
    observeClientResponse(message);
    return;
  }
  if (message.method !== "session/update") return;
  const params = message.params || {};
  const update = params.update;
  if (!update || typeof update !== "object") return;

  if (update.sessionUpdate === "usage_update") {
    const amount = update.cost && update.cost.amount;
    if (typeof amount === "number" && Number.isFinite(amount)) {
      touchSession(params.sessionId, { cost: amount });
    }
    return;
  }
  if (update.sessionUpdate !== "config_option_update") return;
  const option = update.configOption;
  if (option && option.id === "model" && typeof option.currentValue === "string") {
    touchSession(params.sessionId, { model: option.currentValue });
  } else if (option === undefined && Array.isArray(update.configOptions)) {
    touchSession(params.sessionId, { model: modelFromConfigOptions(update.configOptions) });
  }
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

let stdinBuffer = "";
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk.toString("utf8");
  let index;
  while ((index = stdinBuffer.indexOf("\n")) >= 0) {
    const line = stdinBuffer.slice(0, index + 1);
    stdinBuffer = stdinBuffer.slice(index + 1);
    observeClientLine(line);
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
    observeAgentLine(line);
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
    observeAgentLine(tail);
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
