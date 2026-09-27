import { spawn } from "node:child_process";

/**
 * Run a shell command on Sid's PC: PowerShell on Windows (his machine), /bin/sh
 * elsewhere (tests, and any non-Windows host). Output is captured with caps
 * (a limit, not judgment — truncation is reported in the result), and a timeout
 * kills the process. The result is facts only; nothing is claimed beyond it.
 */

export const SHELL_OUTPUT_CAP = 100_000;
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface ShellResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  command: string;
  program: string;
}

export function shellProgram(platform: NodeJS.Platform = process.platform): { program: string; args: (cmd: string) => string[] } {
  if (platform === "win32") {
    return { program: "powershell.exe", args: (cmd) => ["-NoProfile", "-NonInteractive", "-Command", cmd] };
  }
  return { program: "/bin/sh", args: (cmd) => ["-c", cmd] };
}

export function runShellCommand(command: string, opts: { timeoutMs?: number; platform?: NodeJS.Platform; spawnImpl?: typeof spawn } = {}): Promise<ShellResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { program, args } = shellProgram(opts.platform);
  const spawnFn = opts.spawnImpl ?? spawn;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawnFn(program, args(command), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, exitCode: null, stdout, stderr: `spawn failed: ${(e as Error).message}`, timedOut: false, truncated: false, command, program });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const cap = (chunk: string): string => {
      if (chunk.length > SHELL_OUTPUT_CAP) {
        truncated = true;
        return chunk.slice(0, SHELL_OUTPUT_CAP);
      }
      return chunk;
    };
    child.stdout?.on("data", (d: Buffer) => {
      stdout += cap(d.toString());
      if (stdout.length > SHELL_OUTPUT_CAP) {
        truncated = true;
        stdout = stdout.slice(0, SHELL_OUTPUT_CAP);
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += cap(d.toString());
      if (stderr.length > SHELL_OUTPUT_CAP) {
        truncated = true;
        stderr = stderr.slice(0, SHELL_OUTPUT_CAP);
      }
    });
    child.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stdout, stderr: `${stderr}\n${e.message}`.trim(), timedOut, truncated, command, program });
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, exitCode: code, stdout, stderr, timedOut, truncated, command, program });
    });
  });
}
