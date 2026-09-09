# File watching

Lumine observes fixed filesystem paths through one native worker shared by the application and its editor windows.

## Public API

Import `watchFile` and `watchDirectory` from `lumine`. Both return a `FileWatchHandle` synchronously. `watchDirectory(path)` observes the directory and its immediate children; pass `{recursive: true}` to observe descendants. Missing targets remain observed through existing ancestors and become active at the requested location when created.

```js
const { watchFile } = require("lumine");
const handle = watchFile(configPath);
handle.onDidChange(() => reloadConfiguration());
handle.onDidInvalidate(() => reloadConfiguration());
handle.onDidError((error) => reportWatchFailure(error));
await handle.ready;
await reloadConfiguration();

// During teardown:
handle.dispose();
await handle.closed;
```

`ready` resolves once observation is armed; attach listeners before awaiting it. An authoritative initial read after readiness closes the gap between constructing a document and starting observation. `dispose()` stops callbacks immediately, including during startup. `closed` resolves once owned resources are released. Disposing before readiness rejects `ready` with `ABORT_ERR`. Subscriptions returned by the three event methods are individually disposable.

Changes are batches of `{action, path}` entries with `created`, `updated` or `deleted` actions. Paths are absolute and retain the subscriber's spelling. Events are coalesced hints to read current state, not a history of filesystem operations. Atomic replacement remains an update at the same filename. The service does not apply project ignore rules.

## Recovery

`onDidInvalidate` delivers `{path, reason, generation}` after observation has recovered from interrupted delivery. Changes in that interval are not replayed. Reread the affected state before relying on later deltas. Runtime errors retain their code, path and backend. The application retries worker failures with backoff while retaining subscription ownership.

For project consumers, use `project.onDidChangeFiles` and `project.onDidInvalidateFiles`. The latter names `rootPaths` instead of a single path. File discovery, repository state and document caches reconcile those roots. Language-server sessions affected by recovery restart once per recovery generation and receive their open documents again, including unsaved contents.

## Document moves

An external rename does not retarget a document or its watcher. The original path becomes missing and remains observed for recreation. Existing workspace policy determines whether an unmodified missing document closes; unsaved contents are preserved.

Documents participate in editor-initiated moves through `workspace.registerFileDocument({owner, getPath, setPath, beginFileOperation, endFileOperation})`. Register a shared model once rather than each view. Path updates must preserve edits, undo history and view state. The operation hooks defer filesystem reactions while disk changes are pending and reconcile after retargeting.

Before an editor-owned move, call `workspace.beginFileMove(plannedRenames)`. Complete its transaction with the actual successful `{oldPath, newPath, isDirectory}` effects, including partial results when an operation fails. An empty result releases guards after rollback. Copies, Save As and temporary implementation renames are not global document moves. Only the initiating workspace retargets its documents.

Custom TextBuffer data sources retain their own identity and stream transformations during moves when they provide `setPath(target)`, which may return a Promise. This method opts the source into workspace filesystem moves and must update its existing `getPath()` result. Core reattaches its notifications and emits one path change after relocation, including when the provider also emits `onDidRename`. Sources without `setPath` remain under their provider's relocation policy and are excluded from automatic filesystem moves.

## Ownership and platforms

The main process owns configuration subscriptions and renderer sessions; the worker alone loads the native addon. Reload or crash releases only that renderer session. Physical directory sources are shared by canonical path and recursion mode; shallow sources never take over recursive subscriptions or descendants they cannot observe.

The native library uses ReadDirectoryChangesW on Windows, inotify on Linux and FSEvents on macOS. There is no renderer `fs.watch`, polling backend, Watchman selection or public snapshot API. Root symlinks are resolved and revalidated; recursive observation does not traverse nested symlinks or junctions. Subscribe explicitly through such a path to observe its target.
