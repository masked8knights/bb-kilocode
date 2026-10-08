import fs from "node:fs";
import path from "node:path";

/**
 * A stand-in for the kilo CLI: answers `--version`, and otherwise speaks just
 * enough ACP over stdio for the adapter's proxy path to be exercised end to
 * end — initialize, session/new, model selection, prompts with usage, and
 * `usage_update` notifications carrying a session-cumulative cost.
 *
 * Returns the absolute path of an executable fixture.
 */
export function writeFakeKilo(directory: string): string {
  const file = path.join(directory, "fake-kilo.mjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

if (process.argv[2] === "--version") {
  process.stdout.write("7.8.3\\n");
  process.exit(0);
}

// \`kilo export <id>\`: a four-message, two-turn transcript. Truncating to
// turn 1 must keep the first user+assistant pair and drop the second.
const HERE = import.meta.dirname;
const exportFixture = {
  info: {
    id: "ses_source",
    slug: "fixture-session",
    projectID: "global",
    directory: "/nonexistent/source-ws",
    path: "nonexistent/source-ws",
    title: "fixture",
  },
  messages: [
    {
      info: { id: "msg_u1", sessionID: "ses_source", role: "user", time: { created: 1 } },
      parts: [{ type: "text", text: "first instruction", id: "prt_u1", sessionID: "ses_source", messageID: "msg_u1" }],
    },
    {
      info: { id: "msg_a1", sessionID: "ses_source", parentID: "msg_u1", role: "assistant", time: { created: 2 } },
      parts: [{ type: "text", text: "first reply", id: "prt_a1", sessionID: "ses_source", messageID: "msg_a1" }],
    },
    {
      info: { id: "msg_u2", sessionID: "ses_source", parentID: "msg_a1", role: "user", time: { created: 3 } },
      parts: [{ type: "text", text: "second instruction", id: "prt_u2", sessionID: "ses_source", messageID: "msg_u2" }],
    },
    {
      info: { id: "msg_a2", sessionID: "ses_source", parentID: "msg_u2", role: "assistant", time: { created: 4 } },
      parts: [{ type: "text", text: "second reply", id: "prt_a2", sessionID: "ses_source", messageID: "msg_a2" }],
    },
  ],
};
if (process.argv[2] === "export") {
  // Only the fixture session can be exported — anything else is a real
  // "unknown session" failure, the way kilo answers an id it has no record of.
  if (process.argv[3] !== "ses_source") {
    process.stderr.write("No session found for id " + process.argv[3] + "\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(exportFixture) + "\\n");
  process.exit(0);
}

// \`kilo import <file>\`: journal what arrived (payload + the cwd the session
// directory must come from) so tests can assert truncation and id rewrites.
if (process.argv[2] === "import") {
  const payload = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  fs.writeFileSync(
    path.join(HERE, "imported.json"),
    JSON.stringify({ cwd: process.cwd(), data: payload }),
  );
  process.stdout.write("Imported session " + payload.info.id + "\\n");
  process.exit(0);
}

const modelOptions = [
  { value: "kilo/kilo-auto/free", name: "Kilo Gateway/Kilo: Auto Free" },
  { value: "kilo/anthropic/claude-opus-5", name: "Kilo Gateway/Anthropic: Opus 5" },
];

const modelBySession = new Map();
const costBySession = new Map();
const promptsBySession = new Map();
let sessionCount = 0;

const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const notify = (method, params) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");

const modelOption = (value) => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: value,
  options: modelOptions,
});

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: 1,
        agentInfo: { name: "Kilo", version: "7.8.3" },
        agentCapabilities: { sessionCapabilities: { fork: {}, close: {} } },
      });
      return;
    case "session/new": {
      sessionCount += 1;
      const sessionId = "ses_" + sessionCount;
      modelBySession.set(sessionId, "kilo/google/gemini-3-pro-image");
      costBySession.set(sessionId, 0);
      reply(id, { sessionId, configOptions: [modelOption(modelBySession.get(sessionId))] });
      return;
    }
    case "session/load": {
      // Restoring an existing session: enough for the adapter's seeding path.
      // The params are journalled so a test can see which id the adapter
      // injected into us — the answer itself never reaches the bridge.
      fs.writeFileSync(path.join(HERE, "load-params.json"), JSON.stringify(params ?? {}));
      reply(id, {});
      return;
    }
    case "session/fork": {
      sessionCount += 1;
      const sessionId = "ses_fork_" + sessionCount;
      modelBySession.set(sessionId, "kilo/kilo-auto/free");
      costBySession.set(sessionId, 0);
      reply(id, { sessionId, configOptions: [modelOption(modelBySession.get(sessionId))] });
      return;
    }
    case "session/set_config_option": {
      if (params.configId === "model") modelBySession.set(params.sessionId, params.value);
      reply(id, { configOptions: [modelOption(modelBySession.get(params.sessionId))] });
      return;
    }
    case "session/prompt": {
      const sessionId = params.sessionId;
      const seen = (promptsBySession.get(sessionId) ?? 0) + 1;
      promptsBySession.set(sessionId, seen);
      // The first turn bills 0.50 and every later turn bills the same running
      // total, so a caller can see both a positive cost delta and a flat one.
      const cost = seen === 1 ? 0.5 : costBySession.get(sessionId) ?? 0;
      costBySession.set(sessionId, cost);
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 13043,
          size: 256000,
          cost: { amount: cost, currency: "USD" },
        },
      });
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "PONG" },
        },
      });
      reply(id, {
        stopReason: "end_turn",
        usage: {
          inputTokens: 1200,
          outputTokens: 40,
          totalTokens: 1648,
          thoughtTokens: 8,
          cachedReadTokens: 400,
        },
      });
      return;
    }
    case "session/close":
      reply(id, {});
      return;
    default:
      if (id !== undefined) reply(id, {});
  }
}
`,
    { mode: 0o755 },
  );
  fs.chmodSync(file, 0o755);
  return file;
}
