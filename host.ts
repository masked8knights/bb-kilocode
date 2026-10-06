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
// with the resolved kilo binary's own version (adapter/maintenance.mjs);
// every other line reaches the ACP bridge unchanged.
import {
  createBridgeIo,
  experimental_defineProviderBridge,
  experimental_readCliVersion,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

import { healthFor, healthResult, usageResult } from "./adapter/maintenance.mjs";
import { resolveKiloBin } from "./adapter/kilo-bin.mjs";

// stdout is the bridge's JSON-RPC channel — the same writer the ACP bridge
// uses, so both answers travel on one stream.
const { sendResult } = createBridgeIo();

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

interface BridgeRequest {
  id: string | number;
  method: string;
}

// The bridge is a JSON-RPC line protocol: only the two requests we answer
// ourselves are pulled out; anything unparseable is handed on untouched.
function parseBridgeRequest(line: string): BridgeRequest | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: { id?: unknown; method?: unknown };
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const id = parsed?.id;
  if (typeof parsed?.method !== "string") return null;
  if (typeof id !== "string" && typeof id !== "number") return null;
  return { id, method: parsed.method };
}

const bridge = experimental_defineProviderBridge({
  handleLine: (line) => {
    const request = parseBridgeRequest(line);
    if (request !== null) {
      if (request.method === "provider/usage") {
        sendResult(request.id, usageResult());
        return;
      }
      if (request.method === "provider/health") {
        void answerHealth(request.id);
        return;
      }
    }
    experimental_acpProviderBridge.handleLine(line);
  },
  onClose: () => experimental_acpProviderBridge.onClose?.(),
  onSigterm: () => experimental_acpProviderBridge.onSigterm?.(),
  onSigint: () => experimental_acpProviderBridge.onSigint?.(),
});

export { bridge as experimental_providerBridge };
