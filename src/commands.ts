import * as vscode from 'vscode';
import type { PortManager, StartResult, StopResult } from './manager.ts';
import { servesProject, type ProjectStatus } from './model/overview.ts';
import { formatRange, parsePortInput, pickPort, ROJO_DEFAULT_PORT, type PortRange } from './model/ports.ts';
import { projectLabel } from './model/projectFile.ts';
import { samePath } from './model/state.ts';
import { probePort } from './rojo/probe.ts';
import type { RojoResolution } from './rojo/tools.ts';
import { shortPath, stateText, type ViewNode } from './views/model.ts';

export const VIEW_ID = 'rojoPorts.servers';

export interface CommandContext {
  manager: PortManager;
  log: vscode.LogOutputChannel;
  range: () => PortRange;
  /** The Rojo to start for a project folder. */
  resolveRojo: (folder: string) => RojoResolution;
  /** The command that installs the pinned tools (`rokit install`), when a tool manager is installed. */
  installCommand: () => string | undefined;
  extensionId: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The project of a tree node; without one, the only project of the window, or the one the user picks. */
async function resolveProject(context: CommandContext, node: ViewNode | undefined): Promise<ProjectStatus | undefined> {
  const { manager } = context;

  if (node?.data.type === 'project') {
    return manager.project(node.data.path);
  }

  const projects = manager.overview.projects;
  if (projects.length === 0) {
    void vscode.window.showErrorMessage('There is no Rojo project file in this window.');

    return undefined;
  }

  if (projects.length === 1) {
    return projects[0];
  }

  const picked = await vscode.window.showQuickPick(
    projects.map((status) => ({
      label: projectLabel(status.project.file),
      description: status.port === undefined ? stateText(status) : `:${status.port} · ${stateText(status)}`,
      detail: status.project.path,
      status,
    })),
    { placeHolder: 'Pick a project' },
  );

  return picked?.status;
}

/** A port to stop or copy: the tree node's; without one, the running server the user picks. */
async function resolvePort(
  context: CommandContext,
  node: ViewNode | undefined,
): Promise<{ port: number; project?: string } | undefined> {
  const { manager } = context;

  if (node?.data.type === 'server') {
    return { port: node.data.port };
  }

  if (node?.data.type === 'project') {
    const status = manager.project(node.data.path);

    return status?.port === undefined ? undefined : { port: status.port, project: status.project.path };
  }

  const running = [
    ...manager.overview.projects
      .filter((status) => status.state.kind === 'running' && status.port !== undefined)
      .map((status) => ({
        label: projectLabel(status.project.file),
        description: `:${status.port}`,
        port: status.port ?? 0,
        project: status.project.path,
      })),
    ...manager.overview.others.map((server) => ({
      label: server.info.projectName,
      description: `:${server.port} · ${server.record ? shortPath(server.record.project) : 'started outside the panel'}`,
      port: server.port,
      project: undefined,
    })),
  ];

  if (running.length === 0) {
    void vscode.window.showInformationMessage('No Rojo server is running.');

    return undefined;
  }

  const picked = await vscode.window.showQuickPick(running, { placeHolder: 'Pick a Rojo server' });

  return picked ? { port: picked.port, project: picked.project } : undefined;
}

async function showLogError(context: CommandContext, message: string, port: number): Promise<void> {
  context.log.error(message);

  if ((await vscode.window.showErrorMessage(message, 'Show Log')) === 'Show Log') {
    await vscode.window.showTextDocument(vscode.Uri.file(context.manager.logFile(port)), { preview: true });
  }
}

async function copyPort(port: number): Promise<void> {
  await vscode.env.clipboard.writeText(String(port));
  vscode.window.setStatusBarMessage(`$(copy) Port ${port} copied`, 3000);
}

/**
 * Stops the server on a port. With `confirm`, asks first when the panel did not start it, or started it for another
 * project than `expectedProject`. Returns whether the port is free now.
 */
async function stopPort(
  context: CommandContext,
  port: number,
  options: { confirm: boolean; expectedProject?: string },
): Promise<boolean> {
  const { manager } = context;

  if (options.confirm) {
    const probe = await probePort(port);
    const record = manager.store.read().servers[String(port)];

    if (probe.state === 'rojo') {
      const ownServer = record?.sessionId === undefined || record.sessionId === probe.info.sessionId;
      const question =
        !record || !ownServer
          ? `Stop the Rojo server of "${probe.info.projectName}" on port ${port}? It was started outside the panel, for example in a terminal.`
          : options.expectedProject !== undefined &&
              !samePath(record.project, options.expectedProject, process.platform)
            ? `Stop the Rojo server of "${probe.info.projectName}" on port ${port}? It serves ${record.project}.`
            : undefined;

      if (question && (await vscode.window.showWarningMessage(question, { modal: true }, 'Stop')) !== 'Stop') {
        return false;
      }
    }
  }

  const owner = manager.overview.projects.find((status) => status.port === port);
  const busyKey = owner ? manager.projectBusyKey(owner.project) : `port:${port}`;
  let result: StopResult;

  manager.setBusy(busyKey, 'stopping');
  try {
    result = await vscode.window.withProgress(
      { location: { viewId: VIEW_ID }, title: `Stopping the Rojo server on port ${port}…` },
      () => manager.stopServer(port),
    );
  } finally {
    manager.setBusy(busyKey, undefined);
  }

  await manager.refresh();

  switch (result.kind) {
    case 'stopped':
      vscode.window.setStatusBarMessage(`$(debug-disconnect) Rojo server on port ${port} stopped`, 4000);

      return true;
    case 'notRojo':
      void vscode.window.showErrorMessage(
        `Port ${port} is used by another program (${result.detail}), not by a Rojo server: it was left running.`,
      );

      return false;
    case 'noProcess':
      void vscode.window.showErrorMessage(
        `No Rojo process of yours listens on port ${port}: it may run as another user or as administrator.`,
      );

      return false;
    case 'stillRunning':
      void vscode.window.showErrorMessage(`The Rojo server on port ${port} is still running. ${result.message}`.trim());

      return false;
  }
}

/** Asks for a new port of a project and saves it; offers a restart when its server runs on the old one. */
async function changePortFor(context: CommandContext, status: ProjectStatus): Promise<number | undefined> {
  const { manager } = context;
  const { project } = status;
  const label = projectLabel(project.file);
  const owners = manager.portOwners(project.path);
  const suggestion = status.port ?? pickPort(context.range(), new Set(owners.keys()));

  const input = await vscode.window.showInputBox({
    title: `Port for ${label}`,
    prompt: 'The Rojo plugin in Studio connects to this port (1024-65535).',
    value: suggestion === undefined ? '' : String(suggestion),
    ignoreFocusOut: true,
    validateInput: (text) => {
      const port = parsePortInput(text);

      if (port === undefined) {
        return 'Type a port number from 1024 to 65535.';
      }

      const owner = owners.get(port);
      if (owner !== undefined) {
        return `Port ${port} belongs to ${shortPath(owner)}.`;
      }

      if (port === ROJO_DEFAULT_PORT) {
        return {
          message: 'A plain rojo serve without --port also uses 34872: the two would collide.',
          severity: vscode.InputBoxValidationSeverity.Warning,
        };
      }

      return undefined;
    },
  });

  const port = input === undefined ? undefined : parsePortInput(input);
  if (port === undefined || port === status.port) {
    return port;
  }

  const runningOn = status.state.kind === 'running' ? status.port : undefined;

  manager.savePort(project, port);
  await manager.refresh();

  if (runningOn !== undefined) {
    const choice = await vscode.window.showInformationMessage(
      `${label} is running on port ${runningOn}. Restart it on port ${port}?`,
      'Restart',
    );

    if (
      choice === 'Restart' &&
      (await stopPort(context, runningOn, { confirm: true, expectedProject: project.path }))
    ) {
      const fresh = manager.project(project.path);
      if (fresh) {
        await startProject(context, fresh);
      }
    }
  }

  return port;
}

/** Explains why no Rojo can be started for a project, with a way out when there is one. */
async function reportMissingRojo(context: CommandContext, resolution: RojoResolution, folder: string): Promise<void> {
  switch (resolution.kind) {
    case 'found':
      return;
    case 'notInstalled': {
      const command = context.installCommand();
      const message = `Rojo ${resolution.spec.version} (pinned in ${shortPath(resolution.manifest)}) is not installed.`;
      const choice = command
        ? await vscode.window.showErrorMessage(`${message} Run ${command} in the project folder.`, `Run ${command}`)
        : await vscode.window.showErrorMessage(`${message} Install it with the project's tool manager.`);

      if (command && choice) {
        const terminal = vscode.window.createTerminal({ name: 'Rojo tools', cwd: folder });
        terminal.show();
        terminal.sendText(command);
      }

      return;
    }
    case 'badEntry': {
      const { entry } = resolution;
      void vscode.window.showErrorMessage(
        `${shortPath(entry.manifest)} pins Rojo as "${entry.source}" version "${entry.version}", which the panel cannot find. Pin an exact version (author/name@x.y.z), or set rojoPorts.rojoPath.`,
      );

      return;
    }
    case 'badSetting':
    case 'missing': {
      const message =
        resolution.kind === 'badSetting'
          ? `The rojoPorts.rojoPath setting names no file: ${resolution.path}`
          : 'No Rojo version is pinned for this project (rokit.toml, aftman.toml or foreman.toml), and there is no Rojo on PATH.';

      if ((await vscode.window.showErrorMessage(message, 'Open Settings')) === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'rojoPorts.rojoPath');
      }

      return;
    }
  }
}

