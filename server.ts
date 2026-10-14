// bb-kilocode — BB provider plugin: run BB threads on Kilo Code.
//
// server.ts registers the `kilocode` provider; host.ts is a self-contained
// provider bridge that drives `kilo run --format json` per turn (Kilo's own
// `kilo acp` stdio server never answers session/prompt — kilocode#10768) and
// builds the live model catalog from `kilo models kilo --verbose`. The server
// resolves the kilo binary and pushes it to the host through the contract in
// contract.ts.
import os from "node:os";
import path from "node:path";

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { kilocodeHostContract } from "./contract.js";
import { resolveKiloBin } from "./adapter/kilo-bin.mjs";

const PROVIDER_ID = "kilocode";
const OPTED_OUT_KEY = "optedOut";

const PRIMARY_MODELS = [
  "kilo/kilo-auto/free",
  "kilo/kilo-auto/balanced",
  "kilo/kilo-auto/frontier",
  "kilo/kilo-auto/efficient",
  "kilo/kilo-auto/small",
];

const MEDIUM = { reasoningEffort: "medium" as const, description: "Provider default" };

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

const statusSchema = z.object({
  providerId: z.string(),
  enabled: z.boolean(),
  kilo: z
    .object({
      path: z.string(),
      version: z.string().optional(),
      modelCount: z.number().optional(),
      error: z.string().optional(),
    })
    .optional(),
  kiloMissing: z.boolean(),
});

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
});

