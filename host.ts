/**
 * bb.host artifact for the Kilo Code provider.
 *
 * Kilo's `kilo acp` stdio server is broken upstream — `session/prompt` never
 * returns for any model (Kilo-Org/kilocode#10768, reproduced on 7.8.8/7.8.9:
 * the embedded ai-sdk runtime stalls after "llm runtime selected" and no
 * result or session/update ever arrives). `kilo run` goes through a different
 * code path and answers reliably, so this bridge drives the provider through
 * `kilo run <prompt> -m <model> --format json [--session <id>]` and keeps
 * conversation continuity via the sessionID kilo mints itself (persisted to
 * disk, so a bridge recycle still resumes instead of starting fresh).
 *
 * Model catalog comes from `kilo models kilo --verbose`: the id lines plus a
 * pretty name, reasoning `variants` (passed to run as `--variant`), and the
 * free/default markers.
 */
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  type PromptInput,
  type ThreadDelta,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  runBridgeRequest,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { kilocodeHostContract } from "./contract.js";

const configDir = join(tmpdir(), "bb-plugin-kilocode");
const configPath = join(configDir, "config.json");
const sessionsPath = join(configDir, "sessions.json");

function writeConfig(input: object): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  writeFileSync(configPath, JSON.stringify(input), { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);
}

export default experimental_defineHostEntry({
  contract: kilocodeHostContract,
  handlers: {
    setConfig: (input) => {
      writeConfig(input);
      return { ok: true as const };
    },
  },
});

interface KiloConfig {
  kiloBin: string;
  model: string;
}

function loadConfig(): KiloConfig {
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, "utf8")) as KiloConfig;
    } catch {
      // fall through to defaults
    }
  }
  return { kiloBin: "kilo", model: "" };
}

type Effort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

interface KiloModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: { reasoningEffort: Effort; description: string }[];
  defaultReasoningEffort: Effort;
  isDefault: boolean;
}

const VARIANTS: readonly Effort[] = ["none", "low", "medium", "high", "xhigh", "max"];

function runJson(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`kilo ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`kilo ${args.join(" ")} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Model catalog: `kilo models kilo --verbose` alternates a `kilo/<id>` header
// line with that model's JSON metadata (name, options.description, variants,
// release_date, isFree).
// ---------------------------------------------------------------------------

let modelCache: { at: number; models: KiloModel[] } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60_000;
const variantByModel = new Map<string, Set<Effort>>();

async function fetchKiloModels(config: KiloConfig): Promise<KiloModel[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_TTL_MS) return modelCache.models;
  try {
    const stdout = await runJson(config.kiloBin, ["models", "kilo", "--verbose"], 90_000);
    const models: KiloModel[] = [];
    let pendingId: string | null = null;
    let jsonBuf = "";
    for (const raw of stdout.split("\n")) {
      const line = raw.trimEnd();
      if (line.startsWith("kilo/")) {
        pendingId = line.slice("kilo/".length);
        jsonBuf = "";
        continue;
      }
      if (pendingId === null) continue;
      jsonBuf += line + "\n";
      if (line !== "}") continue;
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(jsonBuf) as Record<string, unknown>;
      } catch {
        pendingId = null;
        continue;
      }
      const id = `kilo/${pendingId}`;
      const variants = Object.keys((meta.variants ?? {}) as Record<string, unknown>).filter(
        (v): v is Effort => (VARIANTS as readonly string[]).includes(v),
      );
      if (variants.length > 0) variantByModel.set(id, new Set(variants));
      const efforts = variants.map((v) => ({
        reasoningEffort: v,
        description: v === "none" ? "No reasoning" : v === "medium" ? "Standard" : v,
      }));
      const description = (meta.options as { description?: string } | undefined)?.description;
      models.push({
        id,
        model: id,
        displayName: typeof meta.name === "string" ? meta.name : id,
        description: (description ?? `Kilo Code model ${id}`).slice(0, 300),
        supportedReasoningEfforts: efforts.length > 0 ? efforts : [{ reasoningEffort: "medium", description: "Standard" }],
        defaultReasoningEffort:
          variants.find((v) => v === "medium") ?? variants[0] ?? ("medium" as Effort),
        isDefault: id === "kilo/kilo-auto/free" || id === config.model,
      });
      pendingId = null;
    }
    if (models.length === 0) return modelCache?.models ?? [];
    if (!models.some((m) => m.isDefault)) {
      const autoFree = models.find((m) => m.id.startsWith("kilo/kilo-auto"));
      (autoFree ?? models[0])!.isDefault = true;
    }
    modelCache = { at: Date.now(), models };
    return models;
  } catch {
    return modelCache?.models ?? [];
  }
}

// ---------------------------------------------------------------------------
// Sessions: bb threadId -> kilo sessionID, persisted so a bridge restart can
// still resume with `--session`.
// ---------------------------------------------------------------------------

interface SessionRecord {
  providerThreadId: string;
  kiloSessionId?: string;
}

