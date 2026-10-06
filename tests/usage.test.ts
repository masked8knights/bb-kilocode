import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROVIDER_ID,
  appendUsageLine,
  buildUsageFact,
  defaultUsageFile,
  hasUsage,
  stripProviderPrefix,
  usageLine,
} from "../adapter/usage.mjs";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "kilocode-usage-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("model ids", () => {
  it("drops the gateway prefix kilo puts on every model", () => {
    expect(stripProviderPrefix("kilo/kilo-auto/free")).toBe("kilo-auto/free");
    expect(stripProviderPrefix("kilo/anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
  });

  it("keeps ids that carry no prefix and refuses to invent one", () => {
    expect(stripProviderPrefix("kilo-auto/free")).toBe("kilo-auto/free");
    expect(stripProviderPrefix("  ")).toBe("unknown");
    expect(stripProviderPrefix(undefined)).toBe("unknown");
  });
});

describe("usage facts", () => {
  const usage = {
    inputTokens: 10_926,
    outputTokens: 6,
    totalTokens: 13_018,
    thoughtTokens: 38,
    cachedReadTokens: 2_048,
  };

  it("maps ACP token buckets onto the journal's fields", () => {
    const fact = buildUsageFact({
      usage,
      model: "kilo/kilo-auto/free",
      cwd: "/home/admin1/bb-kilocode",
      sessionId: "ses_1",
      costDelta: 0,
      now: 1_770_000_000_000,
    });
    expect(fact).toEqual({
      provider: PROVIDER_ID,
      model: "kilo-auto/free",
      created_at_ms: 1_770_000_000_000,
      input_tokens: 10_926,
      cache_read_tokens: 2_048,
      // thought tokens are output the user paid for
      output_tokens: 44,
      total_cost: null,
      cwd: "/home/admin1/bb-kilocode",
      session_id: "ses_1",
    });
  });

  it("records a cost only when the turn actually added one", () => {
    expect(buildUsageFact({ usage, costDelta: 0.5 }).total_cost).toBe(0.5);
    expect(buildUsageFact({ usage, costDelta: 0 }).total_cost).toBeNull();
    expect(buildUsageFact({ usage, costDelta: -1 }).total_cost).toBeNull();
    expect(buildUsageFact({ usage }).total_cost).toBeNull();
  });

  it("never reports more cached reads than input tokens", () => {
    const fact = buildUsageFact({ usage: { inputTokens: 10, cachedReadTokens: 99 } });
    expect(fact.cache_read_tokens).toBe(10);
    expect(fact.input_tokens).toBe(10);
  });

  it("treats totalTokens as unusable — it double-counts cached reads", () => {
    const fact = buildUsageFact({ usage: { inputTokens: 100, cachedReadTokens: 80, totalTokens: 999 } });
    expect(fact.input_tokens).toBe(100);
    expect(fact.cache_read_tokens).toBe(80);
  });

  it("recognizes a prompt result worth journaling", () => {
    expect(hasUsage(usage)).toBe(true);
    expect(hasUsage({ inputTokens: 0, outputTokens: 0 })).toBe(false);
    expect(hasUsage(undefined)).toBe(false);
    expect(hasUsage("usage")).toBe(false);
  });
});

describe("journal lines", () => {
  it("writes one generation fact per line", () => {
    const fact = buildUsageFact({ usage: { inputTokens: 5 }, model: "kilo/kilo-auto/free" });
    const line = usageLine(fact);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.kind).toBe("generation");
    expect(parsed.fact.provider).toBe("kilocode");
    expect(parsed.fact.model).toBe("kilo-auto/free");
  });

  it("appends, creating the journal directory on first use", () => {
    const file = path.join(directory, "nested", "usage.jsonl");
    appendUsageLine(file, usageLine(buildUsageFact({ usage: { inputTokens: 1 } })));
    appendUsageLine(file, usageLine(buildUsageFact({ usage: { inputTokens: 2 } })));
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((entry) => JSON.parse(entry).fact.input_tokens)).toEqual([1, 2]);
  });

  it("honors KILO_USAGE_FILE over ~/.kilocode/usage.jsonl", () => {
    expect(defaultUsageFile({}, "/home/admin1")).toBe(
      path.join("/home/admin1", ".kilocode", "usage.jsonl"),
    );
    expect(defaultUsageFile({ KILO_USAGE_FILE: "/tmp/elsewhere.jsonl" }, "/home/admin1")).toBe(
      "/tmp/elsewhere.jsonl",
    );
    expect(defaultUsageFile({ KILO_USAGE_FILE: "  " }, "/home/admin1")).toBe(
      path.join("/home/admin1", ".kilocode", "usage.jsonl"),
    );
  });
});
