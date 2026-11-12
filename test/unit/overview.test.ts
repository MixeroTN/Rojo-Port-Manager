import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOverview, type ProjectEntry } from '../../src/model/overview.ts';
import { emptyState, type SharedState } from '../../src/model/state.ts';
import type { ProbeResult } from '../../src/rojo/probe.ts';
import type { RojoServerInfo } from '../../src/rojo/serverInfo.ts';

function project(folder: string, name: string, servePort?: number): ProjectEntry {
  return {
    path: `/games/${folder}/default.project.json`,
    folder: `/games/${folder}`,
    file: 'default.project.json',
    workspaceFolder: folder,
    info: { name, servePort, servePlaceIds: [] },
  };
}

function rojo(projectName: string, sessionId = `session-${projectName}`): ProbeResult {
  const info: RojoServerInfo = { projectName, sessionId, serverVersion: '7.7.1', expectedPlaceIds: [] };

  return { state: 'rojo', info };
}

function overview(projects: ProjectEntry[], probes: [number, ProbeResult][], state: SharedState = emptyState()) {
  return buildOverview({
    projects,
    probes: new Map(probes),
    state,
    busy: new Map(),
    logOf: () => undefined,
    platform: 'linux',
  });
}

test('a project without a saved port or servePort has none yet', () => {
  const [status] = overview([project('a', 'A')], []).projects;

  assert.equal(status?.port, undefined);
  assert.equal(status?.state.kind, 'noPort');
});

test('the saved port comes before servePort', () => {
  const state = emptyState();
  state.ports['/games/a/default.project.json'] = 34880;

  const [saved] = overview([project('a', 'A', 34874)], [], state).projects;
  const [fromFile] = overview([project('a', 'A', 34874)], []).projects;

  assert.equal(saved?.port, 34880);
  assert.equal(saved?.portSource, 'saved');
  assert.equal(fromFile?.port, 34874);
  assert.equal(fromFile?.portSource, 'projectFile');
  assert.equal(fromFile?.state.kind, 'unknown', 'not probed yet');
});

test('states from what answers on the port', () => {
  const projects = [
    project('a', 'A', 34873),
    project('b', 'B', 34874),
    project('c', 'C', 34875),
    project('d', 'D', 34876),
  ];
  const result = overview(projects, [
    [34873, { state: 'free' }],
    [34874, rojo('B')],
    [34875, rojo('Something Else')],
    [34876, { state: 'other', detail: 'HTTP 404' }],
  ]);

  assert.deepEqual(
    result.projects.map((status) => status.state.kind),
    ['stopped', 'running', 'conflict', 'portBusy'],
  );

  const running = result.projects[1]?.state;
  assert.equal(running?.kind === 'running' && running.startedByPanel, false, 'started outside the panel');
  assert.deepEqual(result.others, [], 'project ports are not other servers');
});

test('the panel record tells its own servers from others', () => {
  const state = emptyState();
  state.servers['34873'] = {
    port: 34873,
    project: '/games/a/default.project.json',
    pid: 10,
    startedAt: '2026-11-12T01:00:00.000Z',
    log: '/logs/34873.log',
    sessionId: 'session-A',
  };
  // A copy of project B elsewhere, with the same name, that the panel started on B's port.
  state.servers['34874'] = {
    port: 34874,
    project: '/games/elsewhere/default.project.json',
    projectName: 'B',
    pid: 11,
    startedAt: '2026-11-12T01:00:00.000Z',
    log: '/logs/34874.log',
    sessionId: 'session-B',
  };

  const result = overview(
    [project('a', 'A', 34873), project('b', 'B', 34874)],
    [
      [34873, rojo('A')],
      [34874, rojo('B')],
    ],
    state,
  );
  const [a, b] = result.projects;

  assert.equal(a?.state.kind === 'running' && a.state.startedByPanel, true);
  assert.equal(a?.record?.pid, 10);
  assert.equal(a?.log, '/logs/34873.log');
  assert.equal(b?.state.kind, 'conflict', 'the panel started that server for another project');
  assert.equal(b?.state.kind === 'conflict' && b.state.otherProject, '/games/elsewhere/default.project.json');
});

test('a record of an older session on the port is ignored', () => {
  const state = emptyState();
  state.servers['34873'] = {
    port: 34873,
    project: '/games/elsewhere/default.project.json',
    pid: 10,
    startedAt: '2026-11-12T01:00:00.000Z',
    log: '/logs/34873.log',
    sessionId: 'old',
  };

  const [status] = overview([project('a', 'A', 34873)], [[34873, rojo('A', 'new')]], state).projects;

  assert.equal(status?.state.kind === 'running' && status.state.startedByPanel, false);
});

test('servers of other projects are listed in port order', () => {
  const state = emptyState();
  state.servers['34890'] = {
    port: 34890,
    project: '/games/z/default.project.json',
    projectName: 'Z',
    pid: 12,
    startedAt: '2026-11-12T01:00:00.000Z',
    log: '/logs/34890.log',
  };

  const result = overview(
    [project('a', 'A', 34873)],
    [
      [34890, rojo('Z')],
      [34873, { state: 'free' }],
      [34872, rojo('Y')],
      [34880, { state: 'other', detail: 'no answer' }],
    ],
    state,
  );

  assert.deepEqual(
    result.others.map((server) => [server.port, server.info.projectName, server.record?.pid]),
    [
      [34872, 'Y', undefined],
      [34890, 'Z', 12],
    ],
  );
});