/**
 * Starts a project's server: gives it a port when it has none (or the port of its own server that runs outside the
 * panel), and handles a taken port.
 */
async function startProject(context: CommandContext, status: ProjectStatus): Promise<void> {
  const { manager } = context;
  const { project } = status;
  const label = projectLabel(project.file);

  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage(
      'Starting a server runs the Rojo that the project pins, so it works only in a trusted workspace.',
    );

    return;
  }

  if (!project.info) {
    void vscode.window.showErrorMessage(`${project.file} is not valid JSON, so Rojo cannot serve it.`);

    return;
  }

  if (status.busy) {
    void vscode.window.showInformationMessage(`${label} is ${status.busy} already.`);

    return;
  }

  if (status.port === undefined) {
    // Its own server may run outside the panel already (a plain rojo serve in a terminal): offer its port.
    const running = manager.overview.others.find(
      (server) =>
        (!server.record || samePath(server.record.project, project.path, process.platform)) &&
        servesProject(server.info, project),
    );

    if (running) {
      const use = `Use Port ${running.port}`;
      const choice = await vscode.window.showInformationMessage(
        `A Rojo server of "${running.info.projectName}" already runs on port ${running.port}, started outside the panel. Is it the server of ${label}?`,
        { modal: true },
        use,
        'Start Another Server',
      );

      if (choice === use) {
        manager.savePort(project, running.port);
        await manager.refresh();

        return;
      }

      if (choice === undefined) {
        return;
      }
    }
  }

  const port = status.port ?? manager.assignFreePort(project);
  if (port === undefined) {
    void vscode.window.showErrorMessage(
      `No free port is left in ${formatRange(context.range())}. Widen the rojoPorts.portRange setting.`,
    );

    return;
  }

  if (await manager.isStarting(project, port)) {
    void vscode.window.showInformationMessage(`${label} is starting already, maybe in another window.`);

    return;
  }

  const probe = await probePort(port);

  if (probe.state === 'rojo') {
    const record = manager.store.read().servers[String(port)];
    const ours = record ? samePath(record.project, project.path, process.platform) : servesProject(probe.info, project);

    if (ours) {
      void vscode.window.showInformationMessage(`${label} is already served on port ${port}.`);
      await manager.refresh();

      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Port ${port} is taken by the Rojo server of "${probe.info.projectName}". Stop it and start ${label} there?`,
      { modal: true },
      'Stop It and Start',
      'Choose Another Port',
    );

    if (choice === 'Choose Another Port') {
      if ((await changePortFor(context, status)) !== undefined) {
        const fresh = manager.project(project.path);
        if (fresh && fresh.port !== port) {
          await startProject(context, fresh);
        }
      }

      return;
    }

    if (choice !== 'Stop It and Start' || !(await stopPort(context, port, { confirm: false }))) {
      return;
    }
  } else if (probe.state === 'other') {
    const choice = await vscode.window.showErrorMessage(
      `Port ${port} is taken by another program (${probe.detail}).`,
      'Change Port…',
    );

    if (choice) {
      await changePortFor(context, status);
    }

    return;
  }

  const resolution = context.resolveRojo(project.folder);
  if (resolution.kind !== 'found') {
    await reportMissingRojo(context, resolution, project.folder);

    return;
  }

  const busyKey = manager.projectBusyKey(project);
  let result: StartResult;

  manager.setBusy(busyKey, 'starting');
  try {
    result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Starting Rojo for ${label} on port ${port}…`,
        cancellable: true,
      },
      (_progress, token) => manager.startServer(project, port, resolution.location, token),
    );
  } finally {
    manager.setBusy(busyKey, undefined);
  }

  await manager.refresh();

  switch (result.kind) {
    case 'ready':
      context.log.info(`Rojo ${result.info.serverVersion ?? ''} serves ${project.path} on port ${port}`);
      vscode.window.setStatusBarMessage(`$(radio-tower) Rojo serves ${label} on port ${port}`, 5000);
      break;
    case 'exited':
      await showLogError(
        context,
        result.reason === ''
          ? `Rojo did not start for ${label} (exit code ${result.code ?? '?'}).`
          : `Rojo did not start for ${label}: ${result.reason}`,
        port,
      );
      break;
    case 'timeout':
      await showLogError(
        context,
        `Rojo did not answer on port ${port} within ${result.seconds} seconds. ${result.reason}`.trim(),
        port,
      );
      break;
    case 'spawnError':
      context.log.error(`Rojo could not be started: ${result.message}`);
      void vscode.window.showErrorMessage(`Rojo could not be started: ${result.message}`);
      break;
    case 'cancelled':
      break;
  }
}

