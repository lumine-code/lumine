# Session state

Lumine keeps an independent snapshot for each window and set of project roots. Saving the same window and project replaces its previous snapshot. A project index selects the latest snapshot to adopt when a new window opens that project.

Session schema version 2 stores snapshots and indexes in its own database tables. It has no reader or migration for the earlier package-state format; earlier tables are left untouched.

Separate snapshots let two windows keep their own pane layout and documents. An active window's snapshots for other projects remain available when it switches back, and restoring previous windows reuses their saved identities. Sessions without project folders are durable too: their private key uses the window identity, so unrelated empty windows do not share a snapshot.

## Project changes

`lumine.project.setState(paths)` shares one operation queue with automatic saves. It saves the outgoing session before confirming closure and captures changes made by Save or Save As during that confirmation. The final detached snapshot is both persisted and retained for rollback. Restoring a project replaces the workspace center while keeping docks and their retained buffers alive. Outgoing items finish their teardown before core switches project storage; incoming document recovery is hydrated before buffers and views are restored.

An in-place change restores the current window's own snapshot for the incoming project first. A window without its own history can adopt the most recently saved snapshot only while no other window has that project open.

Resetting or closing the window invalidates pending changes. Once an outstanding asynchronous step settles, the cancelled transition rejects with `ABORT_ERR` and releases any unused reservation. Requests queued before the reset are cancelled too; later requests wait for the old operation to finish before using the new generation.

Asynchronous workspace opens have their own lifetime. Resetting or destroying the workspace cancels preview, permanent and split opens, including requests still reading their saved location. A cancelled `workspace.open()` resolves to `undefined`; late opener-owned results are disposed while caller-supplied and already-attached items retain their ownership. Opens in the new generation do not wait for an obsolete URI request.

If restoration fails, rollback attempts to recover the outgoing documents and configuration. A single failure is returned unchanged. Additional rollback or reservation cleanup failures are reported together as an `AggregateError`, with the original failure first and as its `cause`. Automatic saves cannot capture the intermediate workspace, and remain blocked if document rollback fails. Snapshot writes use the roots carried by the detached snapshot, never a different project's paths read after asynchronous preparation; the snapshot and latest-project index are committed together.

## Retention

The application schedules cleanup after a window finishes loading, changes project roots or closes. A separate Node process reads the database so large historical snapshots do not block the renderer or the main event loop.

- Every snapshot belonging to an active or pending restored window is retained.
- The latest indexed snapshot for each project is retained.
- Snapshots containing unique unsaved or conflicted documents are retained, including documents owned by packages.
- Unknown or malformed state formats are retained until they can be interpreted safely.
- Other snapshots belonging to retired windows are removed. Unrelated records such as recent-project history are left intact.

An identical recovery snapshot can be removed only while the current indexed snapshot preserves the same complete state. Cleanup rechecks references and the stored snapshot before each deletion, so a concurrent save or adoption is retained.

Deletion runs in small transactions. Freed SQLite pages are reused by later saves; cleanup does not run a foreground database vacuum.

## Package storage

Package preferences and histories use the lifecycle context's `context.globalState` and `context.workspaceState` stores. Both are loaded before synchronous `initialize(context)` and `activate(context)` run. Core scopes keys to the owning package; global values are shared across the profile, while project values are shared by windows with the same project roots. Empty projects use the restored window identity. See [Package storage](package-storage.md) for the API and concurrency contract.

Scoped storage is independent of historical window snapshots. Restoring a session never overwrites a newer stored preference or rolls back changes committed by another window. Regenerable indexes, parsed variables and other derived data stay in memory and are rebuilt lazily.

## Package-owned documents

A package that owns document recovery data implements synchronous `serializeSessionState()` and `restoreSessionState(state)`. Core keeps these payloads under the owning package in the snapshot's `documentStates`, hydrates initialized registries before pane deserializers, and stages recovery for packages initialized later. A missing payload supplies `{}`. Restoration preserves shared registries and live model identities; it replaces the staged recovery data rather than recreating package panels. The same path handles startup, project changes and rollback.

Use this document contract for unsaved notebook cells, image pixels, table models, marker-layer references and document provenance. Preferences and histories belong exclusively in scoped storage. Packages with asynchronous snapshot preparation implement `prepareToSerialize(options)`; core awaits it before the synchronous document capture. Any failure rejects the snapshot rather than silently discarding unsaved work.
