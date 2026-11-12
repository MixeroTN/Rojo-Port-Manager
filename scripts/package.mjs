// Builds the VSIX into release/rojo-port-manager-<version>.vsix, the file attached to the GitHub release of that
// version (release/ is not committed).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const vsce = join(dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
const output = `release/${manifest.name}-${manifest.version}.vsix`;
const options = ['--no-dependencies', '--out', output];

if (!manifest.repository) {
  // Until the repository is set, vsce would stop and ask whether to continue, and could not turn the README's
  // relative links into links to the repository.
  options.push('--allow-missing-repository', '--no-rewrite-relative-links');
}

mkdirSync('release', { recursive: true });

// vsce runs `vscode:prepublish` (the production build) itself. It is started through Node: spawning a .cmd file
// without a shell fails on Windows.
execFileSync(process.execPath, [vsce, 'package', ...options], { stdio: 'inherit' });

const sha256 = createHash('sha256').update(readFileSync(output)).digest('hex');
console.log(`${output}: ${manifest.version}, sha256 ${sha256}`);
