// bb-kilocode — BB provider plugin: run BB threads on Kilo Code.
//
// server.ts registers the `kilocode` provider and points BB's ACP bridge at
// adapter/acp.mjs — a line-transparent proxy in front of `kilo acp` (the Kilo
// CLI's stdio ACP server) that also journals one generation usage fact per
// settled turn. host.ts re-exports the bridge kit, so the bb.host artifact BB
// ships to hosts runs that generic ACP bridge.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Depending on how BB evaluates the bundle, HERE is either the plugin root
// (source server.ts) or <plugin root>/dist (built server.js).
const ADAPTER = [
  path.join(HERE, "adapter", "acp.mjs"),
  path.join(HERE, "..", "adapter", "acp.mjs"),
].find((candidate) => fs.existsSync(candidate));

// Kilo's own automatic router. The free entry is first (and therefore the
// default) because it is the only group that runs on a machine with no Kilo
// credentials; every other entry of the 300+ model catalog stays reachable
// through the picker's "more models" group.
const PRIMARY_MODELS = [
  "kilo/kilo-auto/free",
  "kilo/kilo-auto/balanced",
  "kilo/kilo-auto/frontier",
  "kilo/kilo-auto/efficient",
  "kilo/kilo-auto/small",
] as const;

const MEDIUM = {
  reasoningEffort: "medium" as const,
  description: "Provider default",
};

const fallbackModel = (
  id: string,
  displayName: string,
  description: string,
  isDefault = false,
) => ({
  id,
  displayName,
  description,
  supportedReasoningEfforts: [MEDIUM],
  defaultReasoningEffort: "medium" as const,
  isDefault,
});

// The adapter carries a `#!/usr/bin/env node` shebang. When BB can execute it
// directly it is the launch command, so `provider/health`'s `<command>
// --version` probe runs the adapter's `--version`, which forwards to `kilo
// --version` and reports Kilo Code's own version. On a checkout that lost the
// executable bit we fall back to `node <adapter>`, where the health probe then
// reports Node's version instead — see README ("Health").
function launchCommand(): { command: string; args: string[] } {
  if (ADAPTER === undefined) return { command: process.execPath, args: [] };
  try {
    fs.accessSync(ADAPTER, fs.constants.X_OK);
    return { command: ADAPTER, args: [] };
  } catch {
    return { command: process.execPath, args: [ADAPTER] };
  }
}

export default async function plugin(bb: BbPluginApi) {
  if (ADAPTER === undefined) {
    throw new Error(
      "bb-kilocode: adapter/acp.mjs is missing from this install; reinstall the plugin.",
    );
  }

  const launch = launchCommand();
  bb.log.info(`bb-kilocode loading — adapter ${ADAPTER}`);

  bb.providers.register({
    id: "kilocode",
    displayName: "Kilo Code",
    family: "acp",
    icon: "./assets/icon.svg",
    experimental_visibility: "always",
    maintenance: {
      health: true,
      usage: true,
      installation: false,
    },
    env: {
      passthrough: ["KILO_BIN"],
    },
    experimental_bridgeOptions: {
      acpDialect: "generic",
      primaryModels: [...PRIMARY_MODELS],
      acpLaunchSpec: {
        displayName: "Kilo Code",
        command: launch.command,
        args: launch.args,
        env: {},
      },
    },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      // `fork` is BB's edit gate: the server derives
      // `supportsSessionRewind = fork === "checkpoint"` from this
      // declaration alone, and `bb thread edit-message` 409s with "Editing
      // messages is not supported for kilocode" while it is anything else.
      //
      // "checkpoint" is honest for the edit BB can actually run here. Editing
      // the thread's *first* user message needs no provider checkpoint:
      // BB deletes the whole turn suffix and issues `thread.start` with
      // `fork: null`, which the ACP bridge answers with a brand-new kilo
      // session carrying only the replacement prompt — the history really is
      // rebuilt, not replayed.
      //
      // A later message cannot be the edit target, and BB says so rather
      // than half-doing it: this plugin publishes no `providerCheckpointId`
      // on `turn/completed`, so naming one with --expected-request-sequence
      // is refused with "This earlier provider turn has no editable history
      // checkpoint". With no sequence BB edits the latest *eligible*
      // message — its documented contract — which on a multi-turn thread is
      // the first one, and the turns after it go with it. Kilo's ACP layer
      // clones a session only at its tip (`session/fork` takes no head), so
      // there is no session state to rewind to the turn before an edit. The
      // bridge handshake keeps reporting `fork: "tip"`; we never claim a
      // rewind we cannot perform.
      fork: "checkpoint",
      // `/compact` reaches kilo as an ordinary prompt today: it does not
      // compact, so the affordance stays off.
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "full"],
      // One rung: kilo's ACP session exposes a single Effort value
      // ("thinking") and no per-level thought knob.
      reasoningLevels: ["medium"],
    },
    composerActions: [],
    completedTurnDisplay: "flat",
    strings: {
      signInHint: "Run `kilo auth login` on this machine to sign in, then reload.",
      expiredHint:
        "Kilo Code credentials on this machine expired. Run `kilo auth login`, then reload.",
      installUrl: "https://kilo.ai/cli/install",
    },
    models: {
      scope: "host",
      fallback: [
        fallbackModel(
          "kilo/kilo-auto/free",
          "Kilo Auto Free",
          "Kilo's automatic router on the free tier — runs without signing in.",
          true,
        ),
        fallbackModel(
          "kilo/kilo-auto/balanced",
          "Kilo Auto Balanced",
          "Automatic routing balanced across cost and capability.",
        ),
        fallbackModel(
          "kilo/kilo-auto/frontier",
          "Kilo Auto Frontier",
          "Automatic routing to Kilo's strongest available models.",
        ),
        fallbackModel(
          "kilo/kilo-auto/efficient",
          "Kilo Auto Efficient",
          "Automatic routing biased toward speed and low cost.",
        ),
        fallbackModel(
          "kilo/kilo-auto/small",
          "Kilo Auto Small",
          "Automatic routing to small, fast models.",
        ),
      ],
    },
  });
}
