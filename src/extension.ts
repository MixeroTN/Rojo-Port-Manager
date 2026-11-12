import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { registerCommands, VIEW_ID } from './commands.ts';
import { PortManager } from './manager.ts';
import type { Overview } from './model/overview.ts';
import { parseRange } from './model/ports.ts';
import { getEnv, resolveRojo, type RojoResolution, type ToolLookup } from './rojo/tools.ts';
import { buildTree, type ViewNode } from './views/model.ts';
import { StatusBar } from './views/statusBar.ts';
import { RojoTreeProvider } from './views/tree.ts';

/** How often the ports are probed while the window has the focus. */
const REFRESH_MS = 4000;

/** What `activate` returns: used by the smoke test. */
export interface RojoPortsApi {
  overview(): Overview;
  nodes(): readonly ViewNode[];
  refresh(): Promise<void>;
  ready(): boolean;
}

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('rojoPorts').get<T>(key, fallback);
}

function isFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

function readFile(path: string): string | undefined {
  try {
    return fs.statSync(path).size <= 1024 * 1024 ? fs.readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function describeResolution(folder: string, resolution: RojoResolution): string {
  switch (resolution.kind) {
    case 'found': {
      const { location } = resolution;
      const pinned = location.manifest ? `, pinned in ${location.manifest}` : '';

      return `${folder}: rojo ${location.path} (${location.source}${pinned})`;
    }
    case 'notInstalled':
      return `${folder}: Rojo ${resolution.spec.version} pinned in ${resolution.manifest} is not installed`;
    case 'badEntry':
      return `${folder}: ${resolution.entry.manifest} pins "${resolution.entry.source}@${resolution.entry.version}", which cannot be resolved`;
    case 'badSetting':
      return `${folder}: rojoPorts.rojoPath names no file (${resolution.path})`;
    case 'missing':
      return `${folder}: no Rojo is pinned, and none is on PATH`;
  }
}

export function activate(context: vscode.ExtensionContext): RojoPortsApi {
  const log = vscode.window.createOutputChannel('Rojo Port Manager', { log: true });
  const range = () => parseRange(setting<unknown>('portRange', ''));
  const lookup = (): ToolLookup => ({
    platform: process.platform,
    env: process.env,
    homeDir: os.homedir(),
    isFile,
    readFile,
  });
  const lastResolution = new Map<string, string>();

  const findRojoFor = (folder: string): RojoResolution => {
    const resolution = resolveRojo(setting<unknown>('rojoPath', ''), folder, lookup());
    const message = describeResolution(folder, resolution);

    if (lastResolution.get(folder) !== message) {
      lastResolution.set(folder, message);
      if (resolution.kind === 'found') {
        log.info(message);
      } else {
        log.warn(message);
      }
    }

    return resolution;
  };

  /** `rokit install` or `aftman install`, for the tool manager that is installed. */
  const installCommand = (): string | undefined => {
    const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);
    const rokitRoot = getEnv(process.env, 'ROKIT_ROOT', process.platform);
    const rokitBins = [
      ...(rokitRoot ? [nodePath.join(rokitRoot, 'bin')] : []),
      nodePath.join(os.homedir(), '.rokit', 'bin'),
    ];

    if (rokitBins.some((folder) => isFile(nodePath.join(folder, exe('rokit'))))) {
      return 'rokit install';
    }

    return isFile(nodePath.join(os.homedir(), '.aftman', 'bin', exe('aftman'))) ? 'aftman install' : undefined;
  };

  const manager = new PortManager(context.globalStorageUri.fsPath, log, range);
  const tree = new RojoTreeProvider();
  const treeView = vscode.window.createTreeView<ViewNode>(VIEW_ID, { treeDataProvider: tree });
  const statusBar = new StatusBar();

  const render = () => {
    const { overview } = manager;

    tree.setRoots(buildTree(overview, (vscode.workspace.workspaceFolders?.length ?? 0) > 1));
    treeView.message =
      overview.projects.length === 0
        ? 'No Rojo project file (*.project.json) at the root of this workspace.'
        : undefined;
    statusBar.update(overview, setting('statusBar.enabled', true));
  };

  // Project files at the roots of the workspace folders: read again when one is added, changed or deleted.
  let watchers: vscode.Disposable[] = [];
  let scanTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleScan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      manager.scanProjects();
      void manager.refresh();
    }, 300);
  };

  const watchFolders = () => {
    for (const watcher of watchers) {
      watcher.dispose();
    }

    watchers = (vscode.workspace.workspaceFolders ?? []).map((folder) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '*.project.json'));

      return vscode.Disposable.from(
        watcher,
        watcher.onDidCreate(scheduleScan),
        watcher.onDidChange(scheduleScan),
        watcher.onDidDelete(scheduleScan),
      );
    });
  };

  // Other windows and terminals start and stop servers too: probe while this window has the focus.
  const timer = setInterval(() => {
    if (vscode.window.state.focused) {
      void manager.refresh();
    }
  }, REFRESH_MS);

  context.subscriptions.push(
    log,
    manager,
    tree,
    treeView,
    statusBar,
    { dispose: () => clearInterval(timer) },
    { dispose: () => clearTimeout(scanTimer) },
    {
      dispose: () => {
        for (const watcher of watchers) {
          watcher.dispose();
        }
      },
    },
    manager.onDidChange(render),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void manager.refresh();
      }
    }),
    treeView.onDidChangeVisibility((event) => {
      if (event.visible) {
        void manager.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      watchFolders();
      scheduleScan();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('rojoPorts')) {
        render();
        void manager.refresh();
      }
    }),
    registerCommands({
      manager,
      log,
      range,
      resolveRojo: findRojoFor,
      installCommand,
      extensionId: context.extension.id,
    }),
  );

  void vscode.commands.executeCommand('setContext', 'rojoPorts.active', true);
  watchFolders();
  manager.scanProjects();
  void manager.refresh();

  return {
    overview: () => manager.overview,
    nodes: () => tree.nodes,
    refresh: () => manager.refresh(),
    ready: () => manager.ready,
  };
}

export function deactivate(): void {
  // The servers keep running on purpose: they belong to the machine, not to this window.
}
