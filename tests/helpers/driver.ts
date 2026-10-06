import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const ADAPTER = path.join(REPO_ROOT, "adapter", "acp.mjs");

export interface FakeKiloEnv {
  KILO_BIN: string;
  KILO_USAGE_FILE: string;
  KILO_ADAPTER_LOG?: string;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Drives the adapter exactly the way BB's ACP bridge does: NDJSON over stdio. */
export class AcpDriver {
  readonly child: ReturnType<typeof spawn>;
  readonly notifications: any[] = [];
  readonly stdoutLines: string[] = [];
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly exit: Promise<{ code: number | null; stderr: string }>;
  private stderr = "";
  private readonly waiters: Array<{
    match: (value: any) => boolean;
    resolve: (value: any) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(env: FakeKiloEnv) {
    this.child = spawn(process.execPath, [ADAPTER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.child.stdout?.on("data", (chunk) => this.onStdout(chunk.toString("utf8")));
    this.child.stderr?.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.exit = new Promise((resolve) => {
      this.child.on("exit", (code) => resolve({ code, stderr: this.stderr }));
    });
  }

  private onStdout(text: string) {
    this.buffer += text;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim() === "") continue;
      this.stdoutLines.push(line);
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
      if (message.method !== undefined) {
        this.notifications.push(message);
        for (const waiter of [...this.waiters]) {
          if (waiter.match(message)) {
            clearTimeout(waiter.timer);
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.resolve(message);
          }
        }
      }
    }
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(`${line}\n`);
    });
  }

  waitForNotification(
    predicate: (message: any) => boolean,
    timeoutMs = 15_000,
  ): Promise<any> {
    const existing = this.notifications.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for notification"));
      }, timeoutMs);
      this.waiters.push({ match: predicate, resolve, timer });
    });
  }

  /** Close stdin (as BB does when it is done) and wait for the adapter to exit. */
  async shutdown(timeoutMs = 15_000): Promise<{ code: number | null; stderr: string }> {
    try {
      this.child.stdin!.end();
    } catch {}
    const timer = setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    const result = await this.exit;
    clearTimeout(timer);
    return result;
  }

  kill() {
    try {
      this.child.kill("SIGKILL");
    } catch {}
  }
}

/** Run the adapter as a one-shot command (its `--version` path, error paths). */
export function runAdapter(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ADAPTER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("adapter run timed out"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
