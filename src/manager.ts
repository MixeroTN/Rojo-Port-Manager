import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import {
  buildOverview,
  expectedProjectName,
  type Busy,
  type Overview,
  type ProjectEntry,
  type ProjectStatus,
} from './model/overview.ts';
import { pickPort, portsToProbe, type PortRange } from './model/ports.ts';
import { compareProjectFiles, isProjectFileName, parseProjectFile } from './model/projectFile.ts';
import {
  pathKey,
  portOwners,
  samePath,
  savedPort,
  setKnownPort,
  setSavedPort,
  type ServerRecord,
  type SharedState,
} from './model/state.ts';
import { StateStore } from './model/store.ts';
import { summarizeLog } from './rojo/logs.ts';
import { probePort, probePorts, type ProbeResult } from './rojo/probe.ts';
import type { RojoServerInfo } from './rojo/serverInfo.ts';
import { findListeners, isRojoProcess, killTree } from './rojo/system.ts';
import { buildServerEnv, displayArgument, type RojoLocation } from './rojo/tools.ts';

/** How long a start may take before it is given up. */
const START_TIMEOUT_MS = 60_000;
/** A record younger than this is kept while its port is still free: its server may still be starting. */
const STARTING_GRACE_MS = 120_000;
const MAX_PROJECT_FILE = 4 * 1024 * 1024;

export type StartResult =
  | { kind: 'ready'; info: RojoServerInfo }
  | { kind: 'exited'; code: number | null; reason: string }
  | { kind: 'timeout'; seconds: number; reason: string }
  | { kind: 'cancelled' }
  | { kind: 'spawnError'; message: string };

