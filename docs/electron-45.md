# Electron 45

The editor pins Electron 45.2.1, Chromium 156.0.8078.75 and Node 24.22.1. The ordinary Node toolchain remains separate from Electron's embedded runtime. Update both Electron selectors in `package.json` and regenerate the lockfile with npm when advancing the runtime.

## Updates through 45.2.1

The [45.1.0 release](https://github.com/electron/electron/releases/tag/v45.1.0) fixes fetch rules for native protocol sources, ASAR path handling across main and child processes, malformed ASAR validation and repeated native menu popups on macOS. These fixes cover the editor's resource delivery and packaged execution paths without requiring API changes. Existing package-resource tests cover native assets, HEAD requests, Unicode paths, sandbox isolation and resources inside ASAR archives.

The [45.2.0 release](https://github.com/electron/electron/releases/tag/v45.2.0) improves bodyless fetch requests and repeated file URL fetches. Mutable package resources use this path through `session.fetch()`. DevTools saves also retain their chosen destination correctly. Menu highlight colors on Windows and additional Chrome extension APIs are optional additions; the update requires no change to the editor's current menu rendering or package services.

The [45.2.1 release](https://github.com/electron/electron/releases/tag/v45.2.1) updates Chromium to 156.0.8078.75 and backports Chromium fixes for native menu and sandboxed filesystem object lifetimes. Node remains at 24.22.1. The patch requires no Electron API migration in the editor.

## Window ownership

Electron owns desktop window geometry through named `windowStatePersistence`. Workspace snapshots retain document layout and persistent window identities, without duplicating native position, size, maximized or fullscreen state in renderer storage. Restarting a workspace in development mode reloads its existing native window; restoring the same auxiliary window identity reuses its presentation. Native window names must never overlap during replacement.

Auxiliary presentations explicitly use `sandbox: false` because they share the opener's models and DOM constructors. Electron 45 otherwise creates a separate sandboxed process and returns no scriptable child from `window.open()`. Notebook output remains in its separate opaque-origin sandbox.

Desktop sessions use persistent workspace partitions, retaining browser storage across restarts while keeping each workspace's package resource map independent. Tests, offscreen windows, captures and driven benchmarks use temporary sessions and disable native window persistence. `LUMINE_DISABLE_WINDOW_STATE_PERSISTENCE=1` applies that policy to an isolated capture process; it does not change the normal profile.

## Resources and tasks

[Package resources](package-resources.md) resolve through the exact loaded package generation. Fixed personal assets use Electron's native directory source. Mutable package routes use the modern protocol handler because replacing a native directory source does not update an already open renderer's source snapshot.

`lumine.application.createTaskProgress()` creates an owned reporter. `update({count, progress})` reports active tasks and an optional completion fraction from zero to one; omitting progress requests an indeterminate indicator. `dispose()` removes that reporter. Native progress is aggregated for the workspace's main and auxiliary windows, while the application badge counts work across workspaces. Renderer generation changes and crashes invalidate old reporters. The busy-signal package projects its existing service registry onto this API.

## Dynamic notebook frames

Chromium 156's `frame-sizing: content-height` and `window.requestResize()` were tested against actual opaque-origin frames on Windows during the migration. Static initial content sized correctly, but dynamic updates remained at the initial height despite repeated resize requests, including requests issued before layout. Notebook widgets initialize and change after the document loads, so the measured MessagePort height bridge remains necessary in this runtime. A renderer regression checks growth, shrinkage and height bounds without granting the child access to its parent document.

An output whose native host has disappeared retires its old iframe browsing context before the surrounding view moves into another window. Frame disposal cancels pending size work before awaiting widget cleanup.

## Packaged application checks

Windows builds rename Electron's WER helper to `Lumine_wer.dll` beside `Lumine.exe` before signing. The built-app check requires the renamed helper and compares critical runtime bytes with the build source, detecting inconsistent ASAR offsets or stale files. Build from a stable source snapshot: changing input sizes while an archive is being assembled can corrupt subsequent entries even when their names remain present.

Validate a packaged application as well as the source checkout. Electron 45's ASAR descriptors are usable through `fs`, but are not native file descriptors for addons, process stdio or transferred file handles. Existing unpack rules keep native binaries, ripgrep and spelling resources outside the archive.
