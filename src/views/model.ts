import type { OtherServer, Overview, ProjectStatus } from '../model/overview.ts';
import { projectLabel } from '../model/projectFile.ts';

/** A node of the panel, as plain data (the tree provider turns it into a TreeItem). */
export interface ViewNode {
  id: string;
  label: string;
  description?: string;
  /** Plain text paragraphs; escaped when shown. */
  tooltip: string[];
  icon?: { id: string; color?: string };
  /** `rojo:<type>` and `+flag` words that the menus of package.json match. */
  contextValue: string;
  collapsible: 'none' | 'expanded';
  children: ViewNode[];
  data: NodeData;
}

export type NodeData =
  | { type: 'project'; path: string }
  | { type: 'server'; port: number }
  | { type: 'folder'; name: string }
  | { type: 'others' };

/** The state of a project in words. */
export function stateText(status: ProjectStatus): string {
  if (status.busy) {
    return status.busy === 'starting' ? 'starting…' : 'stopping…';
  }

  const { state } = status;
  const readable = status.project.info !== undefined;

  switch (state.kind) {
    case 'noPort':
      return readable ? 'no port yet' : 'project file not readable';
    case 'unknown':
      return 'checking…';
    case 'stopped':
      return readable ? 'stopped' : 'project file not readable';
    case 'running':
      return state.startedByPanel ? 'running' : 'running, started outside the panel';
    case 'conflict':
      return `port taken by Rojo "${state.server.projectName}"`;
    case 'portBusy':
      return 'port taken by another program';
  }
}

function portSourceText(status: ProjectStatus): string {
  const wanted = status.project.info?.servePort;

  if (status.portSource === 'projectFile') {
    return 'servePort of the project file';
  }

  return wanted !== undefined && wanted !== status.port
    ? `saved by the panel; servePort of the file: ${wanted}`
    : 'saved by the panel';
}

/** A time saved as ISO text, shown as local "YYYY-MM-DD HH:MM". */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const two = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The last two parts of a path: "<folder>/<file>". */
export function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

function projectIcon(status: ProjectStatus): { id: string; color?: string } {
  if (status.busy) {
    return { id: 'loading~spin' };
  }

  switch (status.state.kind) {
    case 'running':
      return { id: 'circle-filled', color: 'testing.iconPassed' };
    case 'conflict':
    case 'portBusy':
      return { id: 'warning', color: 'list.warningForeground' };
    case 'unknown':
      return { id: 'circle-outline' };
    default:
      return status.project.info ? { id: 'circle-outline' } : { id: 'error', color: 'list.errorForeground' };
  }
}

function projectNode(status: ProjectStatus): ViewNode {
  const { project, port, state } = status;
  const label = projectLabel(project.file);
  const text = stateText(status);
  const flags: string[] = [];

  if (!status.busy && state.kind !== 'running' && project.info) {
    flags.push('+start');
  }

  // A conflict can be stopped too: that ends the other project's server that holds this project's port.
  if (!status.busy && (state.kind === 'running' || state.kind === 'conflict')) {
    flags.push('+stop');
  }

  if (!status.busy && state.kind === 'running') {
    flags.push('+restart');
  }

  if (port !== undefined) {
    flags.push('+port');
  }

  if (status.log) {
    flags.push('+log');
  }

  const tooltip = [`Rojo project "${project.info?.name ?? label}"`, `File: ${project.path}`];

  tooltip.push(
    port === undefined
      ? 'Port: none yet. Start picks a free one and keeps it for this project.'
      : `Port: ${port} (${portSourceText(status)})`,
  );
  tooltip.push(`State: ${text}`);

  if (state.kind === 'running') {
    if (state.server.serverVersion) {
      tooltip.push(`Rojo ${state.server.serverVersion}`);
    }

    tooltip.push(
      status.record
        ? `Started by the panel: ${formatTime(status.record.startedAt)}`
        : 'Started outside the panel, for example in a terminal.',
    );
  }

  if (state.kind === 'conflict' && state.otherProject) {
    tooltip.push(`The panel started that server for ${state.otherProject}.`);
  }

  if (state.kind === 'portBusy') {
    tooltip.push(`Answer on the port: ${state.detail}`);
  }

  if (!project.info) {
    tooltip.push('The project file is not valid JSON, so Rojo cannot serve it.');
  }

  const places = project.info?.servePlaceIds ?? [];
  if (places.length > 0) {
    tooltip.push(`Syncs only into the places ${places.join(', ')} (servePlaceIds).`);
  }

  if (status.log) {
    tooltip.push(`Log: ${status.log}`);
  }

  return {
    id: `project:${project.path}`,
    label,
    description: port === undefined ? text : `:${port} · ${text}`,
    tooltip,
    icon: projectIcon(status),
    contextValue: ['rojo:project', ...flags].join(' '),
    collapsible: 'none',
    children: [],
    data: { type: 'project', path: project.path },
  };
}

function serverNode(server: OtherServer): ViewNode {
  const { port, info, record } = server;
  const flags = server.busy ? ['+port'] : ['+stop', '+port'];
  const tooltip = [`Rojo server of "${info.projectName}" on port ${port}`];

  if (record) {
    flags.push('+log');
    tooltip.push(
      `Project file: ${record.project}`,
      `Started by the panel: ${formatTime(record.startedAt)}`,
      `Log: ${record.log}`,
    );
  } else {
    tooltip.push('Started outside the panel, for example in a terminal.');
  }

  if (info.serverVersion) {
    tooltip.push(`Rojo ${info.serverVersion}`);
  }

  if (info.expectedPlaceIds.length > 0) {
    tooltip.push(`Syncs only into the places ${info.expectedPlaceIds.join(', ')} (servePlaceIds).`);
  }

  const where = record ? shortPath(record.project) : 'started outside the panel';

  return {
    id: `server:${port}`,
    label: info.projectName,
    description: server.busy ? `:${port} · stopping…` : `:${port} · ${where}`,
    tooltip,
    icon: server.busy ? { id: 'loading~spin' } : { id: 'radio-tower', color: 'testing.iconPassed' },
    contextValue: ['rojo:server', ...flags].join(' '),
    collapsible: 'none',
    children: [],
    data: { type: 'server', port },
  };
}

/** The nodes of the panel. With several workspace folders, the projects are grouped by folder. */
export function buildTree(overview: Overview, multiRoot: boolean): ViewNode[] {
  const roots: ViewNode[] = [];

  if (multiRoot) {
    const folders = new Map<string, ProjectStatus[]>();

    for (const status of overview.projects) {
      const list = folders.get(status.project.workspaceFolder) ?? [];
      list.push(status);
      folders.set(status.project.workspaceFolder, list);
    }

    for (const [name, statuses] of folders) {
      roots.push({
        id: `folder:${name}`,
        label: name,
        tooltip: [],
        icon: { id: 'root-folder' },
        contextValue: 'rojo:folder',
        collapsible: 'expanded',
        children: statuses.map(projectNode),
        data: { type: 'folder', name },
      });
    }
  } else {
    roots.push(...overview.projects.map(projectNode));
  }

  if (overview.others.length > 0) {
    roots.push({
      id: 'others',
      label: 'Other Rojo servers',
      description: String(overview.others.length),
      tooltip: [],
      icon: { id: 'server-environment' },
      contextValue: 'rojo:others',
      collapsible: 'expanded',
      children: overview.others.map(serverNode),
      data: { type: 'others' },
    });
  }

  return roots;
}

/** Every node of a tree, depth first. */
export function flatten(nodes: readonly ViewNode[]): ViewNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}
