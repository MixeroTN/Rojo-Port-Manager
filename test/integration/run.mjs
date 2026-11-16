// Smoke test: starts VS Code with its own user data and extension folders (your own windows are not touched), opens a
// folder with a Rojo project file, and runs suite.cjs inside that window: VS Code must start the extension by itself,
// then it starts a real Rojo server from the panel, copies its port and stops it again. The servers get ports
// 34950-34960, away from the ones you use.
//
//   npm run build && npm run test:smoke -- <folder with a *.project.json> [--installed]
//   npm run build && npm run test:smoke -- --activation [--installed]
//
// The folder must pin Rojo for a tool manager (rokit.toml, aftman.toml) or have Rojo on PATH.
// --activation needs no folder and no Rojo: it opens an empty folder, checks that the panel waits, adds a project file
// and checks that the panel starts for it.
// By default it downloads VS Code Insiders into .vscode-test/ (independent of your own VS Code, which may refuse a
// second instance while it waits to install an update). --installed starts the installed VS Code instead, and
// VSCODE_EXECUTABLE names any other build.
import { runTests } from '@vscode/test-electron';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const activation = args.includes('--activation');
const folder = args.find((argument) => !argument.startsWith('--'));

if (
  !activation &&
  (!folder || !existsSync(folder) || !readdirSync(folder).some((name) => name.endsWith('.project.json')))
) {
  console.error('usage: npm run test:smoke -- <folder with a *.project.json> | --activation [--installed]');
  process.exit(2);
}

const requestedExecutable = process.env.VSCODE_EXECUTABLE;

function installedCode() {
  if (requestedExecutable) {
    return requestedExecutable;
  }

  if (!args.includes('--installed')) {
    return undefined;
  }

  const candidates =
    process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe')]
      : process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
        : ['/usr/share/code/code'];

  return candidates.find((candidate) => existsSync(candidate));
}

// Started from a VS Code terminal or extension, this process inherits variables that make Code.exe run as plain Node
// (ELECTRON_RUN_AS_NODE) or talk to the running window (VSCODE_IPC_HOOK_CLI...): the test window must not see them.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('ELECTRON_') || name.startsWith('VSCODE_')) {
    delete process.env[name];
  }
}

const extensionRoot = fileURLToPath(new URL('../..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'rojo-ports-smoke-'));
const resultFile = join(scratch, 'result.json');
const userData = join(scratch, 'user-data');
// --activation opens an empty folder of its own, which the scratch folder removes again.
const workspace = activation ? join(scratch, 'workspace') : resolve(folder);
let failed = false;

mkdirSync(join(userData, 'User'), { recursive: true });
writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({ 'rojoPorts.portRange': '34950-34960' }));
if (activation) {
  mkdirSync(workspace);
}

try {
  const executable = installedCode();

  await runTests({
    vscodeExecutablePath: executable,
    version: executable ? undefined : 'insiders',
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: fileURLToPath(new URL('./suite.cjs', import.meta.url)),
    extensionTestsEnv: {
      ROJO_PORTS_SMOKE_RESULT: resultFile,
      ROJO_PORTS_SMOKE_SCENARIO: activation ? 'activation' : 'server',
    },
    launchArgs: [
      workspace,
      '--disable-extensions',
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(scratch, 'extensions')}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
} catch (error) {
  failed = true;
  console.error(`smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (existsSync(resultFile)) {
  console.log(readFileSync(resultFile, 'utf8'));
}

rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
process.exit(failed ? 1 : 0);
