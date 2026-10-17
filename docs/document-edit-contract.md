# Document edit contract

The document boundary separates native text ownership from editor policy. Superstring owns text, immutable patch payloads and prepared edits. The JavaScript buffer owns transactions, history grouping, marker updates and notification ordering. Language modes and parsers consume committed changes; they do not orchestrate a native mutation or infer its history representation.

## Preparing and committing

Every synchronous edit, undo, redo and checkpoint rollback uses a native prepared edit. Fresh edits use `prepareEdit(range, text)`; history replay uses `prepareEditFromChange(change)` to retain the patch's native text. Preparation does not mutate the buffer. Its value snapshot and independently mutable history patch share the same immutable native payload.

The lifecycle is prepare, inspect, commit, dispose. Commit is one-shot and validates the original native buffer generation. A stale edit throws rather than applying against a different document. `dispose()` is idempotent; the editor always calls it in `finally`, including when preparation notifications or commit fail. Metadata already returned to a caller remains a value snapshot after disposal. Prepared handles are internal to the mutation path and never become parser or event payloads.

The editor prepares display layers, commits the native edit, advances its public text revision, records the history patch and applied delta, updates markers and synchronously notifies language modes and display layers. Every observer of committed text therefore sees the new revision and text together. History providers accept `pushPatch(patch)` as synchronous bookkeeping; there is no provider-constructor test, `pushChange` adapter or second preparation argument. Providers must not mutate the document from this call.

`onWillChange` observers and synchronous edit notifications are read-only. Attempts to edit, undo or redo from these phases throw. Post-transaction observers may edit; applied batches from those edits are queued and delivered in application order. Empty transactions do not emit a pre-change notification. Aborting a transaction restores text and history, but its actual forward and inverse edits still appear in the applied stream.

## Coordinates and text

All indices and point columns count UTF-16 code units. Rows are zero-based and advance at LF. CRLF is retained, and unpaired surrogate code units are preserved. A backend adapter must explicitly translate units if it requires UTF-8 byte indices; it must not reinterpret these numbers as byte offsets.

Each applied change contains frozen `oldRange` and `newRange`, `oldText`, `newText`, `startIndex`, `oldEndIndex`, `newEndIndex` and `origin`. Its old coordinates address the document immediately before that change, after all preceding changes in the same batch. Its new coordinates address the document immediately after it. `oldEndIndex = startIndex + oldText.length` and `newEndIndex = startIndex + newText.length`. Replaying changes in order with these offsets reproduces the resulting text, including undo and reload.

Prepared edits that form CRLF across an edge include the adjacent line-ending units in their canonical range and text. History replay canonicalizes native patch geometry in the same way. File-load batches may report raw intermediate geometry, including the physical boundary between CR and LF; their indices retain that code unit. Consumers must not clip reported deltas to the final document and should use the offsets for exact text replay rather than reconstructing a change from the requested insertion range.

The applied stream differs deliberately from `onDidChangeText`: consolidated change ranges describe the transaction's before/after documents, while applied ranges describe each intermediate step. A parser's incremental edit input should use the applied stream.

## Revisions and parser consumers

`buffer.getTextRevision()` returns a monotonically increasing revision of that buffer's live text. Revisions are local state identities, not byte offsets, history entry IDs or a guarantee of one increment per transaction. Undo, redo, rollback and file loads that change text advance them; reloading unchanged text does not. A native preparation stamp is an internal validity guard and is not this public revision protocol.

`onDidApplyChanges` supplies `{ beforeRevision, afterRevision, changes, origin, isCurrent }`. The batch begins at `beforeRevision` and ends at `afterRevision`. Changes are ordered and immutable. File loads can apply a native patch atomically and then report its sequential deltas in one batch; consumers must not derive revision numbers for individual deltas. The origin is `edit`, `reload` or `mixed`, and each delta retains its own origin.

Native marker positions already reflect the committed text and any restored undo/redo marker snapshot when this batch is published. Individual display-marker notifications can arrive before or after the batch; a consumer's cached point is not necessarily current just because the native marker is. Consumers persisting a collection should read its final marker positions once per applied batch and retain any earlier change signal until then, rather than serialize the collection for every marker callback. Explicit marker moves without a text edit still use marker notifications and do not emit an applied text batch.

`isCurrent()` is true only while the live buffer is still at `afterRevision`. It becomes false after any later text mutation, even if the subscription has been disposed. A callback earlier in the same delivery may already have edited the document, so consumers must check it before reading the live text for the batch they are processing.

A parser tracks its last consumed revision, applies each delta in order and advances to `afterRevision`. If its revision does not equal `beforeRevision`, it must resynchronize from current text instead of guessing which edits were missed. A stale batch can still advance the parser's edit history, but reading/parsing the live buffer must wait for the matching current batch. Asynchronous parse results are published only if the captured text revision is still current.

`getText()`, `getTextInRange()` and line reads access current live text; receiving an immutable change batch does not freeze the buffer. The contract does not itself implement a Tree-sitter backend, grammar ownership, query scheduling or a snapshot reader. The existing Tree-sitter input cache uses the public revision accessor, and its edit adapter uses the offset supplied by core rather than recalculating a clipped point. A future node-tree-sitter implementation can consume this boundary without reading a private counter. History snapshots reconstruct their base text by replaying an inverse native patch through the same prepared-edit contract.
