// The bb.host artifact BB ships to hosts.
//
// It runs the published ACP bridge kit (which launches adapter/acp.mjs, the
// command named in the provider registration, and speaks ACP over its stdio)
// plus bb's sessionless maintenance probes. The generic ACP dialect carries
// no maintenance hooks, so on its own it would answer `provider/usage` with
// `{supported:false}` and `provider/health` with the version of the *launch*
// command — the adapter here, and plain `node` on a checkout that lost its
// executable bit. Kilo Code publishes no quota API (this plugin makes no
// outbound requests), so usage is answered with an explicit error and health
// with the resolved kilo binary's own version (adapter/maintenance.mjs).
//
// On top of that passthrough, host.ts does two interceptions that make
// checkpoint rewind (`bb thread edit-message`) and checkpoint fork work —
// the registry contract lives in adapter/checkpoint.mjs:
//
//  1. OUTGOING (patched `process.stdout.write`, string chunks, single-line
//     JSON): the bundled ACP bridge hardcodes its initialize handshake to
//     `capabilities.fork: "tip"`, while our registration says `checkpoint`,
//     and bb takes the effective value as the MINIMUM of the two — so without
//     the patch bb refuses checkpoint rewind before it ever reaches us. We
//     rewrite `"tip"` → `"checkpoint"` in the handshake result, and stamp
//     `providerCheckpointId` onto outgoing `thread/delta` `turn.boundary`
//     deltas that lack one, from the adapter's on-disk state registry
//     (`<bbThreadId>.json` → `<sessionId>#<userCount>`). Without a non-null
//     checkpoint on the completed turn preceding an edited message, bb
//     answers `409: This earlier provider turn has no editable history
//     checkpoint` — which stays the honest answer while the adapter's count
//     is `seeded:false`.
//
//  2. INCOMING (interceptIncoming): bb's rewind "prepare" sends `thread/fork`
//     with `sourceProviderCheckpointId` and a staging thread id containing
//     `:rewind:`. The bridge would reject that (-32003), and even if it
//     didn't, it would start a staging session we'd then have to leak-free.
//     We resolve the checkpoint against the registry, mint a staged record,
//     and answer the prepare DIRECTLY with `{providerThreadId: stagedId}` —
//     no bridge session. The real work happens later when bb starts the
//     replacement thread with `sourceProviderThreadId = stagedId` (a plain
//     tip fork): an adapter consumes the staged record via `session/fork`
//     (kilo export → truncate to the checkpoint's count → rewrite ids →
//     kilo import → session/load). Anchored forks with a checkpoint
//     (threadId without `:rewind:`) are rewritten the same way and forwarded
//     so the bridge starts that replacement session itself. `thread/discard`
//     for an unconsumed staged id is cleaned up here, then forwarded so the
//     bridge still answers `{ok:true}`.
import { randomUUID } from "node:crypto";

import {
  createBridgeIo,
  experimental_defineProviderBridge,
  experimental_readCliVersion,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

import {
  parseCheckpoint,
  readState,
  removeState,
  rewriteOutgoingLine,
  stateDirFrom,
  writeState,
} from "./adapter/checkpoint.mjs";
import { resolveKiloBin } from "./adapter/kilo-bin.mjs";
import { healthFor, healthResult, usageResult } from "./adapter/maintenance.mjs";

// stdout is the bridge's JSON-RPC channel — the same writer the ACP bridge
// uses, so answers and rewrites travel on one stream.
const { sendResult, sendError } = createBridgeIo();

// Ask the resolved binary itself, so the version bb shows is Kilo Code's —
// not Node's, which is what a `node <adapter>` launch would report.
async function answerHealth(id: string | number) {
  try {
    const bin = resolveKiloBin();
    const version = bin === null ? null : await experimental_readCliVersion(bin);
    sendResult(id, healthFor(bin, version));
  } catch (error) {
    // Probing must never break the bridge: report it as health, not silence.
    sendResult(
      id,
      healthResult("unknown", null, error instanceof Error ? error.message : String(error)),
    );
  }
}

// ---------------------------------------------------------------------------
// shared state registry (mirror of adapter/acp.mjs): one JSON file per id
// under BB_KILO_STATE_DIR. The adapter learns the dir from its launch env
// (server.ts pins it into acpLaunchSpec.env); the host process does not
// inherit that, so we learn it from any request that carries the launch spec,
// falling back to the same default both sides agree on.
// ---------------------------------------------------------------------------
const STATE_DIR_ENV = "BB_KILO_STATE_DIR";

let stateDirOverride: string | null = null;
const stateDir = (): string => stateDirOverride ?? stateDirFrom(process.env);

// Pull BB_KILO_STATE_DIR out of `options.providerOptions.acpLaunchSpec.env`
// whenever a request carries the launch spec (thread/start, thread/fork,
// model/list, …). Runs before any interception that reads the registry.
const learnStateDir = (parsed: any): void => {
  if (stateDirOverride !== null) return;
  const env =
    parsed?.params?.options?.providerOptions?.acpLaunchSpec?.env ??
    parsed?.params?.providerOptions?.acpLaunchSpec?.env;
  const dir = env?.[STATE_DIR_ENV];
  if (typeof dir === "string" && dir.length > 0 && dir.startsWith("/")) {
    stateDirOverride = dir;
  }
};

// ---------------------------------------------------------------------------
// outgoing rewrites — see the header comment. Only single-line JSON strings
// are ever rewritten; Buffers and anything unparseable pass through as-is.
// Installed at module load: the ACP bridge resolves process.stdout.write at
// call time, so wrapping it here intercepts every line the bridge emits.
// ---------------------------------------------------------------------------
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: any, ...rest: any[]) => {
  if (typeof chunk === "string") {
    const rewritten = rewriteOutgoingLine(chunk, stateDir());
    if (rewritten !== null) return originalStdoutWrite(rewritten, ...(rest as any[]));
  }
  return originalStdoutWrite(chunk, ...(rest as any[]));
}) as typeof process.stdout.write;

