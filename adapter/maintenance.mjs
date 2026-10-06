// bb-kilocode — bb's sessionless maintenance answers.
//
// The generic ACP dialect carries no maintenance hooks, so the published ACP
// bridge would answer `provider/usage` with `{supported:false}` and
// `provider/health` with the version of the *launch* command — the adapter,
// and plain `node` on a checkout that lost its executable bit. host.ts pulls
// those two requests off the wire and answers them from here instead:
// Kilo Code meters tokens rather than accounts, so usage reports no quota
// endpoint rather than an invented number, and health reports the resolved
// kilo binary's own version. Dependency-free and side-effect-free so the
// answers are unit-testable without a bridge in the loop.
import { resolveKiloBin } from "./kilo-bin.mjs";

/** Shown by bb wherever it labels a provider's plan. */
export const PLAN_LABEL = "Kilo Code";
/** What bb renders when a provider publishes no quota window. */
export const USAGE_MESSAGE = "Kilo Code does not expose account quota.";
export const NO_BIN_MESSAGE = "The Kilo Code CLI was not found on this machine.";

/** `provider/usage`: supported, but there is no quota to report. */
export function usageResult() {
  return {
    supported: true,
    usage: {
      status: "error",
      message: USAGE_MESSAGE,
      planLabel: PLAN_LABEL,
      accountEmail: null,
    },
  };
}

/**
 * `provider/health`, shaped for bb's health schema. `installation:false` in
 * the registration means this plugin ships no installer, so both install
 * affordances stay off whatever the machine looks like.
 */
export function healthResult(status, installedVersion, statusMessage) {
  return {
    supported: true,
    health: {
      status,
      statusMessage,
      accountEmail: null,
      planLabel: PLAN_LABEL,
      installedVersion,
      minimumSupportedVersion: null,
      canInstall: false,
      canUpdate: false,
      loginCommand: null,
    },
  };
}

/**
 * Health for one machine: where the CLI is (or that it is missing) and the
 * version it printed. `bin` comes from {@link resolveKiloBin}; `version` from
 * asking that binary `--version`.
 *
 * @param {string | null} bin
 * @param {string | null} version
 */
export function healthFor(bin, version) {
  if (bin === null) return healthResult("not_installed", null, NO_BIN_MESSAGE);
  if (version === null) {
    return healthResult(
      "ready",
      null,
      `Kilo Code CLI found at ${bin}; its version could not be read.`,
    );
  }
  return healthResult("ready", version, `Kilo Code CLI found at ${bin}.`);
}
