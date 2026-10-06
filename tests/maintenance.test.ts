import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  providerHealthResultSchema,
  providerUsageResultSchema,
} from "@get-bb/plugin-sdk/provider-bridge";

import { resolveKiloBin } from "../adapter/kilo-bin.mjs";
import {
  NO_BIN_MESSAGE,
  PLAN_LABEL,
  USAGE_MESSAGE,
  healthFor,
  healthResult,
  usageResult,
} from "../adapter/maintenance.mjs";

describe("provider/usage", () => {
  it("answers supported with an explicit no-quota error bb can render", () => {
    const result = usageResult();
    expect(providerUsageResultSchema.parse(result)).toBeTruthy();
    expect(result.supported).toBe(true);
    expect(result.usage.status).toBe("error");
    expect(result.usage.message).toBe("Kilo Code does not expose account quota.");
    expect(result.usage.planLabel).toBe(PLAN_LABEL);
    expect(result.usage.accountEmail).toBeNull();
  });

  it("states the message once, in Kilo Code's own words", () => {
    expect(USAGE_MESSAGE).toBe("Kilo Code does not expose account quota.");
    expect(USAGE_MESSAGE.toLowerCase()).not.toContain("quota endpoint for");
  });
});

describe("provider/health", () => {
  it("reports the kilo binary's version, not the launcher's", () => {
    const result = healthFor("/home/you/.kilo/bin/kilo", "7.8.3");
    expect(providerHealthResultSchema.parse(result)).toBeTruthy();
    expect(result.health.status).toBe("ready");
    expect(result.health.installedVersion).toBe("7.8.3");
    expect(result.health.statusMessage).toContain("/home/you/.kilo/bin/kilo");
    expect(result.health.canInstall).toBe(false);
    expect(result.health.canUpdate).toBe(false);
    expect(result.health.loginCommand).toBeNull();
  });

  it("says not_installed when no kilo exists, and invents no version", () => {
    const result = healthFor(null, null);
    expect(providerHealthResultSchema.parse(result)).toBeTruthy();
    expect(result.health.status).toBe("not_installed");
    expect(result.health.installedVersion).toBeNull();
    expect(result.health.statusMessage).toBe(NO_BIN_MESSAGE);
    // the probe reads `--version` output for a semver: an error message that
    // happens to contain one would advertise a version that is not installed
    expect(result.health.statusMessage).not.toMatch(/\d+\.\d+\.\d+/u);
  });

  it("stays honest when the binary exists but would not answer", () => {
    const result = healthFor("/home/you/.kilo/bin/kilo", null);
    expect(providerHealthResultSchema.parse(result)).toBeTruthy();
    expect(result.health.status).toBe("ready");
    expect(result.health.installedVersion).toBeNull();
    expect(result.health.statusMessage).toContain("version could not be read");
  });

  it("carries no branding from the project this plugin was forked from", () => {
    const serialized = JSON.stringify([usageResult(), healthFor(null, null)]).toLowerCase();
    expect(serialized).not.toContain(["open", "code"].join(""));
    expect(PLAN_LABEL).toBe("Kilo Code");
    expect(healthResult("unknown", null, "boom").health.status).toBe("unknown");
  });
});

describe("resolveKiloBin", () => {
  let directory: string;
  let homedir: string;
  let installed: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "kilocode-bin-"));
    homedir = path.join(directory, "home");
    installed = path.join(homedir, ".kilo", "bin", "kilo");
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.chmodSync(installed, 0o755);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: "",
    XDG_DATA_HOME: path.join(directory, "no-xdg-here"),
    ...extra,
  });

  it("honors KILO_BIN exactly: a wrong path fails loudly instead of falling back", () => {
    // A kilo is installed in the home directory, and the override still wins.
    expect(resolveKiloBin(cleanEnv(), homedir)).toBe(installed);
    expect(resolveKiloBin(cleanEnv({ KILO_BIN: path.join(directory, "wrong") }), homedir)).toBe(
      null,
    );
  });

  it("accepts an executable KILO_BIN", () => {
    expect(resolveKiloBin(cleanEnv({ KILO_BIN: installed }), homedir)).toBe(installed);
  });

  it("finds the installed CLI in the kilo home directory", () => {
    expect(resolveKiloBin(cleanEnv(), homedir)).toBe(installed);
  });

  it("falls back to PATH when the home directory has none", () => {
    const empty = path.join(directory, "empty-home");
    const binDir = path.join(directory, "bin");
    const onPath = path.join(binDir, "kilo");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(onPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.chmodSync(onPath, 0o755);
    expect(resolveKiloBin(cleanEnv({ PATH: binDir }), empty)).toBe(onPath);
  });

  it("returns null when this machine has no kilo at all", () => {
    expect(resolveKiloBin(cleanEnv(), path.join(directory, "nope"))).toBe(null);
  });
});