// ---------------------------------------------------------------------------
// incoming interception — thread/fork at a checkpoint and staged cleanup.
// Returns true when the line was fully handled here (never forwarded).
// ---------------------------------------------------------------------------
const interceptIncoming = (parsed: any): boolean => {
  if (
    typeof parsed?.method !== "string" ||
    (typeof parsed?.id !== "string" && typeof parsed?.id !== "number")
  ) {
    return false;
  }

  if (parsed.method === "thread/fork" && typeof parsed?.params?.sourceProviderCheckpointId === "string") {
    const checkpoint = parseCheckpoint(parsed.params.sourceProviderCheckpointId);
    const source =
      checkpoint !== null ? readState(stateDir(), checkpoint.sourceSessionId) : null;

    if (
      checkpoint === null ||
      source === null ||
      source.kind !== "live" ||
      typeof source.sessionId !== "string"
    ) {
      // The checkpoint is well-formed but its registry record is gone (state
      // dir cleared, or the id predates this registry). Fail with the same
      // code the bridge would have answered, but say what actually happened
      // instead of blaming fork support.
      sendError(
        parsed.id,
        -32003, // FORK_CHECKPOINT_UNSUPPORTED — bb surfaces this to the edit command
        `The Kilo Code session registry has no record of checkpoint "${parsed.params.sourceProviderCheckpointId}"; its conversation cannot be recovered, so this rewind cannot run.`,
      );
      return true;
    }

    const stagedId = `kilo-staged-${randomUUID()}`;
    const staged = writeState(stateDir(), stagedId, {
      kind: "staged",
      sessionId: stagedId,
      sourceSessionId: checkpoint.sourceSessionId,
      truncateTo: checkpoint.userCount,
      requestThreadId: typeof parsed.params.threadId === "string" ? parsed.params.threadId : null,
      createdAt: Date.now(),
    });

    if (staged) {
      const isRewindPrepare =
        typeof parsed.params.threadId === "string" && parsed.params.threadId.includes(":rewind:");
      if (isRewindPrepare) {
        // prepareThreadRewind only stores providerThreadId and hands it back
        // later as forkSourceProviderThreadId; answering here means no
        // staging session is ever started. The staged record is consumed
        // (and deleted) by session/fork when bb starts the replacement
        // thread, or cleaned up by thread/discard if the edit is abandoned.
        sendResult(parsed.id, { providerThreadId: stagedId });
        return true;
      }
      // Anchored fork at a checkpoint: drop the checkpoint the bridge would
      // reject and point it at the staged record; the bridge then starts a
      // fresh session whose session/fork consumes the record.
      const forwarded = {
        ...parsed,
        params: { ...parsed.params, sourceProviderThreadId: stagedId },
      };
      delete forwarded.params.sourceProviderCheckpointId;
      experimental_acpProviderBridge.handleLine(JSON.stringify(forwarded));
      return true;
    }
    // Staging write failed (disk/permissions) → fall through and forward
    // unchanged, so the bridge answers FORK_CHECKPOINT_UNSUPPORTED instead
    // of pretending the fork happened.
  }

  if (parsed.method === "thread/discard" && typeof parsed?.params?.providerThreadId === "string") {
    const record = readState(stateDir(), parsed.params.providerThreadId);
    if (record !== null && record.kind === "staged") {
      // Unconsumed staged rewind/fork (edit abandoned or already consumed) —
      // drop it, then forward: the bridge answers {ok:true} as bb expects.
      removeState(stateDir(), parsed.params.providerThreadId);
    }
  }

  return false;
};

// The bridge is a JSON-RPC line protocol: any parseable line is learned from
// (launch-spec env), and a line with an id and a method is a request we may
// answer or intercept ourselves; anything unparseable is handed on untouched.
function parseLine(line: string): any | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

const bridge = experimental_defineProviderBridge({
  handleLine: (line) => {
    const parsed = parseLine(line);
    if (parsed !== null) {
      learnStateDir(parsed);
      const id = parsed.id;
      if (typeof parsed.method === "string" && (typeof id === "string" || typeof id === "number")) {
        if (parsed.method === "provider/usage") {
          sendResult(id, usageResult());
          return;
        }
        if (parsed.method === "provider/health") {
          void answerHealth(id);
          return;
        }
        if (interceptIncoming(parsed)) return;
      }
    }
    experimental_acpProviderBridge.handleLine(line);
  },
  onClose: () => experimental_acpProviderBridge.onClose?.(),
  onSigterm: () => experimental_acpProviderBridge.onSigterm?.(),
  onSigint: () => experimental_acpProviderBridge.onSigint?.(),
});

export { bridge as experimental_providerBridge };
