# Session state

Lumine keeps an independent snapshot for each window and set of project roots. Saving the same window and project replaces its previous snapshot. A project index selects the latest snapshot to adopt when a new window opens that project.

Separate snapshots let two windows keep their own pane layout, editors and package settings. An active window's snapshots for other projects remain available when it switches back, and restoring previous windows reuses their saved identities.

## Project changes

`lumine.project.setState(paths)` runs changes sequentially in the current window. It saves the outgoing session before confirming closure and captures changes made by Save or Save As during that confirmation. Restoring a project replaces the workspace center while keeping docks and their retained buffers alive.

Resetting or closing the window invalidates pending changes. Once an outstanding asynchronous step settles, the cancelled transition rejects with `ABORT_ERR` and releases any unused reservation. Requests queued before the reset are cancelled too; later requests wait for the old operation to finish before using the new generation.

If restoration fails, rollback attempts to recover the outgoing documents and configuration. A single failure is returned unchanged. Additional rollback or reservation cleanup failures are reported together as an `AggregateError`, with the original failure first and as its `cause`.

## Retention

The application schedules cleanup after a window finishes loading, changes project roots or closes. A separate Node process reads the database so large historical snapshots do not block the renderer or the main event loop.

- Every snapshot belonging to an active or pending restored window is retained.
- The latest indexed snapshot for each project is retained.
- Snapshots containing unique unsaved or conflicted documents are retained, including documents owned by packages.
- Unknown or malformed state formats are retained until they can be interpreted safely.
- Other snapshots belonging to retired windows are removed. Unrelated records such as recent-project history are left intact.

An identical recovery snapshot can be removed only while the current indexed snapshot preserves the same complete state. Cleanup rechecks references and the stored snapshot before each deletion, so a concurrent save or adoption is retained.

Deletion runs in small transactions. Freed SQLite pages are reused by later saves; cleanup does not run a foreground database vacuum.

## Package state

Serialize preferences and the information required to recover actual unsaved work. Regenerable indexes, parsed variables, default layout slots and other derived data belong in memory. Defer rebuilding them until a document, command or service needs them.

A package's `serialize()` result is stored under its name in the window's `packageStates` and supplied to `activate(state)` when its main module starts. A package with preferences tied to restored documents can also export `restoreState(state)`. The editor awaits this optional hook on already-active package generations before restoring project buffers and workspace items, including when switching projects while keeping package panels alive. The hook receives `{}` when the incoming project has no saved state for that package. It must be idempotent, update its own state without reactivating the package, and preserve live panels unless its document state requires a refresh. A rejection causes an in-place project switch to restore the outgoing snapshot through the same hook.