async function pick(context: CommandContext): Promise<void> {
  const { manager } = context;
  type Item = vscode.QuickPickItem & { run?: () => Promise<unknown> };
  const items: Item[] = [];

  for (const status of manager.overview.projects) {
    const label = projectLabel(status.project.file);
    const description = status.port === undefined ? stateText(status) : `:${status.port} · ${stateText(status)}`;
    const { port } = status;

    if (status.busy) {
      items.push({ label: `$(loading~spin) ${label}`, description });
    } else if (status.state.kind === 'running' && port !== undefined) {
      items.push(
        {
          label: `$(debug-stop) Stop ${label}`,
          description,
          run: () => stopPort(context, port, { confirm: true, expectedProject: status.project.path }),
        },
        { label: `$(copy) Copy port ${port}`, description: label, run: () => copyPort(port) },
      );
    } else if (status.project.info) {
      items.push({ label: `$(play) Start ${label}`, description, run: () => startProject(context, status) });
    }
  }

  if (manager.overview.others.length > 0) {
    items.push({ label: 'Other Rojo servers', kind: vscode.QuickPickItemKind.Separator });

    for (const server of manager.overview.others) {
      items.push({
        label: `$(debug-stop) Stop "${server.info.projectName}"`,
        description: `:${server.port}`,
        run: () => stopPort(context, server.port, { confirm: true }),
      });
    }
  }

  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: '$(list-tree) Show the Rojo panel',
      run: async () => {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      },
    },
  );

  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Rojo servers of this window' });
  await picked?.run?.();
}

