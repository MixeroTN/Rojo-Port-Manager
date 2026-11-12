import { execFile } from 'node:child_process';
import * as nodePath from 'node:path';
import { promisify } from 'node:util';
import { isRojoProcessName, parseLsof, parseNetstat, parseTasklist } from './processes.ts';

const execFileAsync = promisify(execFile);

/** Windows' own programs by full path: never a program of the same name in the current folder or on PATH. */
function windowsTool(name: string): string {
  return nodePath.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);
}

/** Runs a program without a shell; rejects with an error that carries the exit code in `code`. */
async function run(file: string, args: readonly string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout;
}

/** The processes listening on each local TCP port. */
export async function findListeners(): Promise<Map<number, number[]>> {
  if (process.platform === 'win32') {
    return parseNetstat(await run(windowsTool('netstat.exe'), ['-ano']));
  }

  return parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']));
}

/** The name of a running process, or undefined when no process has that id. */
export async function processName(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      return parseTasklist(await run(windowsTool('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']));
    }

    const name = (await run('ps', ['-p', String(pid), '-o', 'comm='])).trim();

    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

/** Whether a process id still belongs to Rojo (or its shim): an old id may belong to another program by now. */
export async function isRojoProcess(pid: number): Promise<boolean> {
  return isRojoProcessName(await processName(pid));
}

/**
 * Ends a process and the processes it started (a shim and its Rojo). Returns the error text, or undefined when it
 * worked or the process was already gone.
 */
export async function killTree(pid: number, group = false): Promise<string | undefined> {
  if (process.platform === 'win32') {
    try {
      await run(windowsTool('taskkill.exe'), ['/PID', String(pid), '/T', '/F']);

      return undefined;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);

      // taskkill exits with 128 when the process is gone already.
      return (error as { code?: unknown }).code === 128 ? undefined : text;
    }
  }

  try {
    // A server the panel started leads its own process group (it was spawned detached): end the whole group.
    process.kill(group ? -pid : pid, 'SIGTERM');

    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    return code === 'ESRCH' ? undefined : String(error);
  }
}
