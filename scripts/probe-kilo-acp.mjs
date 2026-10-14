#!/usr/bin/env node
// Probe: does Kilo Code's ACP server advertise its model catalog over the
// SAME launch BB's bridge uses (server.ts acpLaunchSpec → adapter/acp.mjs →
// `kilo acp` on stdio)?
//
// Speaks raw JSON-RPC line protocol: initialize → session/new {cwd:tmpdir,
// mcpServers:[]} → dumps the full response and reports whether models arrive
// via result.models.availableModels and/or result.configOptions category
// "model" — the two shapes the SDK bridge's loadSessionDiscoveredModels reads
// (buildModelCatalogFromSessionModels / buildModelCatalogFromConfigOptions).
//
// Usage: node scripts/probe-kilo-acp.mjs [--raw]
//   --raw  also print the complete session/new result JSON
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveKiloBin } from "../adapter/kilo-bin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ADAPTER = path.join(ROOT, "adapter", "acp.mjs");
const RAW = process.argv.includes("--raw");

// ---------------------------------------------------------------------------
// Launch exactly what the bridge would spawn:
//   server.ts launchCommand(): the adapter directly when executable, else
//   `node <adapter>`; env carries BB_KILO_STATE_DIR (same default as the
//   registration) and, on this machine, KILO_BIN when no kilo is resolvable
//   from PATH (~/.kilo/bin, XDG dir) — the adapter requires it to spawn
//   `kilo acp`.
// ---------------------------------------------------------------------------
const childEnv = { ...process.env };
if (!resolveKiloBin(childEnv)) {
  // Fall back to the KiloDesktop-bundled CLI so the probe can run on a
  // machine with the desktop app but no standalone CLI install.
  const bundled = [
    path.join(process.env.LOCALAPPDATA || "", "KiloDesktop"),
  ];
  let found = null;
  for (const dir of bundled) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const app of fs.readdirSync(dir)) {
      const candidate = path.join(
        dir,
        app,
        "resources",
        "kilo",
        "windows-x64-baseline",
        "bin",
        "kilo.exe",
      );
      if (fs.existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  }
  if (found) {
    childEnv.KILO_BIN = found;
    console.log(`(no kilo on PATH; probing with KILO_BIN=${found})`);
  } else {
    console.log("(no kilo CLI resolvable — the adapter will fail to spawn)");
  }
}

let launch;
try {
  if (process.platform === "win32") throw new Error("windows cannot exec .mjs directly");
  fs.accessSync(ADAPTER, fs.constants.X_OK);
  launch = { command: ADAPTER, args: [] };
} catch {
  launch = { command: process.execPath, args: [ADAPTER] };
}
console.log(`launch: ${launch.command} ${launch.args.join(" ")}`);

const child = spawn(launch.command, [...launch.args], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...childEnv,
    BB_KILO_STATE_DIR: childEnv.BB_KILO_STATE_DIR || path.join(os.tmpdir(), "bb-kilo-state"),
  },
});

child.on("error", (error) => {
  console.error("spawn failed:", error.message);
  process.exit(1);
});

let stderrTail = "";
child.stderr.on("data", (chunk) => {
  stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8000);
});

// ---------------------------------------------------------------------------
// minimal line JSON-RPC client (same shape as the adapter's own buffering)
// ---------------------------------------------------------------------------
let buffer = "";
let nextId = 1;
const pending = new Map();

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params, timeoutMs) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.log("(non-JSON line)", line.slice(0, 200));
      continue;
    }
    const id = message.id;
    if (id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        if (message.error) entry.reject(new Error(`${JSON.stringify(message.error)}`));
        else entry.resolve(message.result);
      }
      continue;
    }
    // Agent-initiated request (session/request_permission etc.) or
    // notification — model discovery must not answer requests.
    if (id !== undefined && message.method) {
      console.log(`(agent request ${message.method} — replying -32601)`);
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "probe does not handle agent requests" } });
      continue;
    }
    if (message.method) console.log(`(notification ${message.method})`);
  }
});

