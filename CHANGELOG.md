# Changelog

A release raises `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`, which also updates
`package-lock.json`), adds a dated entry here, runs `npm run check` and `npm run package`, is committed as "Release
rojo-port-manager <x.y.z>", and is tagged `v<x.y.z>` on that commit. Push both (`git push origin main v<x.y.z>`; a
plain `git push` leaves the tag behind), then attach `release/rojo-port-manager-<x.y.z>.vsix` to a GitHub release of
the tag, with this entry as its notes.