let sessionStore = new Map<string, SessionRecord>();
try {
  if (existsSync(sessionsPath)) {
    sessionStore = new Map(
      Object.entries(JSON.parse(readFileSync(sessionsPath, "utf8")) as Record<string, SessionRecord>),
    );
  }
} catch {
  sessionStore = new Map();
}

function saveSessions(): void {
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(sessionsPath, JSON.stringify(Object.fromEntries(sessionStore)), { mode: 0o600 });
  } catch {
    // best effort — continuity is nicer-if-persisted, not required
  }
}

const instanceNonce = randomUUID().replaceAll("-", "").slice(0, 12);
let threadCounter = 0;
const sessions = new Map<string, { providerThreadId: string; model: string; reasoningLevel?: string }>();
const activeChildren = new Map<string, ReturnType<typeof spawn>>();

type JsonRpcId = string | number;
type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;
const io = createBridgeIo<OutboundMessage>();

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}
function emitDeltas(threadId: string, deltas: ThreadDelta[]): void {
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

function promptText(input: readonly PromptInput[]): string {
  return input
    .filter((item): item is Extract<PromptInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Usage: one JSONL line per settled turn, FX-shaped (`kind:"generation"` +
// `fact`) like the other provider bridges, so the usage dashboard collector
// can read `~/.kilo-acp/usage.jsonl`. `kilo run --format json`'s step_finish
// carries tokens/cost for the step.
// ---------------------------------------------------------------------------

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "/root";
}
const usageLogPath = join(homeDir(), ".kilo-acp", "usage.jsonl");

function appendUsageLog(
  model: string,
  part: { tokens?: Record<string, unknown>; cost?: number; model?: { modelID?: string } },
): void {
  const tokens = part.tokens;
  if (!tokens) return;
  try {
    mkdirSync(join(homeDir(), ".kilo-acp"), { recursive: true });
    const cache = tokens.cache as { read?: number; write?: number } | undefined;
    const fact = {
      created_at_ms: Date.now(),
      provider: "kilo",
      model: part.model?.modelID ?? model,
      input_tokens: tokens.input ?? 0,
      output_tokens: tokens.output ?? 0,
      thinking_tokens: tokens.reasoning ?? 0,
      cache_read_tokens: cache?.read ?? 0,
      total_cost: part.cost ?? null,
    };
    appendFileSync(usageLogPath, `${JSON.stringify({ kind: "generation", fact })}\n`);
  } catch {
    // never let usage logging fail a turn
  }
}

interface RunOutcome {
  text: string;
  sessionId: string | null;
  error: string | null;
}

function runKiloTurn(
  threadId: string,
  config: KiloConfig,
  model: string,
  reasoningLevel: string | undefined,
  prompt: string,
  onText: (text: string) => void,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const record = sessionStore.get(threadId);
    const args = ["run", prompt, "--format", "json"];
    if (model) args.push("-m", model);
    if (reasoningLevel && reasoningLevel !== "medium") {
      const variants = variantByModel.get(model);
      if (variants !== undefined && variants.has(reasoningLevel as Effort)) {
        args.push("--variant", reasoningLevel);
      }
    }
    if (record?.kiloSessionId) args.push("--session", record.kiloSessionId);
    const child = spawn(config.kiloBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
      windowsHide: true,
    });
    activeChildren.set(threadId, child);
    let outcome: RunOutcome = { text: "", sessionId: record?.kiloSessionId ?? null, error: null };
    let sawText = false;
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const part = event.part as
          | {
              type?: string;
              text?: string;
              sessionID?: string;
              tokens?: Record<string, unknown>;
              cost?: number;
              model?: { modelID?: string };
            }
          | undefined;
        if (typeof event.sessionID === "string" && event.sessionID !== outcome.sessionId) {
          outcome.sessionId = event.sessionID;
          const rec = sessionStore.get(threadId) ?? {
            providerThreadId: `kilo_${instanceNonce}_orphan`,
          };
          rec.kiloSessionId = event.sessionID;
          sessionStore.set(threadId, rec);
          saveSessions();
        }
        if (event.type === "text" && typeof part?.text === "string" && part.text.length > 0) {
          sawText = true;
          outcome.text += part.text;
          onText(part.text);
        }
        if (event.type === "step_finish" && part) {
          appendUsageLog(model, part);
        }
        if (event.type === "error") {
          const errObj = (event.error ?? event) as { message?: string };
          outcome.error = errObj.message ?? JSON.stringify(event).slice(0, 400);
        }
      }
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      activeChildren.delete(threadId);
      resolve({ ...outcome, error: err.message });
    });
    child.on("close", (code) => {
      activeChildren.delete(threadId);
      if (outcome.error === null && code !== 0 && !sawText) {
        outcome = { ...outcome, error: `kilo run exited ${code}: ${stderr.slice(0, 500)}` };
      }
      resolve(outcome);
    });
  });
}

