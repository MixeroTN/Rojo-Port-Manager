import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildServerEnv,
  exactVersion,
  findPinnedRojo,
  getEnv,
  readRojoEntry,
  resolveRojo,
  type ToolLookup,
} from '../../src/rojo/tools.ts';

const HOME = 'C:\\Users\\me';
const ROKIT_717 = `${HOME}\\.rokit\\tool-storage\\rojo-rbx\\rojo\\7.7.1\\rojo.exe`;
const AFTMAN_751 = `${HOME}\\.aftman\\tool-storage\\rojo-rbx\\rojo\\7.5.1\\rojo.exe`;

function lookup(files: Record<string, string>, env: Record<string, string> = {}): ToolLookup {
  const known = new Map(Object.entries(files).map(([path, text]) => [path.toLowerCase(), text]));

  return {
    platform: 'win32',
    env,
    homeDir: HOME,
    isFile: (path) => known.has(path.toLowerCase()),
    readFile: (path) => known.get(path.toLowerCase()),
  };
}

test('reads the rojo entry of the manifests of Rokit, Aftman and Foreman', () => {
  assert.deepEqual(readRojoEntry('[tools]\nrojo = "rojo-rbx/rojo@7.7.1" # pinned\nlune = "lune-org/lune@0.11.1"\n'), {
    source: 'rojo-rbx/rojo',
    version: '7.7.1',
  });
  assert.deepEqual(readRojoEntry("# tools\n[tools]\n'rojo' = 'rojo-rbx/rojo@7.6.0'\n"), {
    source: 'rojo-rbx/rojo',
    version: '7.6.0',
  });
  assert.deepEqual(readRojoEntry('[tools]\nrojo = { source = "rojo-rbx/rojo", version = "=7.4.0" }\n'), {
    source: 'rojo-rbx/rojo',
    version: '=7.4.0',
  });
  assert.deepEqual(readRojoEntry('[tools]\nrojo = { github = "rojo-rbx/rojo", version = "7.3.0" }\n'), {
    source: 'rojo-rbx/rojo',
    version: '7.3.0',
  });
  assert.equal(readRojoEntry('[other]\nrojo = "rojo-rbx/rojo@7.7.1"\n'), undefined, 'outside [tools]');
  assert.equal(readRojoEntry('[tools]\nselene = "Kampfkarren/selene@0.27.1"\n'), undefined);
  assert.equal(readRojoEntry('[tools]\nrojo = "no-version"\n'), undefined);
});

test('only exact versions resolve', () => {
  assert.equal(exactVersion('7.7.1'), '7.7.1');
  assert.equal(exactVersion('=7.4.0'), '7.4.0');
  assert.equal(exactVersion('v7.6.1'), '7.6.1');
  assert.equal(exactVersion('7.7.0-rc.1'), '7.7.0-rc.1');
  assert.equal(exactVersion('^7.4'), undefined);
  assert.equal(exactVersion('7.x'), undefined);
});

test('the closest manifest that pins rojo wins, then the global ones', () => {
  const files = {
    'E:\\Games\\rokit.toml': '[tools]\nrojo = "rojo-rbx/rojo@7.6.1"\n',
    'E:\\Games\\Arena\\rokit.toml': '[tools]\nlune = "lune-org/lune@0.11.1"\n',
    'E:\\Games\\Arena\\aftman.toml': '[tools]\nrojo = "rojo-rbx/rojo@7.5.1"\n',
    [`${HOME}\\.aftman\\aftman.toml`]: '[tools]\nrojo = "rojo-rbx/rojo@7.2.1"\n',
  };

  assert.equal(findPinnedRojo('E:\\Games\\Arena', lookup(files))?.manifest, 'E:\\Games\\Arena\\aftman.toml');
  assert.equal(findPinnedRojo('E:\\Games\\Other', lookup(files))?.version, '7.6.1', 'a parent folder');
  assert.equal(findPinnedRojo('D:\\Elsewhere', lookup(files))?.version, '7.2.1', 'the global Aftman manifest');
});

