import * as nodePath from 'node:path';

/** What finding Rojo needs from the machine; tests pass their own values. */
export interface ToolLookup {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  isFile(path: string): boolean;
  /** The text of a file, or undefined when it cannot be read. */
  readFile(path: string): string | undefined;
}

export interface ToolSpec {
  author: string;
  name: string;
  version: string;
}

/** A `rojo` entry of a tool manifest, as written. */
export interface ManifestEntry {
  manifest: string;
  /** `author/name`. */
  source: string;
  version: string;
}

export type RojoSource = 'setting' | 'rokit' | 'aftman' | 'path';

/**
 * A Rojo executable to start directly. Never a tool manager shim: started in the background, a shim has no console,
 * and the Rojo it starts would open a console window of its own.
 */
export interface RojoLocation {
  path: string;
  source: RojoSource;
  /** The pinned version, when a manifest pins one. */
  version?: string;
  /** The manifest that pins it. */
  manifest?: string;
}

export type RojoResolution =
  | { kind: 'found'; location: RojoLocation }
  /** Pinned, but that version is not in the storage of Rokit or Aftman. */
  | { kind: 'notInstalled'; spec: ToolSpec; manifest: string }
  /** Pinned with a version range or a form the extension cannot resolve. */
  | { kind: 'badEntry'; entry: ManifestEntry }
  /** `rojoPorts.rojoPath` names no file. */
  | { kind: 'badSetting'; path: string }
  /** Nothing pinned, and no Rojo on PATH. */
  | { kind: 'missing' };

/** The manifests of the tool managers, in the order Rokit reads them in a folder. */
export const MANIFESTS = ['rokit.toml', 'aftman.toml', 'foreman.toml'];

function pathModule(platform: NodeJS.Platform): typeof nodePath.posix {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** Reads an environment variable; on Windows names are case-insensitive (`Path` and `PATH`). */
export function getEnv(env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform) {
  if (platform !== 'win32') {
    return env[name];
  }

  const upper = name.toUpperCase();
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);

  return key === undefined ? undefined : env[key];
}

function expandHome(value: string, homeDir: string, platform: NodeJS.Platform): string {
  if (value === '~') {
    return homeDir;
  }

  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return pathModule(platform).join(homeDir, value.slice(2));
  }

  return value;
}

function executable(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/** Removes a TOML comment (`#` outside strings) from a line. */
function stripComment(line: string): string {
  let quote: string | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      return line.slice(0, index);
    }
  }

  return line;
}

function tomlString(value: string): string | undefined {
  const match = /^"([^"\\]*)"$|^'([^']*)'$/.exec(value.trim());

  return match ? (match[1] ?? match[2]) : undefined;
}

/**
 * The `rojo` entry of a manifest's `[tools]` table: `"author/name@version"` (Rokit, Aftman) or Foreman's
 * `{ source = "author/name", version = "=7.4.0" }` (also with `github` instead of `source`).
 */
export function readRojoEntry(text: string): { source: string; version: string } | undefined {
  let table = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);

    if (header) {
      table = (header[1] ?? '').replace(/^"(.*)"$/, '$1');
      continue;
    }

    const entry = table === 'tools' ? /^(?:rojo|"rojo"|'rojo')\s*=\s*(.+)$/.exec(line) : null;
    if (!entry) {
      continue;
    }

    const value = (entry[1] ?? '').trim();
    const text = tomlString(value);

    if (text !== undefined) {
      const at = text.lastIndexOf('@');

      return at <= 0 ? undefined : { source: text.slice(0, at), version: text.slice(at + 1) };
    }

    const inline = /^\{(.*)\}$/.exec(value);
    if (inline) {
      const fields = new Map<string, string>();

      for (const part of (inline[1] ?? '').split(',')) {
        const field = /^\s*([\w-]+)\s*=\s*(.+?)\s*$/.exec(part);
        const fieldValue = field ? tomlString(field[2] ?? '') : undefined;

        if (field?.[1] && fieldValue !== undefined) {
          fields.set(field[1], fieldValue);
        }
      }

      const source = fields.get('source') ?? fields.get('github');
      const version = fields.get('version');

      return source && version ? { source, version } : undefined;
    }

    return undefined;
  }

  return undefined;
}

/** An exact version, as Rokit and Aftman pin it (Foreman's `=7.4.0` counts too); undefined for a range. */
export function exactVersion(version: string): string | undefined {
  const trimmed = version.trim().replace(/^=\s*/, '').replace(/^v/, '');

  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : undefined;
}

function rokitRoots(lookup: ToolLookup): string[] {
  const path = pathModule(lookup.platform);
  const roots: string[] = [];
  const configured = getEnv(lookup.env, 'ROKIT_ROOT', lookup.platform);

  if (configured) {
    roots.push(configured);
  }

  roots.push(path.join(lookup.homeDir, '.rokit'));

  return roots;
}

