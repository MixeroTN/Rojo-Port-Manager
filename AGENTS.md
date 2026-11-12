# AGENTS.md

Rojo Port Manager is a VS Code extension that lists, starts and stops Rojo servers, each project on its own port. It
is open source under the MIT license.

- Read `README.md` for what it does, how it finds and stops servers, and the commands; the release steps are at the
  top of `CHANGELOG.md`.
- Code, comments, docs, UI text and commit messages are in English. There are no translations: commands, menus and
  setting descriptions are written directly in `package.json`.
- Keep `src/model/`, `src/rojo/` (except `system.ts` and `probe.ts`) and `src/views/model.ts` free of `vscode`
  imports (type-only imports are fine): the unit tests run them in plain Node.
- Servers run detached and outlive VS Code on purpose. Start the pinned `rojo` executable itself, never a tool
  manager shim (a shim started without a console makes Rojo open a console window). Never end a process that is not
  proven to be the server: Stop ends only a listener of the port that is named `rojo`, right after the port answered
  as a Rojo server; a recorded process id is ended only while its start is still going on.
- Run programs without a shell (`execFile`, `spawn` with an argument list) and Windows' own tools by full path.
- Test data is neutral: no real game names, place ids or paths of a user's machine.
- Before finishing: `npm run check` (type check, lint, format check, unit tests) and `npm run build`. Run
  `npm run test:smoke -- <folder with a project file>` when starting, stopping, the view or the commands changed.
