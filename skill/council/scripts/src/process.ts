import { spawn, type ChildProcess } from "node:child_process";

export interface RunOptions {
  cwd: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export const DEFAULT_TIMEOUT_MS = 300_000;
const KILL_ESCALATION_MS = 2_000;

export function runProcess(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return runChild(command, args, false, options);
}

export function runShellCommand(command: string, options: RunOptions): Promise<RunResult> {
  return runChild(command, [], true, options);
}

function runChild(command: string, args: string[], shell: boolean, options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group (POSIX) so a timeout/abort can terminate the whole
      // tree, including shell grandchildren such as `npm test` workers.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killReason: "timeout" | "abort" | undefined;
    let escalation: NodeJS.Timeout | undefined;

    const signal = options.signal;

    const terminate = (reason: "timeout" | "abort"): void => {
      if (settled || killReason) return;
      killReason = reason;
      killTree(child, "SIGTERM");
      // Escalate to SIGKILL if the tree ignores SIGTERM. The promise settles
      // from the "close" handler once the group has actually exited, not here.
      escalation = setTimeout(() => killTree(child, "SIGKILL"), KILL_ESCALATION_MS);
      escalation.unref();
    };

    const onAbort = (): void => terminate("abort");
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) {
      if (signal.aborted) terminate("abort");
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (killReason === "timeout") {
        reject(new Error(`timed out after ${timeoutMs}ms`));
        return;
      }
      if (killReason === "abort") {
        reject(new Error("aborted"));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(failedProcessMessage(command, code, stdout, stderr)));
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && typeof child.pid === "number") {
      // Negative pid signals the entire process group led by the detached child.
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process (group) is already gone.
  }
}

function failedProcessMessage(command: string, code: number | null, stdout: string, stderr: string): string {
  const diagnostic = stderr.trim() || stdout.trim();
  return `${command} exited with code ${code}: ${diagnostic}`;
}