test('starts the pinned binary from the storage of Rokit or Aftman', () => {
  const files = {
    'E:\\A\\rokit.toml': '[tools]\nrojo = "rojo-rbx/rojo@7.7.1"\n',
    'E:\\B\\aftman.toml': '[tools]\nrojo = "Rojo-Rbx/Rojo@7.5.1"\n',
    'E:\\C\\rokit.toml': '[tools]\nrojo = "rojo-rbx/rojo@7.9.9"\n',
    'E:\\D\\foreman.toml': '[tools]\nrojo = { source = "rojo-rbx/rojo", version = "^7.4" }\n',
    [ROKIT_717]: '',
    [AFTMAN_751]: '',
  };

  assert.deepEqual(resolveRojo('', 'E:\\A', lookup(files)), {
    kind: 'found',
    location: { path: ROKIT_717, source: 'rokit', version: '7.7.1', manifest: 'E:\\A\\rokit.toml' },
  });

  const aftman = resolveRojo('', 'E:\\B', lookup(files));
  assert.equal(aftman.kind === 'found' && aftman.location.source, 'aftman');
  assert.equal(aftman.kind === 'found' && aftman.location.path.toLowerCase(), AFTMAN_751.toLowerCase());

  assert.deepEqual(resolveRojo('', 'E:\\C', lookup(files)), {
    kind: 'notInstalled',
    spec: { author: 'rojo-rbx', name: 'rojo', version: '7.9.9' },
    manifest: 'E:\\C\\rokit.toml',
  });
  assert.equal(resolveRojo('', 'E:\\D', lookup(files)).kind, 'badEntry');
});

test('ROKIT_ROOT holds the storage when it is set', () => {
  const files = {
    'E:\\A\\rokit.toml': '[tools]\nrojo = "rojo-rbx/rojo@7.7.1"\n',
    'D:\\rokit\\tool-storage\\rojo-rbx\\rojo\\7.7.1\\rojo.exe': '',
  };
  const resolution = resolveRojo('', 'E:\\A', lookup(files, { ROKIT_ROOT: 'D:\\rokit' }));

  assert.equal(
    resolution.kind === 'found' && resolution.location.path,
    'D:\\rokit\\tool-storage\\rojo-rbx\\rojo\\7.7.1\\rojo.exe',
  );
});

test('without a pinned version: a Rojo on PATH, never a tool manager shim', () => {
  const env = { Path: `${HOME}\\.rokit\\bin;C:\\tools` };

  assert.deepEqual(
    resolveRojo('', 'E:\\A', lookup({ [`${HOME}\\.rokit\\bin\\rojo.exe`]: '', 'C:\\tools\\rojo.exe': '' }, env)),
    {
      kind: 'found',
      location: { path: 'C:\\tools\\rojo.exe', source: 'path' },
    },
  );
  assert.deepEqual(resolveRojo('', 'E:\\A', lookup({ [`${HOME}\\.rokit\\bin\\rojo.exe`]: '' }, env)), {
    kind: 'missing',
  });
});

test('the setting wins, and a wrong setting is reported', () => {
  const files = { 'E:\\A\\rokit.toml': '[tools]\nrojo = "rojo-rbx/rojo@7.7.1"\n', 'E:\\rojo\\rojo.exe': '' };

  assert.deepEqual(resolveRojo(' E:\\rojo\\rojo.exe ', 'E:\\A', lookup(files)), {
    kind: 'found',
    location: { path: 'E:\\rojo\\rojo.exe', source: 'setting' },
  });
  assert.deepEqual(resolveRojo('E:\\missing\\rojo.exe', 'E:\\A', lookup(files)), {
    kind: 'badSetting',
    path: 'E:\\missing\\rojo.exe',
  });
  assert.equal(
    resolveRojo('~\\bin\\rojo.exe', 'E:\\A', lookup({ [`${HOME}\\bin\\rojo.exe`]: '' })).kind,
    'found',
    'a path from the home folder',
  );
  assert.equal(resolveRojo(42, 'E:\\A', lookup({})).kind, 'missing', 'a setting that is not text is ignored');
});

test('reads environment variables case-insensitively on Windows', () => {
  assert.equal(getEnv({ Path: 'x' }, 'PATH', 'win32'), 'x');
  assert.equal(getEnv({ Path: 'x' }, 'PATH', 'linux'), undefined);
});

test('the server environment has no variables of VS Code', () => {
  assert.deepEqual(
    buildServerEnv(
      { Path: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '42', vscode_ipc_hook: 'x', HOME: HOME },
      { NO_COLOR: '1' },
    ),
    { Path: 'C:\\Windows', HOME: HOME, NO_COLOR: '1' },
  );
});