export function registerCommands(context: CommandContext): vscode.Disposable {
  const { manager, log } = context;

  const handlers: Record<string, (node?: ViewNode) => Promise<unknown>> = {
    refresh: async () => {
      manager.scanProjects();
      await manager.refresh();
    },
    start: async (node) => {
      const status = await resolveProject(context, node);
      if (status) {
        await startProject(context, status);
      }
    },
    stop: async (node) => {
      const target = await resolvePort(context, node);
      if (target) {
        await stopPort(context, target.port, { confirm: true, expectedProject: target.project });
      }
    },
    restart: async (node) => {
      const status = await resolveProject(context, node);

      if (!status) {
        return;
      }

      if (status.state.kind !== 'running' || status.port === undefined) {
        await startProject(context, status);

        return;
      }

      if (await stopPort(context, status.port, { confirm: true, expectedProject: status.project.path })) {
        const fresh = manager.project(status.project.path);
        if (fresh) {
          await startProject(context, fresh);
        }
      }
    },
    copyPort: async (node) => {
      const target = await resolvePort(context, node);
      if (target) {
        await copyPort(target.port);
      }
    },
    changePort: async (node) => {
      const status = await resolveProject(context, node);
      if (status) {
        await changePortFor(context, status);
      }
    },
    showLog: async (node) => {
      const target = await resolvePort(context, node);
      const record = target === undefined ? undefined : manager.store.read().servers[String(target.port)];
      const status = node?.data.type === 'project' ? manager.project(node.data.path) : undefined;
      const file = record?.log ?? status?.log;

      if (file) {
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
      } else if (target !== undefined) {
        void vscode.window.showInformationMessage('There is no log for this server: the panel did not start it.');
      }
    },
    openProjectFile: async (node) => {
      const status = await resolveProject(context, node);
      if (status) {
        await vscode.window.showTextDocument(vscode.Uri.file(status.project.path));
      }
    },
    pick: () => pick(context),
    showOutput: () => {
      log.show();

      return Promise.resolve();
    },
    openSettings: async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extensionId}`);
    },
  };

  return vscode.Disposable.from(
    ...Object.entries(handlers).map(([name, handler]) =>
      vscode.commands.registerCommand(`rojoPorts.${name}`, async (node?: ViewNode) => {
        try {
          await handler(node);
        } catch (error) {
          log.error(`rojoPorts.${name}: ${errorText(error)}`);
          void vscode.window.showErrorMessage(`Rojo Port Manager: ${errorText(error)}`);
        }
      }),
    ),
  );
}
