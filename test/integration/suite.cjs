// Runs inside the VS Code window that run.mjs starts. Writes what it saw to ROJO_PORTS_SMOKE_RESULT and throws on
// failure. It starts a real Rojo server for the first project file, so the folder must be able to serve.
const fs = require('node:fs');
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

exports.run = async function run() {
  const result = { steps: [] };
  const check = (name, ok, detail) => result.steps.push({ name, ok: Boolean(ok), detail });
  let api;
  let projectPath;

  const current = () => api.overview().projects.find((status) => status.project.path === projectPath);
  const node = () => flatten(api.nodes()).find((candidate) => candidate.id === `project:${projectPath}`);

  try {
    const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON.name === 'rojo-port-manager');
    if (!extension) {
      throw new Error('rojo-port-manager is not loaded');
    }

    api = await extension.activate();
    await until(() => api.ready() && api.overview().projects.length > 0, 20_000, 'the first probe');

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
  } catch (error) {
    check('no error', false, error instanceof Error ? error.stack : String(error));
  }

  fs.writeFileSync(process.env.ROJO_PORTS_SMOKE_RESULT, `${JSON.stringify(result, null, 2)}\n`);

  if (result.steps.some((step) => !step.ok)) {
    throw new Error('smoke test failed');
  }
};