export type StopResult =
  | { kind: 'stopped' }
  /** Something else than a Rojo server answers on the port: nothing was ended. */
  | { kind: 'notRojo'; detail: string }
  /** A Rojo server answers, but no process named rojo listens on the port (another user's, or elevated). */
  | { kind: 'noProcess' }
  | { kind: 'stillRunning'; message: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readLog(file: string): string {
  try {
    const text = fs.readFileSync(file, 'utf8');

    return text.length > 64 * 1024 ? text.slice(-64 * 1024) : text;
  } catch {
    return '';
  }
}

function isYoung(record: ServerRecord, now: number): boolean {
  const started = Date.parse(record.startedAt);

  return !Number.isNaN(started) && now - started <= STARTING_GRACE_MS;
}

/**
 * Knows this window's project files, what listens on the Rojo ports, and the shared state; starts and stops servers.
 * The servers run detached from VS Code, so they outlive a reload or a closed window, and every window sees them.
 */
export class PortManager implements vscode.Disposable {
  private projects: ProjectEntry[] = [];
  private probes = new Map<number, ProbeResult>();
  private readonly busy = new Map<string, Busy>();
  private current: Overview = { projects: [], others: [] };
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;
  private probed = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  readonly store: StateStore;
  private readonly logsDir: string;
  private readonly log: vscode.LogOutputChannel;
  private readonly range: () => PortRange;

  constructor(storageDir: string, log: vscode.LogOutputChannel, range: () => PortRange) {
    this.store = new StateStore(nodePath.join(storageDir, 'state.json'));
    this.logsDir = nodePath.join(storageDir, 'logs');
    this.log = log;
    this.range = range;
  }

  get overview(): Overview {
    return this.current;
  }

  /** Whether the ports were probed at least once. */
  get ready(): boolean {
    return this.probed;
  }

  project(path: string): ProjectStatus | undefined {
    return this.current.projects.find((status) => samePath(status.project.path, path, process.platform));
  }

  /** Changes the shared state; a failed write is logged, and the state file stays as it was. */
  private update(change: (state: SharedState) => boolean | void): boolean {
    try {
      this.store.update(change);

      return true;
    } catch (error) {
      this.log.warn(`Could not write ${this.store.file}: ${errorText(error)}`);

      return false;
    }
  }

  /** Reads the project files at the roots of the workspace folders. */
  scanProjects(): void {
    const entries: ProjectEntry[] = [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') {
        continue;
      }

      const root = folder.uri.fsPath;
      let names: string[];

      try {
        names = fs
          .readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isFile() && isProjectFileName(entry.name))
          .map((entry) => entry.name)
          .sort(compareProjectFiles);
      } catch {
        continue;
      }

      for (const file of names) {
        const path = nodePath.join(root, file);
        let info;

        try {
          info =
            fs.statSync(path).size <= MAX_PROJECT_FILE ? parseProjectFile(fs.readFileSync(path, 'utf8')) : undefined;
        } catch {
          info = undefined;
        }

        entries.push({ path, folder: root, file, workspaceFolder: folder.name, info });
      }
    }

    this.projects = entries;
    this.recordServePorts();
    this.render();
  }

  /** Tells the other windows which ports this window's project files ask for, so they never give them away. */
  private recordServePorts(): void {
    const state = this.store.read();
    const changes = this.projects.filter((project) => {
      const wanted =
        savedPort(state, project.path, process.platform) === undefined ? project.info?.servePort : undefined;

      return state.known[project.path] !== wanted;
    });

    if (changes.length > 0) {
      this.update((fresh) => {
        let changed = false;

        for (const project of this.projects) {
          const saved = savedPort(fresh, project.path, process.platform);
          const wanted = saved === undefined ? project.info?.servePort : undefined;
          changed = setKnownPort(fresh, project.path, wanted, process.platform) || changed;
        }

        return changed;
      });
    }
  }

  /** Probes the ports again; calls during a refresh are folded into one more refresh. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;

      return this.refreshing;
    }

    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        await this.refreshOnce();
      } while (this.refreshAgain);
    })().finally(() => {
      this.refreshing = undefined;
    });

    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    const state = this.store.read();
    const extra = [
      ...Object.values(state.ports),
      ...Object.values(state.known),
      ...Object.values(state.servers).map((record) => record.port),
      ...this.projects.flatMap((project) => (project.info?.servePort === undefined ? [] : [project.info.servePort])),
    ];

    this.probes = await probePorts(portsToProbe(this.range(), extra));
    this.probed = true;
    this.settleRecords();
    this.render();
  }

  /**
   * Keeps the records of the servers the panel started true: forgets the ones whose server is gone (the port is free
   * after the grace time, or another session answers), and fills in the session of a record made before its server
   * answered. A slow or strange answer changes nothing.
   */
  private settleRecords(): void {
    const now = Date.now();
    const state = this.store.read();
    const verdicts = Object.values(state.servers).map((record) => {
      const probe = this.probes.get(record.port);

      if (probe?.state === 'free') {
        return { record, forget: !isYoung(record, now) };
      }

      if (probe?.state === 'rojo') {
        if (record.sessionId !== undefined) {
          return { record, forget: record.sessionId !== probe.info.sessionId };
        }

        if (record.projectName !== undefined && record.projectName === probe.info.projectName) {
          return { record, forget: false, session: probe.info.sessionId };
        }

        return { record, forget: true };
      }

      return { record, forget: false };
    });

    if (verdicts.some((verdict) => verdict.forget || verdict.session !== undefined)) {
      this.update((fresh) => {
        for (const verdict of verdicts) {
          const current = fresh.servers[String(verdict.record.port)];

          if (current?.pid !== verdict.record.pid) {
            continue;
          }

          if (verdict.forget) {
            delete fresh.servers[String(verdict.record.port)];
          } else if (verdict.session !== undefined && current.sessionId === undefined) {
            current.sessionId = verdict.session;
          }
        }
      });
    }
  }

  /** Builds the overview from what is known now and tells the listeners. */
  render(): void {
    this.current = buildOverview({
      projects: this.projects,
      probes: this.probed ? this.probes : new Map(),
      state: this.store.read(),
      busy: this.busy,
      logOf: (port) => {
        const file = this.logFile(port);

        return fs.existsSync(file) ? file : undefined;
      },
      platform: process.platform,
    });
    this.emitter.fire();
  }

  logFile(port: number): string {
    return nodePath.join(this.logsDir, `${port}.log`);
  }

  /** Marks an action on a project (by its path) or on a server (by `port:<n>`). */
  setBusy(key: string, busy: Busy | undefined): void {
    if (busy) {
      this.busy.set(key, busy);
    } else {
      this.busy.delete(key);
    }

    this.render();
  }

  projectBusyKey(project: ProjectEntry): string {
    return pathKey(project.path, process.platform);
  }

  /** The ports of other projects: saved or asked for (in any window), and the ports of this window's projects. */
  portOwners(except: string): Map<number, string> {
    const owners = portOwners(this.store.read(), except, (path) => fs.existsSync(path), process.platform);

    for (const status of this.current.projects) {
      if (
        status.port !== undefined &&
        !owners.has(status.port) &&
        !samePath(status.project.path, except, process.platform)
      ) {
        owners.set(status.port, status.project.path);
      }
    }

    return owners;
  }

  /** Saves a project's port. The port its file asks for (`servePort`) needs no saved copy. */
  savePort(project: ProjectEntry, port: number): void {
    const fromFile = port === project.info?.servePort;

    this.update((state) => {
      setSavedPort(state, project.path, fromFile ? undefined : port, process.platform);
      setKnownPort(state, project.path, fromFile ? port : undefined, process.platform);
    });
    this.render();
  }

  /** A free port of the range for a project without one; saved for it. */
  assignFreePort(project: ProjectEntry): number | undefined {
    const taken = new Set(this.portOwners(project.path).keys());

    for (const [port, probe] of this.probes) {
      if (probe.state !== 'free') {
        taken.add(port);
      }
    }

    for (const record of Object.values(this.store.read().servers)) {
      taken.add(record.port);
    }

    const port = pickPort(this.range(), taken);
    if (port !== undefined) {
      this.savePort(project, port);
    }

    return port;
  }

  /** Whether a start of this project on this port is still going on, in this or another window. */
  async isStarting(project: ProjectEntry, port: number): Promise<boolean> {
    const record = this.store.read().servers[String(port)];

    return (
      record !== undefined &&
      record.sessionId === undefined &&
      samePath(record.project, project.path, process.platform) &&
      isYoung(record, Date.now()) &&
      (await isRojoProcess(record.pid))
    );
  }

  /**
   * Starts `rojo serve` for a project on a port and waits until it answers. Rojo itself is started, detached and
   * without a console: it outlives VS Code, and no console window opens.
   */
  async startServer(
    project: ProjectEntry,
    port: number,
    rojo: RojoLocation,
    token: vscode.CancellationToken,
  ): Promise<StartResult> {
    const log = this.logFile(port);
    const args = ['serve', project.file, '--port', String(port)];
    const projectName = expectedProjectName(project);
    let output: number;

    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
      output = fs.openSync(log, 'w');
    } catch (error) {
      return { kind: 'spawnError', message: errorText(error) };
    }

    this.log.info(`${project.folder}> ${[rojo.path, ...args].map(displayArgument).join(' ')}`);

    let child: ChildProcess;
    try {
      child = spawn(rojo.path, args, {
        cwd: project.folder,
        env: buildServerEnv(process.env, { NO_COLOR: '1' }),
        detached: true,
        windowsHide: true,
        stdio: ['ignore', output, output],
      });
    } catch (error) {
      return { kind: 'spawnError', message: errorText(error) };
    } finally {
      fs.closeSync(output);
    }

    let exited: { code: number | null; error?: Error } | undefined;
    const exit = new Promise<void>((resolve) => {
      child.once('error', (error) => {
        exited ??= { code: null, error };
        resolve();
      });
      child.once('exit', (code) => {
        exited ??= { code };
        resolve();
      });
    });
    child.unref();

    const pid = child.pid;
    if (pid === undefined) {
      await exit;

      return { kind: 'spawnError', message: exited?.error?.message ?? 'no process id' };
    }

    const recorded = this.update((state) => {
      state.servers[String(port)] = {
        port,
        project: project.path,
        projectName,
        pid,
        startedAt: new Date().toISOString(),
        log,
      };
    });

    if (!recorded) {
      // A server the panel cannot record would be one it cannot tell apart later: end it.
      await killTree(pid, true);

      return { kind: 'spawnError', message: `the panel could not write ${this.store.file}` };
    }

    const deadline = Date.now() + START_TIMEOUT_MS;

    for (;;) {
      if (exited) {
        this.forget(port, pid);

        return exited.error
          ? { kind: 'spawnError', message: exited.error.message }
          : { kind: 'exited', code: exited.code, reason: summarizeLog(readLog(log)) };
      }

      if (token.isCancellationRequested) {
        await killTree(pid, true);
        this.forget(port, pid);

        return { kind: 'cancelled' };
      }

      const probe = await probePort(port, 1000);
      // Another project's server on the port means ours fails to bind it: it exits soon.
      if (probe.state === 'rojo' && !exited && probe.info.projectName === projectName) {
        this.update((state) => {
          const record = state.servers[String(port)];
          if (record?.pid === pid) {
            record.sessionId = probe.info.sessionId;
          }
        });

        return { kind: 'ready', info: probe.info };
      }

      if (Date.now() > deadline) {
        await killTree(pid, true);
        this.forget(port, pid);

        return { kind: 'timeout', seconds: START_TIMEOUT_MS / 1000, reason: summarizeLog(readLog(log)) };
      }

      await Promise.race([exit, delay(250)]);
    }
  }

  /**
   * Stops the Rojo server on a port. Only a process that listens on the port, is named rojo and belongs to a port
   * that answers as a Rojo server is ended: a recorded process id alone is never trusted.
   */
  async stopServer(port: number): Promise<StopResult> {
    const record = this.store.read().servers[String(port)];
    const before = await probePort(port);

    if (before.state === 'free') {
      if (record) {
        this.forget(port, record.pid);
      }

      return { kind: 'stopped' };
    }

    if (before.state === 'other') {
      return { kind: 'notRojo', detail: before.detail };
    }

    let listeners: number[] = [];
    try {
      listeners = (await findListeners()).get(port) ?? [];
    } catch (error) {
      this.log.warn(`Could not list the listening processes: ${errorText(error)}`);
    }

    const targets: number[] = [];
    for (const pid of listeners) {
      if (await isRojoProcess(pid)) {
        targets.push(pid);
      } else {
        this.log.warn(`Port ${port}: process ${pid} also listens, but it is not Rojo; it is left alone`);
      }
    }

    if (targets.length === 0) {
      return { kind: 'noProcess' };
    }

    const errors: string[] = [];
    for (const pid of targets) {
      this.log.info(`Stopping Rojo process ${pid} (port ${port})`);
      const error = await killTree(pid);
      if (error) {
        errors.push(error);
        this.log.warn(error);
      }
    }

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await probePort(port, 800)).state === 'free') {
        if (record) {
          this.forget(port, record.pid);
        }

        return { kind: 'stopped' };
      }

      await delay(200);
    }

    return { kind: 'stillRunning', message: errors.join(' ') };
  }

  private forget(port: number, pid: number): void {
    this.update((state) => {
      if (state.servers[String(port)]?.pid === pid) {
        delete state.servers[String(port)];
      }
    });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
