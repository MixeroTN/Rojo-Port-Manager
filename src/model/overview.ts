import type { ProbeResult } from '../rojo/probe.ts';
import type { RojoServerInfo } from '../rojo/serverInfo.ts';
import type { ProjectFileInfo } from './projectFile.ts';
import { pathKey, savedPort, type ServerRecord, type SharedState } from './state.ts';

/** A project file at the root of a workspace folder. */
export interface ProjectEntry {
  /** Absolute path of the project file. */
  path: string;
  /** Its folder: where Rojo runs. */
  folder: string;
  /** Its file name, e.g. `default.project.json`. */
  file: string;
  /** The name of its workspace folder. */
  workspaceFolder: string;
  /** Undefined when the file could not be read as JSON. */
  info?: ProjectFileInfo;
}

/** Where a project's port comes from. */
export type PortSource = 'saved' | 'projectFile';

export type Busy = 'starting' | 'stopping';

export type ProjectState =
  /** No port saved and no `servePort`: Start picks one. */
  | { kind: 'noPort' }
  /** Not probed yet. */
  | { kind: 'unknown' }
  | { kind: 'stopped' }
  /** A Rojo server of this project answers on its port. */
  | { kind: 'running'; server: RojoServerInfo; startedByPanel: boolean }
  /** A Rojo server of another project answers on its port. */
  | { kind: 'conflict'; server: RojoServerInfo; otherProject?: string }
  /** Another program listens on its port. */
  | { kind: 'portBusy'; detail: string };

export interface ProjectStatus {
  project: ProjectEntry;
  port?: number;
  portSource?: PortSource;
  state: ProjectState;
  busy?: Busy;
  /** The panel's record of the server on its port, when the panel started it for this project. */
  record?: ServerRecord;
  /** The log file of the last server the panel started on its port, when there is one. */
  log?: string;
}

/** A running Rojo server that is not one of this window's projects. */
export interface OtherServer {
  port: number;
  info: RojoServerInfo;
  /** The panel's record, when the panel started it. */
  record?: ServerRecord;
  busy?: Busy;
}

export interface Overview {
  projects: ProjectStatus[];
  others: OtherServer[];
}

export interface OverviewInput {
  projects: readonly ProjectEntry[];
  probes: ReadonlyMap<number, ProbeResult>;
  state: SharedState;
  /** Actions in progress, by project path key or by `port:<n>`. */
  busy: ReadonlyMap<string, Busy>;
  /** The log file of a port, when it exists. */
  logOf: (port: number) => string | undefined;
  platform: NodeJS.Platform;
}

/** The port of a project: the saved one, else its `servePort`. */
export function projectPort(
  project: ProjectEntry,
  state: SharedState,
  platform: NodeJS.Platform,
): { port?: number; source?: PortSource } {
  const saved = savedPort(state, project.path, platform);
  if (saved !== undefined) {
    return { port: saved, source: 'saved' };
  }

  const wanted = project.info?.servePort;

  return wanted === undefined ? {} : { port: wanted, source: 'projectFile' };
}

/**
 * The name a server of the project reports: its `name`, or (Rojo 7.7 for a `default.project.json` without one) the
 * name of its folder.
 */
export function expectedProjectName(project: ProjectEntry): string {
  return project.info?.name ?? project.folder.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/** Whether two lists of place ids allow the same server: an empty list allows any place. */
function samePlaces(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return true;
  }

  const set = new Set(left);

  return right.length === set.size && right.every((id) => set.has(id));
}

/**
 * Whether a server started outside the panel serves this project. Its name (and its `servePlaceIds`, when both set
 * them) is all that tells: copies of one template share a name.
 */
export function servesProject(info: RojoServerInfo, project: ProjectEntry): boolean {
  return (
    info.projectName === expectedProjectName(project) &&
    samePlaces(project.info?.servePlaceIds ?? [], info.expectedPlaceIds)
  );
}

/** The panel's record of the server on a port, when it still describes the server that answers there. */
export function liveRecord(state: SharedState, port: number, probe: ProbeResult | undefined): ServerRecord | undefined {
  const record = state.servers[String(port)];
  if (!record || probe?.state !== 'rojo') {
    return undefined;
  }

  if (record.sessionId !== undefined) {
    return record.sessionId === probe.info.sessionId ? record : undefined;
  }

  // Recorded before the server answered (the window closed during the start): its project name must still match.
  return record.projectName !== undefined && record.projectName === probe.info.projectName ? record : undefined;
}

function stateOf(
  project: ProjectEntry,
  port: number,
  probe: ProbeResult | undefined,
  record: ServerRecord | undefined,
  platform: NodeJS.Platform,
): ProjectState {
  if (!probe) {
    return { kind: 'unknown' };
  }

  if (probe.state === 'free') {
    return { kind: 'stopped' };
  }

  if (probe.state === 'other') {
    return { kind: 'portBusy', detail: probe.detail };
  }

  if (record) {
    return pathKey(record.project, platform) === pathKey(project.path, platform)
      ? { kind: 'running', server: probe.info, startedByPanel: true }
      : { kind: 'conflict', server: probe.info, otherProject: record.project };
  }

  return servesProject(probe.info, project)
    ? { kind: 'running', server: probe.info, startedByPanel: false }
    : { kind: 'conflict', server: probe.info };
}

/** What the panel shows: this window's projects with their ports and servers, and the other running servers. */
export function buildOverview(input: OverviewInput): Overview {
  const { probes, state, busy, platform } = input;
  const projectPorts = new Set<number>();

  const projects = input.projects.map((project): ProjectStatus => {
    const { port, source } = projectPort(project, state, platform);
    const projectBusy = busy.get(pathKey(project.path, platform));

    if (port === undefined) {
      return { project, state: { kind: 'noPort' }, busy: projectBusy };
    }

    projectPorts.add(port);

    const probe = probes.get(port);
    const record = liveRecord(state, port, probe);
    const projectState = stateOf(project, port, probe, record, platform);
    const ownRecord = projectState.kind === 'running' && projectState.startedByPanel ? record : undefined;

    return {
      project,
      port,
      portSource: source,
      state: projectState,
      busy: projectBusy,
      record: ownRecord,
      log: ownRecord?.log ?? input.logOf(port),
    };
  });

  const others: OtherServer[] = [];

  for (const [port, probe] of [...probes].sort(([left], [right]) => left - right)) {
    if (probe.state !== 'rojo' || projectPorts.has(port)) {
      continue;
    }

    others.push({ port, info: probe.info, record: liveRecord(state, port, probe), busy: busy.get(`port:${port}`) });
  }

  return { projects, others };
}
