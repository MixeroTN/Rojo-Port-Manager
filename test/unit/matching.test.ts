import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildOverview,
  expectedProjectName,
  liveRecord,
  servesProject,
  type ProjectEntry,
} from '../../src/model/overview.ts';
import { emptyState } from '../../src/model/state.ts';
import type { RojoServerInfo } from '../../src/rojo/serverInfo.ts';

function project(name: string | undefined, places: string[] = []): ProjectEntry {
  return {
    path: '/games/arena/default.project.json',
    folder: '/games/arena',
    file: 'default.project.json',
    workspaceFolder: 'arena',
    info: { name, servePlaceIds: places },
  };
}

function info(projectName: string, places: string[] = [], sessionId = 's1'): RojoServerInfo {
  return { projectName, sessionId, expectedPlaceIds: places };
}

test('a project without a name is served under the name of its folder', () => {
  assert.equal(expectedProjectName(project('Arena')), 'Arena');
  assert.equal(expectedProjectName(project(undefined)), 'arena');
  assert.equal(servesProject(info('arena'), project(undefined)), true);
});

test('copies of a template with the same name are told apart by their places', () => {
  assert.equal(servesProject(info('Game', ['1', '2']), project('Game', ['2', '1'])), true);
  assert.equal(servesProject(info('Game', ['3']), project('Game', ['1'])), false);
  assert.equal(servesProject(info('Game'), project('Game', ['1'])), true, 'a server without places allows any');
  assert.equal(servesProject(info('Other', ['1']), project('Game', ['1'])), false);
});

test('a record made before its server answered needs a matching project name', () => {
  const state = emptyState();
  state.servers['34873'] = {
    port: 34873,
    project: '/games/arena/default.project.json',
    projectName: 'Arena',
    pid: 10,
    startedAt: '2026-11-12T01:00:00.000Z',
    log: '/logs/34873.log',
  };

  assert.equal(liveRecord(state, 34873, { state: 'rojo', info: info('Arena') })?.pid, 10);
  assert.equal(liveRecord(state, 34873, { state: 'rojo', info: info('Somebody Else') }), undefined);
  assert.equal(liveRecord(state, 34873, { state: 'free' }), undefined);

  const { projects } = buildOverview({
    projects: [{ ...project('Arena'), info: { name: 'Arena', servePort: 34873, servePlaceIds: [] } }],
    probes: new Map([[34873, { state: 'rojo', info: info('Somebody Else') }]]),
    state,
    busy: new Map(),
    logOf: () => undefined,
    platform: 'linux',
  });

  assert.equal(projects[0]?.state.kind, 'conflict', 'a later server of another project is not claimed');
});
