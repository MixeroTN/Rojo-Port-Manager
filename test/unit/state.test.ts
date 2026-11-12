import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  emptyState,
  parseState,
  pathKey,
  portOwners,
  savedPort,
  serializeState,
  setKnownPort,
  setSavedPort,
} from '../../src/model/state.ts';
import { StateStore } from '../../src/model/store.ts';

test('reads the shared state and leaves out broken parts', () => {
  const state = parseState(
    JSON.stringify({
      version: 1,
      ports: { 'C:\\Games\\A\\default.project.json': 34873, broken: 'x', zero: 0 },
      known: { 'C:\\Games\\C\\default.project.json': 34880 },
      servers: {
        '34873': {
          project: 'C:\\Games\\A\\default.project.json',
          projectName: 'A',
          pid: 3140,
          startedAt: '2026-11-12T01:00:00.000Z',
          log: 'C:\\logs\\34873.log',
          sessionId: 's1',
        },
        '34874': { project: 'C:\\Games\\B\\default.project.json', pid: -1, startedAt: 'x', log: 'y' },
        nope: { project: 'x', pid: 1, startedAt: 'x', log: 'y' },
      },
    }),
  );

  assert.deepEqual(state.ports, { 'C:\\Games\\A\\default.project.json': 34873 });
  assert.deepEqual(state.known, { 'C:\\Games\\C\\default.project.json': 34880 });
  assert.deepEqual(Object.keys(state.servers), ['34873']);
  assert.equal(state.servers['34873']?.port, 34873);
  assert.equal(state.servers['34873']?.projectName, 'A');
  assert.equal(state.servers['34873']?.sessionId, 's1');
  assert.deepEqual(parseState('not json'), emptyState());
  assert.deepEqual(parseState('[]'), emptyState());
  assert.deepEqual(parseState('{"version":1,"ports":{}}').known, {}, 'a state file of an older version');
});

test('compares paths case-insensitively on Windows and macOS', () => {
  assert.equal(pathKey('C:\\Games\\A\\x.project.json', 'win32'), pathKey('c:/games/a/X.project.json', 'win32'));
  assert.equal(pathKey('/Games/A/x.project.json', 'darwin'), pathKey('/games/a/X.project.json', 'darwin'));
  assert.notEqual(pathKey('/games/a/x.project.json', 'linux'), pathKey('/games/A/x.project.json', 'linux'));
});

test('saves, replaces and forgets the port of a project', () => {
  const state = emptyState();

  assert.equal(setSavedPort(state, 'C:\\Games\\A\\default.project.json', 34873, 'win32'), true);
  assert.equal(savedPort(state, 'c:\\games\\a\\DEFAULT.project.json', 'win32'), 34873);
  assert.equal(setSavedPort(state, 'C:\\Games\\A\\default.project.json', 34873, 'win32'), false, 'no change');

  setSavedPort(state, 'c:\\games\\a\\default.project.json', 34875, 'win32');
  assert.deepEqual(state.ports, { 'c:\\games\\a\\default.project.json': 34875 }, 'one entry per file');

  setSavedPort(state, 'C:\\Games\\A\\default.project.json', undefined, 'win32');
  assert.equal(savedPort(state, 'C:\\Games\\A\\default.project.json', 'win32'), undefined);
});

test('ports belong to the projects that saved or asked for them, while their files exist', () => {
  const state = emptyState();
  const files = new Set(['C:\\Games\\A\\default.project.json', 'C:\\Games\\B\\default.project.json']);

  setSavedPort(state, 'C:\\Games\\A\\default.project.json', 34873, 'win32');
  setKnownPort(state, 'C:\\Games\\B\\default.project.json', 34874, 'win32');
  setSavedPort(state, 'C:\\Games\\Deleted\\default.project.json', 34875, 'win32');

  const owners = portOwners(state, 'c:\\games\\a\\default.project.json', (path) => files.has(path), 'win32');

  assert.deepEqual([...owners], [[34874, 'C:\\Games\\B\\default.project.json']], 'not its own, not a deleted file');
});

test('the store writes the whole file and reads it back', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rojo-ports-'));

  try {
    const store = new StateStore(join(folder, 'nested', 'state.json'));
    assert.deepEqual(store.read(), emptyState(), 'missing file');

    store.update((state) => setSavedPort(state, '/games/a/default.project.json', 34873, 'linux'));
    store.update((state) => setKnownPort(state, '/games/b/default.project.json', 34874, 'linux'));

    assert.deepEqual(store.read().ports, { '/games/a/default.project.json': 34873 });
    assert.deepEqual(store.read().known, { '/games/b/default.project.json': 34874 });
    assert.equal(readFileSync(store.file, 'utf8'), serializeState(store.read()));

    writeFileSync(store.file, '{ broken');
    assert.deepEqual(store.read(), emptyState(), 'broken file');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
