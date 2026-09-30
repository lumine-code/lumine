# Session state

Lumine keeps an independent snapshot for each window and set of project roots. Saving the same window and project replaces its previous snapshot. A project index selects the latest snapshot to adopt when a new window opens that project.

Separate snapshots let two windows keep their own pane layout, editors and package settings. An active window's snapshots for other projects remain available when it switches back, and restoring previous windows reuses their saved identities.

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
