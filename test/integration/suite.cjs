// Runs inside the VS Code window that run.mjs starts. Writes what it saw to ROJO_PORTS_SMOKE_RESULT and throws on
// failure. ROJO_PORTS_SMOKE_SCENARIO picks what it does:
// - "server": starts a real Rojo server for the first project file, so the folder must be able to serve.
// - "activation": the folder has no project file at first; one is added, and the panel must start for it.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function until(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = check();
    if (value) {
      return value;
    }

    await wait(200);
  }

  throw new Error(`timed out waiting for ${what}`);
}

function flatten(nodes) {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** The API of the extension once VS Code has started it by itself, from its activation events. */
async function startedByVsCode(check) {
  const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON.name === 'rojo-port-manager');
  if (!extension) {
    throw new Error('rojo-port-manager is not loaded');
  }

  await until(() => extension.isActive, 60_000, 'VS Code to start the extension');
  check('started by VS Code', true, extension.packageJSON.activationEvents.join(', '));

  return extension.exports;
}

async function server(check) {
  const api = await startedByVsCode(check);
  let projectPath;

  const current = () => api.overview().projects.find((status) => status.project.path === projectPath);
  const node = () => flatten(api.nodes()).find((candidate) => candidate.id === `project:${projectPath}`);

  await until(() => api.ready() && api.overview().projects.length > 0, 30_000, 'the first probe');

  const [first] = api.overview().projects;
  projectPath = first.project.path;
  check('project file found', true, first.project.file);
  check('state known', first.state.kind !== 'unknown', first.state.kind);

  const commands = await vscode.commands.getCommands(true);
  const missing = ['start', 'stop', 'restart', 'copyPort', 'changePort', 'showLog', 'pick'].filter(
    (name) => !commands.includes(`rojoPorts.${name}`),
  );
  check('commands registered', missing.length === 0, missing.join(', ') || 'all');

  await vscode.commands.executeCommand('rojoPorts.start', node());
  const running = await until(
    () => (current()?.state.kind === 'running' ? current() : undefined),
    90_000,
    'the server to run',
  );

  check(
    'started by the panel',
    running.state.startedByPanel,
    `port ${running.port}, Rojo ${running.state.server.serverVersion}`,
  );
  check('port from the range', running.port >= 34950 && running.port <= 34960, String(running.port));
  check('port saved', running.portSource === 'saved' || running.portSource === 'projectFile', running.portSource);
  check('log written', running.log && fs.existsSync(running.log), running.log);
  check('menus while running', node().contextValue.includes('+stop'), node().contextValue);

  await vscode.commands.executeCommand('rojoPorts.copyPort', node());
  const clipboard = await vscode.env.clipboard.readText();
  check('port copied', clipboard === String(running.port), clipboard);

  await vscode.commands.executeCommand('rojoPorts.stop', node());
  const stopped = await until(
    () => (current()?.state.kind === 'stopped' ? current() : undefined),
    30_000,
    'the server to stop',
  );

  check('stopped', stopped.state.kind === 'stopped', stopped.state.kind);
  check('menus while stopped', node().contextValue.includes('+start'), node().contextValue);
  check('same port kept', stopped.port === running.port, String(stopped.port));
}

async function activation(check) {
  const api = await startedByVsCode(check);
  const [folder] = vscode.workspace.workspaceFolders ?? [];
  if (!folder) {
    throw new Error('no workspace folder');
  }

  // The search of the roots takes a moment; without a project file the panel must not start.
  await wait(3000);
  check('panel waits without a project file', !api.started() && api.overview().projects.length === 0, 'no panel');

  const commands = await vscode.commands.getCommands(true);
  check('commands registered before the panel', commands.includes('rojoPorts.pick'), 'rojoPorts.pick');

  const file = 'smoke.project.json';
  fs.writeFileSync(
    path.join(folder.uri.fsPath, file),
    `${JSON.stringify({ name: 'smoke', tree: { $className: 'DataModel' } }, null, 2)}\n`,
  );

  await until(
    () => api.started() && api.ready() && api.overview().projects.length > 0,
    30_000,
    'the panel to start for the new project file',
  );
  const [first] = api.overview().projects;
  check('panel started for the added file', first.project.file === file, first.project.file);
  check('state known', first.state.kind !== 'unknown', first.state.kind);
}

exports.run = async function run() {
  const result = { scenario: process.env.ROJO_PORTS_SMOKE_SCENARIO ?? 'server', steps: [] };
  const check = (name, ok, detail) => result.steps.push({ name, ok: Boolean(ok), detail });

  try {
    await (result.scenario === 'activation' ? activation(check) : server(check));
  } catch (error) {
    check('no error', false, error instanceof Error ? error.stack : String(error));
  }

  fs.writeFileSync(process.env.ROJO_PORTS_SMOKE_RESULT, `${JSON.stringify(result, null, 2)}\n`);

  if (result.steps.some((step) => !step.ok)) {
    throw new Error('smoke test failed');
  }
};
