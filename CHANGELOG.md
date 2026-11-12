# Changelog

A release raises `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`, which also updates
`package-lock.json`), adds a dated entry here, runs `npm run check` and `npm run package`, is committed as "Release
rojo-port-manager <x.y.z>", and is tagged `v<x.y.z>` on that commit. Push both (`git push origin main v<x.y.z>`; a
plain `git push` leaves the tag behind), then attach `release/rojo-port-manager-<x.y.z>.vsix` to a GitHub release of
the tag, with this entry as its notes.

## 0.1.0 (2026-11-12)

First version.

- A Rojo view in the Explorer: the `*.project.json` files at the root of the workspace folders with their ports and
  states, and the other Rojo servers running on the machine.
- Start, Stop and Restart from the view, the status bar and the Command Palette. Servers run in the background
  without a console window and outlive VS Code; every window sees them.
- Ports that stay the same: the project's `servePort`, else the first free port from 34873, or one chosen with
  **Change Port…**. They are saved for all windows, and no two projects get the same port.
- Start runs the Rojo version the project pins (`rokit.toml`, `aftman.toml`, `foreman.toml`, or the global manifest
  of Rokit or Aftman) from the storage of Rokit or Aftman, and says how to install it when it is missing.
- Conflicts: a taken port says what holds it. Start offers to stop the other server, to choose another port, or to
  use the port of the project's own server that runs outside the panel.
- Stop ends only a `rojo` process that listens on the port, and asks first before it stops a server that the panel
  did not start.
- **Copy Port**, **Show Server Log**, and a status bar item.
