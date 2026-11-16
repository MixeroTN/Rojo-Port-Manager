import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { registerCommands, VIEW_ID, type CommandContext } from './commands.ts';
import { PortManager } from './manager.ts';
import type { Overview } from './model/overview.ts';
import { parseRange } from './model/ports.ts';
import { findProjectFile } from './model/search.ts';
import { getEnv, resolveRojo, type RojoResolution, type ToolLookup } from './rojo/tools.ts';
import { buildTree, type ViewNode } from './views/model.ts';
import { StatusBar } from './views/statusBar.ts';
import { RojoTreeProvider } from './views/tree.ts';

/** How often the ports are probed while the window has the focus. */
const REFRESH_MS = 4000;
/** How long after the last change of a project file or a workspace folder the roots are read again. */
const CHANGE_DELAY_MS = 300;
/**
 * The search for a project file at the roots: how many tries, how long one read of a folder may take, and the wait
 * before the next try (0.5 seconds, doubling up to 5).
 */
const SEARCH_ATTEMPTS = 10;
const SEARCH_TIMEOUT_MS = 5000;
const searchDelay = (attempt: number): number => Math.min(500 * 2 ** (attempt - 2), 5000);

const NO_OVERVIEW: Overview = { projects: [], others: [] };

/** What `activate` returns: used by the smoke test. */
export interface RojoPortsApi {
  overview(): Overview;
  nodes(): readonly ViewNode[];
  refresh(): Promise<void>;
  ready(): boolean;
  /** Whether the panel runs: a project file was found, or a command ran. */
  started(): boolean;
}

/** The panel of a window: the view, the status bar and the probing of the ports. */
interface Panel {
  readonly manager: PortManager;
  readonly tree: RojoTreeProvider;
  readonly commands: CommandContext;
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

/** The names of the files at the root of a folder. */
async function filesAt(root: string): Promise<string[]> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });

  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
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

/** Starts the panel of this window: the Rojo view, the status bar, and the probing of the ports. */
function createPanel(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): Panel {
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

  // Other windows and terminals start and stop servers too: probe while this window has the focus.
  const timer = setInterval(() => {
    if (vscode.window.state.focused) {
      void manager.refresh();
    }
  }, REFRESH_MS);

  context.subscriptions.push(
    manager,
    tree,
    treeView,
    statusBar,
    { dispose: () => clearInterval(timer) },
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
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('rojoPorts')) {
        render();
        void manager.refresh();
      }
    }),
  );

  void vscode.commands.executeCommand('setContext', 'rojoPorts.active', true);
  manager.scanProjects();
  void manager.refresh();

  return { manager, tree, commands: { manager, log, range, resolveRojo: findRojoFor, installCommand } };
}

/**
 * VS Code starts the extension at once for a `default.project.json` (an exact name), and in every other window once
 * it has started. Until a project file is found at a root (or a command runs), the extension only watches the roots
 * for one: the panel, which probes the ports, starts then.
 */
export function activate(context: vscode.ExtensionContext): RojoPortsApi {
  const log = vscode.window.createOutputChannel('Rojo Port Manager', { log: true });
  let panel: Panel | undefined;
  let search: AbortController | undefined;

  // A restart of the extension host keeps the window's context keys: the view of an earlier host would stay, without
  // a tree, in a window where no project file is found now. It shows again when the panel starts.
  void vscode.commands.executeCommand('setContext', 'rojoPorts.active', false);
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let watchers: vscode.Disposable[] = [];

  const openPanel = (): Panel => {
    if (!panel) {
      search?.abort();
      search = undefined;
      panel = createPanel(context, log);
    }

    return panel;
  };

  /** Looks for a project file at the roots of the workspace folders; the panel starts when there is one. */
  const searchRoots = () => {
    search?.abort();
    const controller = new AbortController();
    search = controller;

    const roots = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath);

    findProjectFile(roots, {
      readDir: filesAt,
      attempts: SEARCH_ATTEMPTS,
      timeoutMs: SEARCH_TIMEOUT_MS,
      delayMs: searchDelay,
      signal: controller.signal,
      onRetry: (attempt, failures, delayMs) => {
        for (const failure of failures) {
          log.warn(
            `Could not read ${failure.root} (try ${attempt} of ${SEARCH_ATTEMPTS}): ${failure.reason}. Trying again in ${delayMs / 1000} seconds.`,
          );
        }
      },
    })
      .then((result) => {
        if (controller.signal.aborted || panel) {
          return;
        }

        search = undefined;
        switch (result.kind) {
          case 'found':
            log.info(
              `Found ${result.file} at the root of ${result.root}${result.attempt > 1 ? ` (try ${result.attempt})` : ''}: the Rojo panel starts.`,
            );
            openPanel();
            break;
          case 'none':
            log.info(
              'No Rojo project file (*.project.json) at the root of the workspace folders: the Rojo view appears when one is added.',
            );
            break;
          case 'failed':
            for (const failure of result.failures) {
              log.error(
                `Could not read ${failure.root} in ${result.attempts} tries (${failure.reason}): the Rojo view appears when a project file changes there, or after a reload.`,
              );
            }
            break;
          case 'cancelled':
            break;
        }
      })
      .catch((error: unknown) => {
        log.error(`The search for project files failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  /** A moment after the last change: the panel reads its project files again; without a panel, the roots are searched. */
  const scheduleCheck = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (panel) {
        panel.manager.scanProjects();
        void panel.manager.refresh();
      } else {
        searchRoots();
      }
    }, CHANGE_DELAY_MS);
  };

  // Project files at the roots of the workspace folders: one that is added, changed or deleted is noticed.
  const watchFolders = () => {
    for (const watcher of watchers) {
      watcher.dispose();
    }

    watchers = (vscode.workspace.workspaceFolders ?? []).map((folder) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '*.project.json'));

      return vscode.Disposable.from(
        watcher,
        watcher.onDidCreate(scheduleCheck),
        watcher.onDidChange(scheduleCheck),
        watcher.onDidDelete(scheduleCheck),
      );
    });
  };

  context.subscriptions.push(
    log,
    {
      dispose: () => {
        search?.abort();
        clearTimeout(changeTimer);
        for (const watcher of watchers) {
          watcher.dispose();
        }
      },
    },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      watchFolders();
      scheduleCheck();
    }),
    // A command starts the panel where it does not run yet, as the extension did when a command started it.
    registerCommands(log, context.extension.id, () => openPanel().commands),
  );

  watchFolders();
  searchRoots();

  return {
    overview: () => panel?.manager.overview ?? NO_OVERVIEW,
    nodes: () => panel?.tree.nodes ?? [],
    refresh: () => panel?.manager.refresh() ?? Promise.resolve(),
    ready: () => panel?.manager.ready ?? false,
    started: () => panel !== undefined,
  };
}

export function deactivate(): void {
  // The servers keep running on purpose: they belong to the machine, not to this window.
}
