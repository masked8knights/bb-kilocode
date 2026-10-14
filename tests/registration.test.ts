import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import plugin from "../server";

type Declaration = Record<string, any>;

const registrations: Declaration[] = [];
const logs: string[] = [];

const fakeSettings = {
  kiloBin: "",
  model: "",
};

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
  settings: {
    define: () => ({
      get: async () => fakeSettings,
      onChange: () => {},
    }),
  },
  hosts: {
    experimental_client: () => ({ call: async () => ({ ok: true }) }),
  },
  storage: {
    kv: {
      get: async () => false as unknown,
      set: async () => {},
      delete: async () => {},
    },
  },
  background: { service: () => {} },
  status: { needsConfiguration: () => {} },
  rpc: { register: () => {} },
  cli: { register: () => {} },
  agents: { configure: () => {} },
  sdk: {
    hosts: { list: async () => [] },
    subscribe: () => () => {},
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

  it("passes KILO_BIN through and nothing else", async () => {
    const declaration = await registration();
    expect(declaration.env).toEqual({ passthrough: ["KILO_BIN"] });
  });

  it("has no generic-dialect bridge options — the plugin host carries the bridge", async () => {
    const declaration = await registration();
    expect(declaration.experimental_bridgeOptions).toBeUndefined();
  });

  it("offers kilo-auto/free as the default fallback and keeps the router first", async () => {
    const declaration = await registration();
    const fallback: any[] = declaration.models.fallback;
    const ids: string[] = fallback.map((model) => model.id);
    expect(ids[0]).toBe("kilo/kilo-auto/free");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("kilo/kilo-auto/"))).toBe(true);
    expect(fallback.filter((model) => model.isDefault)).toHaveLength(1);
    expect(fallback.find((model) => model.isDefault).id).toBe("kilo/kilo-auto/free");
    for (const model of fallback) {
      expect(model.displayName.length).toBeGreaterThan(0);
      expect(model.description.length).toBeGreaterThan(0);
      expect(model.supportedReasoningEfforts.map((effort: any) => effort.reasoningEffort)).toContain(
        model.defaultReasoningEffort,
      );
    }
    expect(declaration.models.scope).toBe("host");
  });

  it("states only capabilities the kilo-run bridge implements", async () => {
    const declaration = await registration();
    expect(declaration.capabilities).toEqual({
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    });
    expect(declaration.composerActions).toEqual([]);
    expect(declaration.completedTurnDisplay).toBe("flat");
  });

  it("drives turns through `kilo run --format json`, not the broken `kilo acp`", () => {
    const host = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "host.ts"),
      "utf8",
    );
    expect(host).toContain('["run", prompt, "--format", "json"]');
    expect(host).toContain("--session");
    expect(host).not.toContain("acpLaunchSpec");
    expect(host).toContain("experimental_defineProviderBridge");
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
