// bb-kilocode — locating the Kilo Code CLI.
//
// One resolution order, shared by the adapter that spawns `kilo acp` and by
// host.ts's health probe: an explicit `KILO_BIN` is honored exactly (a wrong
// path must fail loudly instead of silently running a different kilo), then
// the CLI's install directory, the XDG data directory, and finally PATH.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of the kilo CLI, or null when this machine has none.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [homedir]
 * @returns {string | null}
 */
export function resolveKiloBin(env = process.env, homedir = os.homedir()) {
  const override = (env.KILO_BIN || "").trim();
  // An explicit override is honored exactly: a wrong path must fail loudly
  // instead of silently running a different kilo than the operator named.
  if (override !== "") return isExecutable(override) ? override : null;
  const dataHome = (env.XDG_DATA_HOME || "").trim() || path.join(homedir, ".local", "share");
  const candidates = [
    path.join(homedir, ".kilo", "bin", "kilo"),
    path.join(dataHome, "kilo", "bin", "kilo"),
  ];
  for (const candidate of candidates) if (isExecutable(candidate)) return candidate;
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, "kilo");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}
