function addListener(listeners: Map<number, number[]>, port: number, pid: number): void {
  const pids = listeners.get(port) ?? [];

  if (!pids.includes(pid)) {
    pids.push(pid);
  }

  listeners.set(port, pids);
}

/**
 * The processes listening on each TCP port, from the output of `netstat -ano` (Windows). A listening socket is the
 * row whose remote address is `0.0.0.0:0` or `[::]:0`: the state column ("LISTENING") is translated on some systems.
 * A port can have several listeners (IPv4 and IPv6, 127.0.0.1 and 0.0.0.0).
 */
export function parseNetstat(output: string): Map<number, number[]> {
  const listeners = new Map<number, number[]>();

  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || columns[0]?.toUpperCase() !== 'TCP') {
      continue;
    }

    const local = columns[1] ?? '';
    const remote = columns[2] ?? '';
    const pid = Number(columns[columns.length - 1]);
    const port = Number(local.slice(local.lastIndexOf(':') + 1));

    if (/:0$/.test(remote) && Number.isInteger(pid) && pid > 0 && Number.isInteger(port) && port > 0) {
      addListener(listeners, port, pid);
    }
  }

  return listeners;
}

/**
 * The processes listening on each TCP port, from `lsof -nP -iTCP -sTCP:LISTEN -Fpn` (macOS, Linux): a `p<pid>` line
 * starts each process, and its `n<address>:<port>` lines follow.
 */
export function parseLsof(output: string): Map<number, number[]> {
  const listeners = new Map<number, number[]>();
  let pid: number | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      const value = Number(line.slice(1));
      pid = Number.isInteger(value) && value > 0 ? value : undefined;
    } else if (line.startsWith('n') && pid !== undefined) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1));

      if (Number.isInteger(port) && port > 0) {
        addListener(listeners, port, pid);
      }
    }
  }

  return listeners;
}

/**
 * The image name of a process from `tasklist /FI "PID eq <pid>" /FO CSV /NH` (Windows): the first field of its CSV
 * row; undefined when no process has that id (tasklist then prints a translated "INFO:" line).
 */
export function parseTasklist(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^"([^"]*)"/.exec(line.trim());
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

/** Whether a process name (an image name, a command or its path) is Rojo's. */
export function isRojoProcessName(name: string | undefined): boolean {
  if (!name) {
    return false;
  }

  const base = name.trim().split(/[\\/]/).pop() ?? '';

  return /^rojo(\.exe)?$/i.test(base);
}