async function kiloVersion(bin: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)(bin, ["--version"], {
      timeout: 15_000,
      windowsHide: true,
    });
    return stdout.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    kiloBin: {
      type: "string",
      label: "kilo binary path",
      default: "",
      description: "Absolute path to the kilo CLI. Empty auto-detects (~/.kilo/bin, XDG data dir, PATH).",
    },
    model: {
      type: "string",
      label: "Default model id (blank = kilo/kilo-auto/free)",
      default: "",
    },
  });

  const hostClient = bb.hosts.experimental_client({ contract: kilocodeHostContract });

  async function pushConfigToHost(hostId: string, signal: AbortSignal): Promise<void> {
    const current = await settings.get();
    const kiloBin =
      current.kiloBin.trim() !== ""
        ? current.kiloBin.trim()
        : (resolveKiloBin(process.env, os.homedir()) ?? "kilo");
    try {
      await hostClient.call(
        "setConfig",
        { kiloBin, model: current.model.trim() || PRIMARY_MODELS[0]! },
        { hostId, signal },
      );
    } catch {
      // A disconnect can race the connected-host snapshot; the reconciler
      // retries on the next request or host:changed event.
    }
  }

  let requestConfigReconcile = () => {};
  settings.onChange(() => {
    requestConfigReconcile();
  });

  bb.background.service("host-config-reconciler", {
    async start(signal) {
      let reconcileRequested = true;
      let wake: (() => void) | null = null;
      requestConfigReconcile = () => {
        reconcileRequested = true;
        wake?.();
      };
      const unsubscribeHost = bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (event.changes.includes("host-connected")) requestConfigReconcile();
        },
      });
      try {
        while (!signal.aborted) {
          if (reconcileRequested) {
            reconcileRequested = false;
            const hosts = await bb.sdk.hosts.list({ signal });
            await Promise.all(
              hosts
                .filter((host) => host.status === "connected")
                .map((host) => pushConfigToHost(host.id, signal)),
            );
          }
          if (signal.aborted) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          wake = null;
        }
      } finally {
        requestConfigReconcile = () => {};
        unsubscribeHost();
      }
    },
  });

  let registration: { dispose(): void } | null = null;

  function registerProvider(): void {
    if (registration) return;
    registration = bb.providers.register({
      id: PROVIDER_ID,
      displayName: "Kilo Code",
      icon: "./assets/icon.svg",
      experimental_visibility: "always",
      maintenance: { health: true, usage: true, installation: false },
      env: { passthrough: ["KILO_BIN"] },
      models: {
        scope: "host",
        fallback: [
          fallbackModel(
            "kilo/kilo-auto/free",
            "Kilo Auto Free",
            "Kilo's automatic router on the free tier — runs without credits.",
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
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        // `kilo run` has no session fork/checkpoint story; history continuity
        // comes from `--session`, edit/rewind stays off.
        fork: "none",
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        permissionModes: ["full"],
        reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
      },
      composerActions: [],
      completedTurnDisplay: "flat",
      strings: {
        signInHint: "Run `kilo auth login` on this machine to sign in, then reload.",
        expiredHint:
          "Kilo Code credentials on this machine expired. Run `kilo auth login`, then reload.",
        installUrl: "https://kilo.ai/cli/install",
      },
    });
  }

  function unregisterProvider(): void {
    registration?.dispose();
    registration = null;
  }

  if (await bb.storage.kv.get<boolean>(OPTED_OUT_KEY)) {
    bb.log.info("provider registration skipped — disabled on purpose");
  } else {
    registerProvider();
  }

  const kiloPath = resolveKiloBin(process.env, os.homedir());
  if (kiloPath === null) {
    bb.status.needsConfiguration(
      "Missing the kilo CLI. Install it with `curl -fsSL https://kilo.ai/cli/install | bash`, sign in with `kilo auth login`, then reload.",
    );
  }

  bb.rpc.register(rpcContract, {
    status: async () => {
      if (kiloPath === null) {
        return { providerId: PROVIDER_ID, enabled: registration !== null, kiloMissing: true };
      }
      const version = await kiloVersion(kiloPath);
      return {
        providerId: PROVIDER_ID,
        enabled: registration !== null,
        kiloMissing: false,
        kilo: { path: kiloPath, version: version ?? undefined, ...(version === null ? { error: "version probe failed" } : {}) },
      };
    },
  });

  bb.cli.register({
    name: "kilocode",
    summary: "Inspect the Kilo Code provider",
    commands: [
      { name: "status", summary: "Show whether the kilo CLI and provider are wired up", usage: "bb kilocode status [--json]" },
      { name: "enable", summary: "Register the Kilo Code provider", usage: "bb kilocode enable" },
      { name: "disable", summary: "Unregister the Kilo Code provider", usage: "bb kilocode disable" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const positional = argv.filter((arg) => !arg.startsWith("-"));
      const subcommand = positional[0] ?? "status";
      try {
        if (subcommand === "enable") {
          await bb.storage.kv.delete(OPTED_OUT_KEY);
          registerProvider();
          return ok("Kilo Code provider registered.\n");
        }
        if (subcommand === "disable") {
          await bb.storage.kv.set(OPTED_OUT_KEY, true);
          unregisterProvider();
          return ok("Kilo Code provider unregistered.\n");
        }
        if (subcommand !== "status") {
          return { exitCode: 2, stderr: `Unknown subcommand "${subcommand}". Usage: bb kilocode <status|enable|disable> [--json]\n` };
        }
        const status = kiloPath
          ? {
              providerId: PROVIDER_ID,
              enabled: registration !== null,
              kiloMissing: false,
              kilo: { path: kiloPath, version: (await kiloVersion(kiloPath)) ?? undefined },
            }
          : { providerId: PROVIDER_ID, enabled: registration !== null, kiloMissing: true };
        if (json) return ok(JSON.stringify(status, null, 2) + "\n");
        const lines = [
          `Provider   ${status.providerId}  ${status.enabled ? "registered" : "not registered"}`,
          status.kiloMissing
            ? "kilo       MISSING — curl -fsSL https://kilo.ai/cli/install | bash"
            : `kilo       ${status.kilo?.path}${status.kilo?.version ? ` (${status.kilo.version})` : ""}`,
        ];
        return ok(lines.join("\n") + "\n");
      } catch (error) {
        return { exitCode: 1, stderr: `${(error as Error).message}\n` };
      }
    },
  });

  bb.agents.configure((context) => {
    if (context.provider.id !== PROVIDER_ID) {
      return { tools: [], skills: [] };
    }
    return {
      tools: [],
      skills: [],
      instructions:
        "You are running through Kilo Code's `kilo run` CLI. Each turn is one non-interactive " +
        "kilo run call continuing the same kilo session (--session); tool activity and reasoning " +
        "stay inside Kilo Code, and only the assistant's final text reaches this turn. Finish the " +
        "user's whole task within one reply: kilo run ends the turn when its process exits, so do " +
        "not stop while something is still running.\n",
    };
  });

  bb.log.info(`ready (kilo: ${kiloPath ?? "missing"})`);
}

function ok(stdout: string): { exitCode: number; stdout: string } {
  return { exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` };
}