async function runTurn(args: {
  threadId: string;
  providerThreadId: string;
  model: string;
  reasoningLevel?: string;
  input: readonly PromptInput[];
  clientRequestId?: string;
}): Promise<void> {
  const config = loadConfig();
  const itemId = `kilo_${args.providerThreadId}_${randomUUID()}`;
  const deltas: ThreadDelta[] = [];
  if (args.clientRequestId !== undefined) {
    deltas.push({ kind: "input.accepted", clientRequestId: args.clientRequestId });
  }
  deltas.push({ kind: "turn.open" });
  deltas.push({
    kind: "item.open",
    key: { providerItemId: itemId },
    item: { type: "agentMessage", text: "" },
  });
  emitDeltas(args.threadId, deltas);

  const onText = (text: string): void => {
    emitDeltas(args.threadId, [
      {
        kind: "item.textDelta",
        key: { providerItemId: itemId },
        channel: "agentMessage",
        text,
      },
    ]);
  };

  const result = await runKiloTurn(
    args.threadId,
    config,
    args.model,
    args.reasoningLevel,
    promptText(args.input),
    onText,
  );

  emitDeltas(args.threadId, [
    {
      kind: "item.textClose",
      key: { providerItemId: itemId },
      channel: "agentMessage",
      text: result.text,
    },
    {
      kind: "turn.boundary",
      status: result.error !== null && result.text === "" ? "failed" : "completed",
      ...(result.error !== null && result.text === "" ? { error: { message: result.error } } : {}),
    },
  ]);
}

type RequestHandler = (id: JsonRpcId, params: unknown) => void;

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  const data =
    typeof issues === "object" && issues !== null
      ? ({ recovery: undefined, ...(issues as Record<string, unknown>) } as never)
      : undefined;
  io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `Invalid params for ${method}`, data);
}

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        // bb requires >=2 advertised grammar versions; the bridge only implements v3.
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: false,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "runtime",
        steerMode: "queue",
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    const config = loadConfig();
    void fetchKiloModels(config).then((models) => {
      io.sendResult(id, { models, selectedOnlyModels: [] });
    });
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
      return;
    }
    threadCounter += 1;
    const providerThreadId = `kilo_${instanceNonce}_${threadCounter}`;
    const config = loadConfig();
    const model = parsed.data.options?.model || config.model || "kilo/kilo-auto/free";
    const reasoningLevel = parsed.data.options?.reasoningLevel;
    sessions.set(parsed.data.threadId, { providerThreadId, model, reasoningLevel });
    const record = sessionStore.get(parsed.data.threadId);
    if (record === undefined) {
      sessionStore.set(parsed.data.threadId, { providerThreadId });
      saveSessions();
    } else {
      record.providerThreadId = providerThreadId;
      saveSessions();
    }
    notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId: parsed.data.threadId,
      providerThreadId,
    });
    emitDeltas(parsed.data.threadId, [{ kind: "session.reset" }]);
    io.sendResult(id, { providerThreadId, sessionRestorable: false });
    if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
      void runTurn({
        threadId: parsed.data.threadId,
        providerThreadId,
        model,
        reasoningLevel,
        input: parsed.data.input,
      });
    }
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
      return;
    }
    const config = loadConfig();
    const model = parsed.data.options?.model || config.model || "kilo/kilo-auto/free";
    const reasoningLevel = parsed.data.options?.reasoningLevel;
    sessions.set(parsed.data.threadId, {
      providerThreadId: parsed.data.providerThreadId,
      model,
      reasoningLevel,
    });
    const record = sessionStore.get(parsed.data.threadId);
    if (record === undefined) {
      sessionStore.set(parsed.data.threadId, { providerThreadId: parsed.data.providerThreadId });
      saveSessions();
    }
    notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId: parsed.data.threadId,
      providerThreadId: parsed.data.providerThreadId,
    });
    emitDeltas(parsed.data.threadId, [{ kind: "session.reset" }]);
    io.sendResult(id, { providerThreadId: parsed.data.providerThreadId, sessionRestorable: false });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `No session for thread ${parsed.data.threadId}; send thread/start or thread/resume first`,
      );
      return;
    }
    io.sendResult(id, {});
    const config = loadConfig();
    const model = parsed.data.options?.model || session.model || config.model || "kilo/kilo-auto/free";
    const reasoningLevel = parsed.data.options?.reasoningLevel || session.reasoningLevel;
    void runTurn({
      threadId: parsed.data.threadId,
      providerThreadId: session.providerThreadId,
      model,
      reasoningLevel,
      input: parsed.data.input,
      clientRequestId: parsed.data.clientRequestId,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
      `No active turn to steer (expected ${parsed.data.expectedTurnId})`,
    );
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    activeChildren.get(parsed.data.threadId)?.kill();
    activeChildren.delete(parsed.data.threadId);
    sessions.delete(parsed.data.threadId);
    io.sendResult(id, {});
  },
};

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return;
  }
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof method !== "string") return;
  if (typeof id !== "string" && typeof id !== "number") return;
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    return;
  }
  void runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (request) => handler(request.id, request.params),
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
});
