import * as nodePath from 'node:path';

/** A server the panel started (in any VS Code window). */
export interface ServerRecord {
  port: number;
  /** Absolute path of the project file. */
  project: string;
  /** The project name the server reports (the project's `name`, or its folder's name). */
  projectName?: string;
  /** The Rojo process the panel started. */
  pid: number;
  /** ISO time of the start. */
  startedAt: string;
  /** Absolute path of the server's log file. */
  log: string;
  /** The session the server reported once it answered: tells it apart from a later server on the same port. */
  sessionId?: string;
}

/**
 * What every VS Code window shares, in one JSON file in the extension's global storage: the port of each project file
 * (as the user chose it or the panel picked it), the ports project files ask for, and the servers the panel started.
 */
export interface SharedState {
  version: 1;
  /** Port by absolute project file path: chosen by the user or picked by the panel. */
  ports: Record<string, number>;
  /**
   * The `servePort` of the project files some window has seen, by path: other windows keep these ports for them too.
   */
  known: Record<string, number>;
  /** Servers by port. */
  servers: Record<string, ServerRecord>;
}

export function emptyState(): SharedState {
  return { version: 1, ports: {}, known: {}, servers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function readServer(value: unknown, port: number): ServerRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { project, projectName, pid, startedAt, log, sessionId } = value;

  if (
    typeof project !== 'string' ||
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof startedAt !== 'string' ||
    typeof log !== 'string'
  ) {
    return undefined;
  }

  return {
    port,
    project,
    projectName: typeof projectName === 'string' ? projectName : undefined,
    pid,
    startedAt,
    log,
    sessionId: typeof sessionId === 'string' ? sessionId : undefined,
  };
}

function readPorts(value: unknown, into: Record<string, number>): void {
  if (isRecord(value)) {
    for (const [path, port] of Object.entries(value)) {
      if (isPort(port)) {
        into[path] = port;
      }
    }
  }
}

/** Reads the shared state file; broken or missing parts are left out. */
export function parseState(text: string): SharedState {
  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch {
    return emptyState();
  }

  const state = emptyState();
  if (!isRecord(data)) {
    return state;
  }

  readPorts(data.ports, state.ports);
  readPorts(data.known, state.known);

  if (isRecord(data.servers)) {
    for (const [key, value] of Object.entries(data.servers)) {
      const port = Number(key);
      const server = isPort(port) ? readServer(value, port) : undefined;

      if (server) {
        state.servers[String(port)] = server;
      }
    }
  }

  return state;
}

export function serializeState(state: SharedState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** The form of a path to compare by: resolved, and case-insensitive on Windows and macOS (as their disks usually are). */
export function pathKey(path: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return nodePath.win32.resolve(path).toLowerCase();
  }

  const resolved = nodePath.posix.resolve(path);

  return platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

export function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return pathKey(left, platform) === pathKey(right, platform);
}

function portOf(map: Record<string, number>, project: string, platform: NodeJS.Platform): number | undefined {
  const key = pathKey(project, platform);

  for (const [path, port] of Object.entries(map)) {
    if (pathKey(path, platform) === key) {
      return port;
    }
  }

  return undefined;
}

/** Sets (or with undefined removes) the port of a project file in a map; returns whether the map changed. */
function setPortOf(
  map: Record<string, number>,
  project: string,
  port: number | undefined,
  platform: NodeJS.Platform,
): boolean {
  const key = pathKey(project, platform);
  let changed = false;

  for (const [path, existing] of Object.entries(map)) {
    if (pathKey(path, platform) === key && !(path === project && existing === port)) {
      delete map[path];
      changed = true;
    }
  }

  if (port !== undefined && map[project] !== port) {
    map[project] = port;
    changed = true;
  }

  return changed;
}

/** The saved port of a project file. */
export function savedPort(state: SharedState, project: string, platform: NodeJS.Platform): number | undefined {
  return portOf(state.ports, project, platform);
}

/** Saves (or with undefined forgets) the port of a project file; returns whether the state changed. */
export function setSavedPort(
  state: SharedState,
  project: string,
  port: number | undefined,
  platform: NodeJS.Platform,
): boolean {
  return setPortOf(state.ports, project, port, platform);
}

/** Records (or with undefined forgets) the `servePort` of a project file; returns whether the state changed. */
export function setKnownPort(
  state: SharedState,
  project: string,
  port: number | undefined,
  platform: NodeJS.Platform,
): boolean {
  return setPortOf(state.known, project, port, platform);
}

/**
 * The ports that belong to project files other than `except`: saved ones first, then the `servePort` some window has
 * seen. Files that no longer exist give their ports back.
 */
export function portOwners(
  state: SharedState,
  except: string | undefined,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform,
): Map<number, string> {
  const exceptKey = except === undefined ? undefined : pathKey(except, platform);
  const owners = new Map<number, string>();

  for (const map of [state.ports, state.known]) {
    for (const [path, port] of Object.entries(map)) {
      if (!owners.has(port) && pathKey(path, platform) !== exceptKey && exists(path)) {
        owners.set(port, path);
      }
    }
  }

  return owners;
}
