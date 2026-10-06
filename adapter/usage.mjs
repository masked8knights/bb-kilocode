// bb-kilocode — usage journal helpers.
//
// Pure functions the ACP adapter uses to turn one ACP `session/prompt` result
// into one `{"kind":"generation","fact":{...}}` line. Kept dependency-free and
// side-effect-free (except appendUsageLine) so the mapping is unit-testable
// without an agent in the loop.
//
// The line shape matches the generation-fact ledger other tools already read
// (`~/.fx/usage.jsonl` and the antigravity bridge log): consumers take
// `fact.created_at_ms`, `fact.provider`, `fact.model`, `fact.cwd`,
// `fact.input_tokens`, `fact.cache_read_tokens`, `fact.output_tokens` and
// `fact.total_cost`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Provider id this plugin registers with BB. */
export const PROVIDER_ID = "kilocode";

/** "kilo/kilo-auto/free" -> "kilo-auto/free"; anything else is kept as-is. */
export function stripProviderPrefix(model) {
  if (typeof model !== "string") return "unknown";
  const trimmed = model.trim();
  if (trimmed === "") return "unknown";
  return trimmed.startsWith("kilo/") ? trimmed.slice("kilo/".length) : trimmed;
}

const positive = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Map one ACP prompt result onto a generation fact.
 *
 * ACP reports `{inputTokens, outputTokens, totalTokens, thoughtTokens,
 * cachedReadTokens}`; `totalTokens` double-counts cached reads, so the buckets
 * are taken from their own fields. Thought tokens are output the user paid
 * for, so they land in `output_tokens`. `costDelta` is the session-cumulative
 * cost this turn added: it is only reported when positive, because a free tier
 * reports 0 and a missing number is more honest than an invented one.
 *
 * @param {object} [options]
 * @param {{inputTokens?: number, outputTokens?: number, totalTokens?: number, thoughtTokens?: number, cachedReadTokens?: number}} [options.usage]
 * @param {string} [options.model]
 * @param {string} [options.cwd]
 * @param {string} [options.sessionId]
 * @param {number} [options.costDelta]
 * @param {number} [options.now]
 */
export function buildUsageFact(options) {
  const { usage = {}, model, cwd, sessionId, costDelta, now = Date.now() } = options ?? {};
  const inputTokens = positive(usage.inputTokens);
  const cacheReadTokens = Math.min(inputTokens, positive(usage.cachedReadTokens));
  const outputTokens = positive(usage.outputTokens) + positive(usage.thoughtTokens);
  const fact = {
    provider: PROVIDER_ID,
    model: stripProviderPrefix(model),
    created_at_ms: typeof now === "number" && Number.isFinite(now) ? now : Date.now(),
    input_tokens: inputTokens,
    cache_read_tokens: cacheReadTokens,
    output_tokens: outputTokens,
    total_cost:
      typeof costDelta === "number" && Number.isFinite(costDelta) && costDelta > 0
        ? costDelta
        : null,
  };
  if (typeof cwd === "string" && cwd.trim() !== "") fact.cwd = cwd;
  if (typeof sessionId === "string" && sessionId.trim() !== "") fact.session_id = sessionId;
  return fact;
}

/** True when a prompt result carries a usage worth journaling. */
export function hasUsage(usage) {
  if (!usage || typeof usage !== "object") return false;
  return (
    positive(usage.inputTokens) +
      positive(usage.outputTokens) +
      positive(usage.thoughtTokens) +
      positive(usage.cachedReadTokens) >
    0
  );
}

/** One journal line, newline-terminated for append-friendly JSONL. */
export function usageLine(fact) {
  return `${JSON.stringify({ kind: "generation", fact })}\n`;
}

/**
 * Where the journal lives. `KILO_USAGE_FILE` overrides it (tests, operators
 * pointing the ledger elsewhere).
 */
export function defaultUsageFile(env = process.env, homedir = os.homedir()) {
  const override = typeof env.KILO_USAGE_FILE === "string" ? env.KILO_USAGE_FILE.trim() : "";
  if (override !== "") return override;
  return path.join(homedir, ".kilocode", "usage.jsonl");
}

/** Append one line, creating the journal's directory on first use. */
export function appendUsageLine(file, line) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(file, line, { mode: 0o600 });
}
