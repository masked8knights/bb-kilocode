import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./helpers/driver";

// Assembled at runtime so this file itself does not contain the literal it
// searches for.
const NEEDLE = ["open", "code"].join("").toLowerCase();

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".vitest"]);
const SKIP_FILES = new Set(["package-lock.json", ".DS_Store"]);

function walk(root: string, base = root, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, base, found);
      continue;
    }
    if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
    found.push(path.relative(base, absolute));
  }
  return found;
}

describe("branding", () => {
  const files = walk(REPO_ROOT);

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("keeps no text in the repository from the project this was forked from", () => {
    const offenders: string[] = [];
    for (const relative of files) {
      if (relative.toLowerCase().includes(NEEDLE)) {
        offenders.push(`${relative} (path)`);
        continue;
      }
      const buffer = fs.readFileSync(path.join(REPO_ROOT, relative));
      if (buffer.includes(0)) continue; // binary (screenshots, images)
      const text = buffer.toString("utf8").toLowerCase();
      if (text.includes(NEEDLE)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it("names the forked-from project nowhere in the docs it ships", () => {
    for (const relative of ["README.md", "AGENTS.md", "package.json", "server.ts", "host.ts"]) {
      const text = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8").toLowerCase();
      expect(text).not.toContain(NEEDLE);
    }
  });
});
