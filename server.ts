// bb-kilocode — BB provider plugin: run BB threads on Kilo Code.
//
// server.ts registers the `kilocode` provider and points BB's ACP bridge at
// adapter/acp.mjs — a line-transparent proxy in front of `kilo acp` (the Kilo
// CLI's stdio ACP server) that also publishes the checkpoint state bb's
// edit-message/rewind/fork flow reads (adapter/checkpoint.mjs). host.ts
// re-exports the bridge kit plus those two interceptions, so the bb.host
// artifact BB ships to hosts runs the generic ACP bridge with them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { STATE_DIR_ENV } from "./adapter/checkpoint.mjs";

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
        env: {
          // Shared checkpoint registry between the adapter (publishes live
          // session records, rebuilds truncated sessions in session/fork) and
          // host.ts (stamps providerCheckpointIds onto turn boundaries,
          // stages checkpoint forks). The bridge passes launchSpec.env to
          // the adapter child; host.ts reads the same value back from any
          // request that carries the launch spec. Both sides fall back to
          // the same default when the variable is absent.
          [STATE_DIR_ENV]: process.env[STATE_DIR_ENV] || path.join(os.tmpdir(), "bb-kilo-state"),
        },
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
      // "checkpoint" is what actually runs here: every settled turn's
      // boundary carries a `providerCheckpointId` (`<sessionId>#<userCount>`,
      // counted from Kilo Code's own store — adapter/acp.mjs), so bb rewinds
      // to the turn before an edited message by forking from that
      // checkpoint. The clone is rebuilt by the adapter from `kilo export`,
      // truncated to the checkpoint's count, re-id'd, `kilo import`ed, and
      // `session/load`ed — history is retained rather than replayed blind.
      // That covers `bb thread edit-message` on any message (the first one
      // needs no checkpoint at all: bb restarts the session from scratch),
      // `bb thread rewind`, and `bb thread fork` from a checkpoint.
      //
      // When the registry cannot confirm a count (`seeded:false`, e.g. no
      // Kilo store readable), no checkpoint is published and bb answers its
      // honest 409 instead of cutting a history against a guess.
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
