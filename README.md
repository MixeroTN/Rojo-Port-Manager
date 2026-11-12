# Rojo Port Manager

A VS Code extension that keeps your [Rojo](https://rojo.space) servers in order: which project is served on which
port, started and stopped from a panel, each project on a port that stays the same.

When you work on several Roblox games at once, every Studio window connects its Rojo plugin to its own `rojo serve`.
Ports collide, servers keep running in forgotten terminals, and you have to remember which port belongs to which
place. This extension shows all of it in one place and gives every project its own port.

## Features

- **A Rojo view in the Explorer** with every `*.project.json` at the root of your workspace folders, its port and its
  state: running, stopped, or the port taken by another server or program.
- **Start, Stop and Restart** from the view, the status bar or the Command Palette. The servers run in the background,
  without a console window and detached from VS Code: reloading or closing the window does not stop them, and every
  VS Code window sees them.
- **Ports that stay the same**: a project uses the `servePort` of its project file when it sets one. Otherwise the
  first Start picks the first free port from 34873 (34872 stays free for a plain `rojo serve`), and **Change Port…**
  sets any other. Ports are saved per project file for all windows, and no two projects get the same one; the
  project file is never changed.
- **Other Rojo servers**: the servers of other projects on this machine, also the ones started in a terminal, with
  their project names, so you can see what holds a port and stop it.
- **Conflicts**: when a project's port is taken, the view says by what. Start offers to stop the other server or to
  choose another port. When a server of the same project already runs outside the panel, Start offers to use its
  port instead of starting a second one.
- **The Rojo each project pins**: the version from the project's `rokit.toml`, `aftman.toml` or `foreman.toml` (or
  the global manifest of Rokit or Aftman), started from the tool manager's storage. `rojoPorts.rojoPath` names one
  executable for every project instead.
- **Copy Port** for the port field of the Rojo plugin in Studio, and **Show Server Log** for what the server printed.
- A status bar item with the port of the window's project, or how many of its projects are served.

## How it works

- **Finding servers.** Every 4 seconds while the window has the focus, the extension asks
  `http://127.0.0.1:<port>/api/rojo` on the ports of `rojoPorts.portRange` and on every port a project saved or asks
  for with `servePort`. A Rojo server answers with its project name, version and session (Rojo 7.7 in MessagePack,
  older versions in JSON). Nothing leaves your machine.
- **Starting.** The extension finds the Rojo version the project pins the way Rokit does (the closest manifest in the
  project folder or a parent folder), and starts that `rojo` executable from the storage of Rokit or Aftman, with its
  output in a log file. It does not go through the tool manager's shim: started in the background, a shim has no
  console, and the Rojo it starts would open a console window.
- **Knowing whose server it is.** The extension records the servers it starts (port, project file, process id,
  session) in a JSON file in VS Code's global storage, shared by all windows. A server it did not start counts as a
  project's server when it runs on that project's port and reports the same project name (and the same
  `servePlaceIds`, when both set them).
- **Stopping.** Stop ends only a process that listens on the port, is named `rojo`, and whose port has just answered
  as a Rojo server (found with `netstat` on Windows and `lsof` on macOS and Linux). Stopping a server that the
  extension did not start, or started for another project, asks first.

## Requirements

- VS Code 1.93 or newer.
- Rojo 7: the version a project pins, installed with Rokit or Aftman (`rokit install`), or `rojo` on `PATH`.
- A trusted workspace for starting servers, because Start runs the tools the project pins. The list of servers works
  in Restricted Mode too.

## Settings

| Setting                       | Default       | What it does                                                                   |
| ----------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `rojoPorts.portRange`         | `34872-34899` | Ports to look for servers on and to give new projects (at most 256).           |
| `rojoPorts.rojoPath`          | (empty)       | One `rojo` executable for every project; empty: the version each project pins. |
| `rojoPorts.statusBar.enabled` | `true`        | Show the status bar item.                                                      |

## Install

Download `rojo-port-manager-<version>.vsix` from the GitHub release, then run
`code --install-extension rojo-port-manager-<version>.vsix` or use **Extensions: Install from VSIX...** in VS Code.

## Development

Needs Node.js 22.18 or newer (the unit tests run the TypeScript sources directly).

```text
npm install
npm run build          # dist/extension.js
npm run watch          # rebuild on every change
npm run check          # type check, lint, format check, unit tests
npm run test:smoke     # a separate VS Code starts and stops a real Rojo server (see below)
npm run package        # release/rojo-port-manager-<version>.vsix
npm run icon           # media/icon.png from scripts/make-icon.mjs
```

Press F5 in VS Code ("Run Extension") to debug the extension in a second window.

- `src/model/`, `src/rojo/` (except `system.ts` and `probe.ts`, which run programs and open sockets) and
  `src/views/model.ts` have no `vscode` import, so the unit tests cover them in plain Node.
- `test/fixtures/` holds the real answers of Rojo 7.7.1 (MessagePack), 7.5.1 and 7.2.1 (JSON) for a test project.
- `npm run test:smoke -- <folder with a project file>` downloads VS Code Insiders into `.vscode-test/` the first time
  (`VSCODE_EXECUTABLE` names another build, `--installed` uses your VS Code), opens the folder with this extension and
  its own user data, starts a Rojo server from the panel on a port from 34950-34960, copies the port and stops it. The
  folder must be able to serve: it pins an installed Rojo version, or Rojo is on `PATH`.

## Release

The steps are at the top of `CHANGELOG.md`.

## License

[MIT](LICENSE). Not affiliated with the Rojo project.
