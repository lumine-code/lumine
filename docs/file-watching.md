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

`ready` resolves once observation is armed; attach listeners before awaiting it. An authoritative initial read after readiness closes the gap between constructing a document and starting observation. `dispose()` stops callbacks immediately, including during startup. `closed` resolves once owned observation resources are released, without waiting for a stalled filesystem metadata read; its late result is ignored. Disposing before readiness rejects `ready` with `ABORT_ERR`. Subscriptions returned by the three event methods are individually disposable.

Changes are batches of `{action, path}` entries with `created`, `updated` or `deleted` actions. Paths are absolute and retain the subscriber's spelling. Events are coalesced hints to read current state, not a history of filesystem operations. Atomic replacement remains an update at the same filename. The service does not apply project ignore rules.

Native content hints also cover writes that preserve file size and modification time. A simultaneous access-time or permissions change does not prove that contents stayed unchanged; ambiguous hints can therefore cause an extra reread. Reads alone do not produce a content update.

## Recovery

`onDidInvalidate` delivers `{path, reason, generation}` after observation has recovered from interrupted delivery. Changes in that interval are not replayed. Reread the affected state before relying on later deltas. Runtime errors retain their code, path and backend. The application retries worker failures with backoff while retaining subscription ownership.

For project consumers, use `project.onDidChangeFiles` and `project.onDidInvalidateFiles`. The latter names `rootPaths` instead of a single path. File discovery, repository state and document caches reconcile those roots. Language-server sessions affected by recovery restart once per recovery generation and receive their open documents again, including unsaved contents.

Delivery acknowledgements retry after a transport failure with bounded backoff and one pending retry per session. Queue overflow triggers invalidation even when the overflowing batch leaves no changes to deliver. Session shutdown attempts owner-level release even when an individual unsubscribe fails.

## Document moves

An external rename does not retarget a document or its watcher. The original path becomes missing and remains observed for recreation. Existing workspace policy determines whether an unmodified missing document closes; unsaved contents are preserved.

Documents participate in editor-initiated moves through `workspace.registerFileDocument({owner, getPath, setPath, beginFileOperation, endFileOperation})`. Register a shared model once rather than each view. Path updates must preserve edits, undo history and view state. The operation hooks defer filesystem reactions while disk changes are pending and reconcile after retargeting.

Before an editor-owned move, call `workspace.beginFileMove(plannedRenames)`. Complete its transaction with the actual successful `{oldPath, newPath, isDirectory}` effects, including partial results when an operation fails. An empty result releases guards after rollback. Copies, Save As and temporary implementation renames are not global document moves. Only the initiating workspace retargets its documents.

Custom TextBuffer data sources retain their own identity and stream transformations during moves when they provide `setPath(target)`, which may return a Promise. This method opts the source into workspace filesystem moves and must update its existing `getPath()` result. Core reattaches its notifications and emits one path change after relocation, including when the provider also emits `onDidRename`. Sources without `setPath` remain under their provider's relocation policy and are excluded from automatic filesystem moves.

## Ownership and platforms

The main process owns configuration subscriptions and renderer sessions; the worker alone loads the native addon. Reload or crash releases only that renderer session. An armed recursive directory source also serves subscriptions and location guards below it, preserving each subscriber's shallow or recursive scope. A broader recursive source takes over existing descendants after arming, and its readiness waits for their native handles to close. Shallow sources never take over recursive subscriptions or descendants they cannot observe.

The native library uses ReadDirectoryChangesW on Windows, inotify on Linux and FSEvents on macOS. There is no renderer `fs.watch`, polling backend, Watchman selection or public snapshot API. Root symlinks are resolved and revalidated; recursive observation does not traverse nested symlinks or junctions. Subscribe explicitly through such a path to observe its target.

Concurrent subscriptions share preliminary filesystem reads as well as physical sources. Those reads are retained only while pending. Within one plan, a directory used as both a location guard and a main binding reuses the metadata already read. Borrowing a covering source uses that plan's directory identities when available, while readiness still waits for native arming and retired descendant cleanup. Each subscription verifies its topology with fresh reads after its sources are armed, preserving detection of changes during startup.

On Windows, an open directory handle can prevent relocation of one of its ancestors even when the handle shares deletion access. Recursive source pooling avoids descendant handles inside an observed project, allowing its repositories to be renamed with files open. Moving an ancestor above the outermost observed source can still require releasing the affected observations first. The service does not watch an entire drive recursively to bypass this filesystem restriction.

## Git repository lifecycle

The repository registry reconciles filesystem changes by location and filesystem identity. Removing a repository invalidates its old descriptor, drops its routing and rejects queued operations before another provider can execute them. A new repository at the same path receives a fresh descriptor; stale reads and writes cannot silently switch to it. Case-only renames retain access when the filesystem still resolves the old spelling to the same identity.

| Change                                                           | Registry behavior                                                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `git init` or a recursive repository copy                        | Retries discovery when `HEAD`, `objects` and `refs` become available, including a marker delivered before its contents. |
| Deleting `.git`, `HEAD`, `objects` or `refs`                     | Removes unavailable repository state; restoring valid metadata permits fresh discovery.                                 |
| Moving or renaming a known repository inside an observed project | Removes the old location and discovers the destination, including condensed ancestor-directory events.                  |
| Copying a repository                                             | Keeps the source and destination as distinct filesystem identities.                                                     |
| Moving a repository outside every observed project               | Removes its old routing; opening the destination or adding it as a project permits discovery there.                     |
| Changing storage while discovery is pending                      | Discards results from the earlier topology instead of resurrecting an obsolete repository.                              |

Discovery of previously unknown repositories remains controlled by `git.watchDiscovery` and `git.watchDepth`. Fixed-path filesystem observation and Git rediscovery do not retarget externally moved documents or project roots. Editor-owned file moves use the transaction described above to preserve document state while reconciling repository locations.

Known Git object writes and ordinary ref traffic update the appropriate snapshots without repeating repository discovery. Concurrent candidate walks share pending filesystem reads; final identity reads and command preflight validation remain fresh.

## Diagnostics

Run the native observation benchmark from the editor repository to measure source sharing, readiness, event latency and explicit cleanup:

```sh
node benchmark/file-watch-benchmark.js
```

Repository event routing builds one fresh shared-metadata index per batch. Its construction visits each repository once and indexes its current metadata aliases; each distinct event directory then walks lexical path ancestors and the repositories that actually match them. Working-tree and private Git lookups use their existing ownership maps. This avoids scanning the entire repository fleet for each event directory while preserving enclosing repositories, submodules, worktrees and newly discovered metadata aliases without renderer filesystem reads.

The routing benchmark uses 128 and 512 synthetic repositories, including linked worktrees, and batches of 1000 and 8000 distinct working-tree or metadata directories. It reports entry visits, routing lookups and uninstrumented timing samples. Set `LUMINE_REPOSITORY_ROUTING_RUNS` to an integer from 1 to 10 to choose the sample count; the default is three. Deterministic routing-work bounds are covered by `spec/repository-routing-performance-spec.js`, while reported latency varies with the machine and concurrent load.

```sh
node benchmark/repository-routing-benchmark.js
node benchmark/repository-routing-benchmark.js --baseline <ref>
```

The optional baseline ref loads that revision's registry in memory using the same installed dependencies, fixture and measurement driver. It does not change the checkout or the running editor.
