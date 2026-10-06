import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAdapter } from "./helpers/driver";
import { writeFakeKilo } from "./helpers/fake-kilo";

let directory: string;
let kilo: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "kilocode-version-"));
  kilo = writeFakeKilo(directory);
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

const env = (overrides: Record<string, string> = {}) => ({
  KILO_ADAPTER_LOG: path.join(directory, "adapter.log"),
  ...overrides,
});

describe("--version", () => {
  it("reports the Kilo CLI's own version, so health shows what is installed", async () => {
    const result = await runAdapter(["--version"], env({ KILO_BIN: kilo }));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("7.8.3");
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("accepts the short form BB's probe may use", async () => {
    const result = await runAdapter(["-v"], env({ KILO_BIN: kilo }));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("7.8.3");
  });

  it("reports no version at all when the CLI is absent", async () => {
    const result = await runAdapter(
      ["--version"],
      env({ KILO_BIN: path.join(directory, "missing-kilo") }),
    );
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe("");
    // A health probe that scraped a number out of the error text would
    // advertise a version that is not installed.
    expect(result.stderr).not.toMatch(/\d+\.\d+\.\d+/u);
  });
});
