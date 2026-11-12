import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Overview, ProjectEntry, ProjectStatus } from '../../src/model/overview.ts';
import type { RojoServerInfo } from '../../src/rojo/serverInfo.ts';
import { buildTree, flatten, shortPath, stateText } from '../../src/views/model.ts';

const info: RojoServerInfo = { projectName: 'A', sessionId: 's', serverVersion: '7.7.1', expectedPlaceIds: [] };

function entry(folder: string, file = 'default.project.json', readable = true): ProjectEntry {
  return {
    path: `/games/${folder}/${file}`,
    folder: `/games/${folder}`,
    file,
    workspaceFolder: folder,
    info: readable ? { name: 'A', servePlaceIds: ['1818'] } : undefined,
  };
}

function status(overrides: Partial<ProjectStatus>): ProjectStatus {
  return { project: entry('a'), state: { kind: 'stopped' }, port: 34873, portSource: 'saved', ...overrides };
}

test('menu flags follow the state', () => {
  const tree = buildTree(
    {
      projects: [
        status({}),
        status({ project: entry('b'), state: { kind: 'running', server: info, startedByPanel: true }, log: '/l.log' }),
        status({ project: entry('c'), port: undefined, portSource: undefined, state: { kind: 'noPort' } }),
        status({ project: entry('d'), busy: 'starting' }),
        status({ project: entry('e', 'default.project.json', false) }),
        status({ project: entry('f'), state: { kind: 'conflict', server: { ...info, projectName: 'Other' } } }),
        status({ project: entry('g'), state: { kind: 'portBusy', detail: 'HTTP 404' } }),
      ],
      others: [],
    },
    false,
  );

  assert.deepEqual(
    tree.map((node) => node.contextValue),
    [
      'rojo:project +start +port',
      'rojo:project +stop +restart +port +log',
      'rojo:project +start',
      'rojo:project +port',
      'rojo:project +port',
      'rojo:project +start +stop +port',
      'rojo:project +start +port',
    ],
  );
  assert.deepEqual(
    tree.map((node) => node.description),
    [
      ':34873 · stopped',
      ':34873 · running',
      'no port yet',
      ':34873 · starting…',
      ':34873 · project file not readable',
      ':34873 · port taken by Rojo "Other"',
      ':34873 · port taken by another program',
    ],
  );
});

test('state texts', () => {
  assert.equal(
    stateText(status({ state: { kind: 'running', server: info, startedByPanel: false } })),
    'running, started outside the panel',
  );
  assert.equal(
    stateText(status({ state: { kind: 'conflict', server: { ...info, projectName: 'Other' } } })),
    'port taken by Rojo "Other"',
  );
  assert.equal(stateText(status({ state: { kind: 'portBusy', detail: 'HTTP 404' } })), 'port taken by another program');
  assert.equal(stateText(status({ state: { kind: 'unknown' } })), 'checking…');
  assert.equal(stateText(status({ busy: 'stopping' })), 'stopping…');
});

test('the tooltip tells where the port comes from', () => {
  const [saved] = buildTree({ projects: [status({})], others: [] }, false);
  const [fromFile] = buildTree({ projects: [status({ portSource: 'projectFile' })], others: [] }, false);

  assert.ok(saved?.tooltip.includes('Port: 34873 (saved by the panel)'));
  assert.ok(fromFile?.tooltip.includes('Port: 34873 (servePort of the project file)'));
  assert.ok(saved?.tooltip.includes('Syncs only into the places 1818 (servePlaceIds).'));
});

test('several workspace folders group the projects, and other servers come last', () => {
  const overview: Overview = {
    projects: [status({}), status({ project: entry('b', 'tower.project.json') })],
    others: [
      { port: 34890, info: { ...info, projectName: 'Z' } },
      {
        port: 34891,
        info: { ...info, projectName: 'Y' },
        record: { port: 34891, project: '/games/y/default.project.json', pid: 1, startedAt: 'x', log: '/y.log' },
      },
    ],
  };
  const tree = buildTree(overview, true);

  assert.deepEqual(
    tree.map((node) => node.label),
    ['a', 'b', 'Other Rojo servers'],
  );
  assert.deepEqual(
    flatten(tree).map((node) => node.id),
    [
      'folder:a',
      'project:/games/a/default.project.json',
      'folder:b',
      'project:/games/b/tower.project.json',
      'others',
      'server:34890',
      'server:34891',
    ],
  );

  const servers = tree[2]?.children ?? [];
  assert.deepEqual(
    servers.map((node) => [node.label, node.description, node.contextValue]),
    [
      ['Z', ':34890 · started outside the panel', 'rojo:server +stop +port'],
      ['Y', ':34891 · y/default.project.json', 'rojo:server +stop +port +log'],
    ],
  );
});

test('short paths keep the folder and the file', () => {
  assert.equal(shortPath('C:\\Games\\TinyGame\\default.project.json'), 'TinyGame/default.project.json');
  assert.equal(shortPath('/games/a/b.project.json'), 'a/b.project.json');
});