/**
 * Where a folder's Rojo version is pinned: the closest folder (this one or a parent) with a `rojo` entry in its
 * rokit.toml, aftman.toml or foreman.toml, else the global manifests of Rokit and Aftman.
 */
export function findPinnedRojo(folder: string, lookup: ToolLookup): ManifestEntry | undefined {
  const path = pathModule(lookup.platform);
  const candidates: string[] = [];
  let current = path.resolve(folder);

  for (;;) {
    candidates.push(...MANIFESTS.map((name) => path.join(current, name)));

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  candidates.push(
    ...rokitRoots(lookup).map((root) => path.join(root, 'rokit.toml')),
    path.join(lookup.homeDir, '.aftman', 'aftman.toml'),
  );

  for (const manifest of candidates) {
    const text = lookup.readFile(manifest);
    const entry = text === undefined ? undefined : readRojoEntry(text);

    if (entry) {
      return { manifest, ...entry };
    }
  }

  return undefined;
}

/**
 * The installed binary of a pinned tool: Rokit keeps `tool-storage/<author>/<name>/<version>/<name>` in lower case,
 * Aftman as written.
 */
export function storedTool(
  spec: ToolSpec,
  lookup: ToolLookup,
): { path: string; source: 'rokit' | 'aftman' } | undefined {
  const path = pathModule(lookup.platform);
  const spellings = [
    [spec.author.toLowerCase(), spec.name.toLowerCase()],
    [spec.author, spec.name],
  ] as const;
  const candidates: { path: string; source: 'rokit' | 'aftman' }[] = [];
  const add = (root: string, source: 'rokit' | 'aftman') => {
    for (const [author, name] of spellings) {
      candidates.push({
        path: path.join(root, 'tool-storage', author, name, spec.version, executable(name, lookup.platform)),
        source,
      });
    }
  };

  for (const root of rokitRoots(lookup)) {
    add(root, 'rokit');
  }

  add(path.join(lookup.homeDir, '.aftman'), 'aftman');

  return candidates.find((candidate) => lookup.isFile(candidate.path));
}

/** The folders of tool manager shims: a `rojo` there is a shim, never started directly. */
function shimFolders(lookup: ToolLookup): string[] {
  const path = pathModule(lookup.platform);

  return [
    ...rokitRoots(lookup).map((root) => path.join(root, 'bin')),
    path.join(lookup.homeDir, '.aftman', 'bin'),
    path.join(lookup.homeDir, '.foreman', 'bin'),
  ];
}

/**
 * Finds the Rojo to start for a project folder: the `rojoPorts.rojoPath` setting; else the version the folder pins,
 * from the storage of Rokit or Aftman (what their shim would run); else a Rojo on PATH that is not a shim.
 */
export function resolveRojo(setting: unknown, folder: string, lookup: ToolLookup): RojoResolution {
  const path = pathModule(lookup.platform);
  const configured = typeof setting === 'string' ? setting.trim() : '';

  if (configured !== '') {
    const expanded = expandHome(configured, lookup.homeDir, lookup.platform);

    return lookup.isFile(expanded)
      ? { kind: 'found', location: { path: expanded, source: 'setting' } }
      : { kind: 'badSetting', path: expanded };
  }

  const entry = findPinnedRojo(folder, lookup);

  if (entry) {
    const version = exactVersion(entry.version);
    const parts = /^([\w.-]+)\/([\w.-]+)$/.exec(entry.source.trim());

    if (!version || !parts?.[1] || !parts[2]) {
      return { kind: 'badEntry', entry };
    }

    const spec: ToolSpec = { author: parts[1], name: parts[2], version };
    const stored = storedTool(spec, lookup);

    return stored
      ? { kind: 'found', location: { path: stored.path, source: stored.source, version, manifest: entry.manifest } }
      : { kind: 'notInstalled', spec, manifest: entry.manifest };
  }

  const key = (folderPath: string) =>
    lookup.platform === 'win32' ? path.resolve(folderPath).toLowerCase() : path.resolve(folderPath);
  const shims = new Set(shimFolders(lookup).map(key));

  for (const rawEntry of (getEnv(lookup.env, 'PATH', lookup.platform) ?? '').split(path.delimiter)) {
    const pathEntry = rawEntry.trim();
    if (pathEntry === '' || shims.has(key(pathEntry))) {
      continue;
    }

    const candidate = path.join(pathEntry, executable('rojo', lookup.platform));
    if (lookup.isFile(candidate)) {
      return { kind: 'found', location: { path: candidate, source: 'path' } };
    }
  }

  return { kind: 'missing' };
}

/**
 * The environment of a Rojo server: the extension host's own without the variables of VS Code's processes (the
 * server outlives the window), plus the extra variables.
 */
export function buildServerEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !/^(ELECTRON_|VSCODE_)/i.test(key)) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
}

/** Quotes an argument for display in the log (never passed to a shell). */
export function displayArgument(argument: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(argument) ? argument : JSON.stringify(argument);
}
