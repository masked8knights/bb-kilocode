// Drives `kilo acp` by hand to see whether a session/prompt over ACP hangs
// without bb anywhere in the loop.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const child = spawn("C:/Users/MiddleGamingPC/.kilo/bin/kilo.exe", ["acp","--attach","http://127.0.0.1:4599"], {
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const lines = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) {
      lines.push(line);
      console.log("OUT", line.slice(0, 300));
    }
  }
});
child.stderr.on("data", (d) => {process.stderr.write(d)});

let seq = 0;
function send(method, params) {
  const id = ++seq;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return id;
}

send("initialize", { protocolVersion: 1, clientCapabilities: {} });
await delay(8000);
const init = JSON.parse(lines.find((l) => l.includes('"id":1')) || "{}");
const agentCaps = init?.result?.agentCapabilities ?? {};
console.log("agentCaps", JSON.stringify(agentCaps).slice(0, 400));

send("session/new", {
  cwd: "C:/Users/MiddleGamingPC/Documents/bb-smoke-kilocode",
  mcpServers: [],
});
await delay(15000);
const sesLine = lines.find((l) => l.includes('"id":2'));
console.log("session/new ->", (sesLine || "NONE").slice(0, 200));
const sessionId = JSON.parse(sesLine || "{}")?.result?.sessionId;
if (!sessionId) {
  child.kill();
  process.exit(1);
}

send("session/set_config_option", {
  sessionId,
  configId: "model",
  value: "kilo/kilo-auto/balanced",
});
await delay(3000);
console.log("set model ->", (lines.find((l) => l.includes('"id":3')) || "NONE").slice(0, 200));

send("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: "Reply with exactly: OK" }],
});
for (let t = 0; t < 8; t++) {
  await delay(15000);
  const done = lines.find((l) => l.includes(`"id":${seq}`) && (l.includes('"result"') || l.includes('"error"')));
  console.log(`t=${(t + 1) * 15}s lines=${lines.length} promptDone=${done ? done.slice(0, 200) : "no"}`);
  if (done) break;
}
child.kill();
process.exit(0);
