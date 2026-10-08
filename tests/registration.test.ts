import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { STATE_DIR_ENV, stateDirFrom } from "../adapter/checkpoint.mjs";
import plugin from "../server";

type Declaration = Record<string, any>;

const registrations: Declaration[] = [];
const logs: string[] = [];

const fakeBb = {
  log: {
    info: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    warn: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    debug: () => {},
  },
  providers: {
    register: (declaration: Declaration) => {
      registrations.push(declaration);
      return { dispose: () => {} };
    },
  },
} as unknown as Parameters<typeof plugin>[0];

async function registration(): Promise<Declaration> {
  registrations.length = 0;
  await plugin(fakeBb);
  expect(registrations).toHaveLength(1);
  return registrations[0];
}

describe("provider registration", () => {
  it("registers exactly one provider, id kilocode, shown as Kilo Code", async () => {
    const declaration = await registration();
    expect(declaration.id).toBe("kilocode");
    expect(declaration.displayName).toBe("Kilo Code");
    expect(declaration.id).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/u);
  });

  it("declares health and usage maintenance but no installer", async () => {
    const declaration = await registration();
    expect(declaration.maintenance).toEqual({
      health: true,
      usage: true,
      installation: false,
    });
  });

  it("passes KILO_BIN through to the bridge and nothing else", async () => {
    const declaration = await registration();
    expect(declaration.env).toEqual({ passthrough: ["KILO_BIN"] });
  });

  it("bridges over the generic ACP dialect through our adapter", async () => {
    const declaration = await registration();
    const options = declaration.experimental_bridgeOptions;
    expect(options.acpDialect).toBe("generic");
    expect(options.acpLaunchSpec.displayName).toBe("Kilo Code");
    expect(options.acpLaunchSpec.args).toEqual([]);
    // The launch command is either the executable adapter itself or the node
    // binary with the adapter as its argument.
    const command: string = options.acpLaunchSpec.command;
    const args: string[] = options.acpLaunchSpec.args;
    expect(command.length).toBeGreaterThan(0);
    expect(args.length === 0 || args[0].endsWith("adapter/acp.mjs")).toBe(true);
    expect(args.length === 0 || command === process.execPath).toBe(true);
    // The checkpoint registry directory travels in the launch env: the adapter
    // (which publishes counts) and host.ts (which resolves checkpoints) must
    // agree on it even when their processes inherit different TMPDIRs.
    expect(Object.keys(options.acpLaunchSpec.env ?? {})).toEqual([STATE_DIR_ENV]);
    expect(options.acpLaunchSpec.env[STATE_DIR_ENV]).toBe(stateDirFrom(process.env));
    expect(path.isAbsolute(options.acpLaunchSpec.env[STATE_DIR_ENV])).toBe(true);
  });

  it("offers kilo-auto/free as the default and keeps the rest of the router first", async () => {
    const declaration = await registration();
    const primary: string[] = declaration.experimental_bridgeOptions.primaryModels;
    expect(primary[0]).toBe("kilo/kilo-auto/free");
    expect(new Set(primary).size).toBe(primary.length);
    expect(primary.every((id) => id.startsWith("kilo/kilo-auto/"))).toBe(true);

    const fallback: any[] = declaration.models.fallback;
    expect(fallback.map((model) => model.id)).toEqual([...primary]);
    expect(fallback.filter((model) => model.isDefault)).toHaveLength(1);
    expect(fallback.find((model) => model.isDefault).id).toBe("kilo/kilo-auto/free");
    for (const model of fallback) {
      expect(model.displayName.length).toBeGreaterThan(0);
      expect(model.description.length).toBeGreaterThan(0);
      expect(model.supportedReasoningEfforts.length).toBeGreaterThan(0);
      expect(model.supportedReasoningEfforts.map((effort: any) => effort.reasoningEffort)).toContain(
        model.defaultReasoningEffort,
      );
    }
    expect(declaration.models.scope).toBe("host");
  });

  it("states only capabilities kilo actually implements", async () => {
    const declaration = await registration();
    expect(declaration.capabilities).toEqual({
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["medium"],
    });
    expect(declaration.composerActions).toEqual([]);
    expect(declaration.completedTurnDisplay).toBe("flat");
  });

  it("opens bb thread edit-message, whose gate is fork === checkpoint", async () => {
    const declaration = await registration();
    // The server derives supportsSessionRewind from this declaration alone;
    // at fork: "tip" the command fails with HTTP 409 "Editing messages is
    // not supported for kilocode".
    expect(declaration.capabilities.fork).toBe("checkpoint");
    // "checkpoint" is not aspirational: host.ts stamps a
    // providerCheckpointId (`<sessionId>#<userCount>`) onto every settled
    // turn boundary from the adapter's registry, and answers bb's rewind
    // prepare by staging a rebuild the adapter runs on the replacement
    // thread. So editing the first message (bb restarts the session, no
    // checkpoint needed) and editing any later one (rewind to the turn
    // before it, history retained) both work; only a count Kilo's store
    // never confirmed (`seeded:false`) falls back to bb's honest 409.
    expect(declaration.capabilities.fork !== "none").toBe(true);
  });

  it("never answers the ACP handshake itself, only its outgoing fork answer", async () => {
    // The `initialize` request still reaches the ACP kit — host.ts must not
    // grow a handler that answers it, or two answers would travel on one
    // stream. What host.ts does rewrite, on the way out, is the kit's
    // `capabilities.fork: "tip"` result: bb takes the minimum of this
    // declaration and the handshake, and prepareThreadRewind throws below
    // "checkpoint", so the upgrade is what opens the edit affordance this
    // test's sibling asserts.
    const host = fs.readFileSync(
      fileURLToPath(new URL("../host.ts", import.meta.url)),
      "utf8",
    );
    expect(host).not.toMatch(/["'`]initialize["'`]/u);
  });

  it("points sign-in, expiry and install copy at the kilo CLI", async () => {
    const declaration = await registration();
    expect(declaration.strings.signInHint).toContain("kilo auth login");
    expect(declaration.strings.expiredHint).toContain("kilo auth login");
    expect(declaration.strings.installUrl).toBe("https://kilo.ai/cli/install");
    expect(declaration.icon).toBe("./assets/icon.svg");
  });

  it("carries no branding from the project this plugin was forked from", async () => {
    const declaration = await registration();
    const serialized = JSON.stringify(declaration);
    expect(serialized.toLowerCase()).not.toContain(["open", "code"].join(""));
    expect(logs.join("\n").toLowerCase()).not.toContain(["open", "code"].join(""));
  });
});