child.on("exit", (code, signal) => {
  console.log(`(adapter exited code=${code} signal=${signal})`);
  if (stderrTail) console.log("stderr tail:\n" + stderrTail.slice(-3000));
});

// ---------------------------------------------------------------------------
// handshake — identical params to the SDK bridge's requestAcpInitialize
// (protocolVersion 1, clientInfo bb/1.0.0, capabilities with fsAccess false,
// parameterizedModelPicker false), then session/new like
// loadSessionDiscoveredModels.
// ---------------------------------------------------------------------------
try {
  const init = await request(
    "initialize",
    {
      protocolVersion: 1,
      clientInfo: { name: "bb", version: "1.0.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    },
    30_000,
  );
  console.log("\n=== initialize result ===");
  console.log("agentInfo:", JSON.stringify(init.agentInfo ?? null));
  console.log("authMethods:", JSON.stringify((init.authMethods ?? []).map((m) => m?.id)));
  console.log(
    "agentCapabilities:",
    JSON.stringify({
      loadSession: init.agentCapabilities?.loadSession,
      session: init.agentCapabilities?.session,
      prompt: init.agentCapabilities?.prompt,
    }),
  );

  const session = await request(
    "session/new",
    { cwd: os.tmpdir(), mcpServers: [] },
    30_000,
  );

  console.log("\n=== session/new result: shapes the bridge can read ===");
  const available = Array.isArray(session.models?.availableModels) ? session.models.availableModels : [];
  console.log(`result.models.availableModels: ${available.length} entries (currentModelId=${JSON.stringify(session.models?.currentModelId ?? null)})`);
  for (const model of available.slice(0, 12)) {
    console.log(`  - ${model.modelId}${model.name ? ` | ${model.name}` : ""}${model.description ? ` | ${model.description}` : ""}`);
  }
  if (available.length > 12) console.log(`  ... (${available.length - 12} more)`);

  const options = Array.isArray(session.configOptions) ? session.configOptions : [];
  console.log(`result.configOptions: ${options.length} total`);
  for (const option of options) {
    const opts = Array.isArray(option.options) ? option.options : [];
    console.log(`  - id=${option.id} category=${JSON.stringify(option.category ?? null)} type=${option.type} options=${opts.length} currentValue=${JSON.stringify(option.currentValue ?? null)}`);
    const isModel = option.category === "model" || option.id === "model";
    if (isModel && opts.length > 0) {
      console.log(`    MODEL OPTION: ${opts.length} selectable models`);
      for (const entry of opts.slice(0, 12)) {
        console.log(`      - value=${entry.value}${entry.name ? ` | name=${entry.name}` : ""}`);
      }
      if (opts.length > 12) console.log(`      ... (${opts.length - 12} more)`);
    }
  }

  const modelOption = options.find((o) => o.category === "model" || o.id === "model");
  const modelOptionCount = Array.isArray(modelOption?.options) ? modelOption.options.length : 0;
  console.log("\n=== verdict ===");
  console.log(
    `discovery works via ACP: ${available.length > 0 || modelOptionCount > 0 ? "YES" : "NO"} ` +
    `(availableModels=${available.length}, configOptions-model=${modelOptionCount})`,
  );
  if (RAW) {
    console.log("\n=== full session/new result ===");
    console.log(JSON.stringify(session, null, 2));
  }

  // Auto-detection of the primary ids the bridge's splitPrimaryModels matches:
  const primaryIds = [
    "kilo/kilo-auto/free",
    "kilo/kilo-auto/balanced",
    "kilo/kilo-auto/frontier",
    "kilo/kilo-auto/efficient",
    "kilo/kilo-auto/small",
  ];
  const allIds = new Set([
    ...available.map((m) => m.modelId),
    ...(modelOption?.options ?? []).map((o) => o.value),
  ]);
  console.log(`primary ids present in discovered catalog: ${primaryIds.filter((id) => allIds.has(id)).join(", ") || "(none)"}`);
} catch (error) {
  console.error("\nprobe FAILED:", error.message);
  if (stderrTail) console.log("stderr tail:\n" + stderrTail.slice(-3000));
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  setTimeout(() => process.exit(process.exitCode ?? 0), 1_500).unref();
}
