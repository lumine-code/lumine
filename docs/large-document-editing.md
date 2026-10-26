# Large document editing

Large-document editing is independent of grammar selection. None disables syntax analysis; it does not replace the text model or disable text search, editing, undo, recovery or file operations. The automatic grammar threshold remains documented in [Large files and grammars](large-files-and-grammars.md).

## View policy

With `editor.largeFileOptimizations` enabled, documents containing at least 32 Mi UTF-16 units or 300,000 buffer lines use an unwrapped view by default. Once active, that policy remains until both dimensions fall below half their entry thresholds, so editing near a threshold does not repeatedly rebuild the projection. The setting does not change document contents or its grammar. Auto-height and mini editors keep their existing sizing policy.

Toggle Soft Wrap explicitly to enable wrapping in an individual large document. That choice survives splits and session restoration; splits may subsequently choose different wrapping. Explicit wrapping retains exact layout semantics and can require processing preceding text to establish a distant screen row. It therefore has a different cost from the default direct row projection. `maxScreenLineLength` remains the safety wrapping policy for ordinary views; large unwrapped views protect rendering with bounded horizontal windows instead.

## Coordinates and presentation

Document positions and scroll offsets remain logical values. CSS receives a bounded local coordinate space; text tiles, gutters, highlights, cursors, input anchors and overlays share its origin. Native scrollbar extents are bounded and mapped to the logical scroll range. Wheel and keyboard movement retains logical precision, while dragging the native thumb maps its available physical resolution to the whole document.

Unwrapped geometry stores folds as exceptions rather than allocating an entry for every line. Measured row metadata uses a balanced sequence supporting local splices and subtree maxima, and rendered screen-line objects live in a bounded cache. Exact exhaustive width queries remain distinct from the approximate width used to show a viewport.

Very long unwrapped rows render bounded horizontal windows. Logical buffer/screen columns remain unchanged, including tabs, fold markers and UTF-16 boundaries. Visible glyphs are measured using the DOM; shared anchors preserve their positions when windows overlap, including shaped Unicode. Pixel positions in an unmounted portion of such a line are estimates until that portion is rendered. Consumers positioning visible overlays should request positions for the rendered target and refresh after layout. Code needing document coordinates should retain buffer ranges rather than storing estimated pixel offsets.

Gutter foldability checks in None read bounded indentation prefixes instead of entire lines. Pathological whitespace prefixes or long gaps can omit a fold indicator during incidental rendering; explicit indentation-fold commands retain exact semantics.

Automatic selection consumers check range metadata before reading text. `InputDialog.setQueryFromSelection()` uses the last selection only when it stays on one buffer line and contains at most 4,096 UTF-16 units; otherwise the existing query remains unchanged. On Linux, automatic PRIMARY clipboard updates accept at most 1 Mi UTF-16 units from the last selection. A larger gesture cancels an older pending update and preserves the existing PRIMARY contents. These limits do not change explicit Copy commands or the selected document content.

## Search and bulk edits

[Large document search](large-document-search.md) documents snapshot queries, progress, cancellation, bounded result presentation, atomic replacements and regex limits. Counts and navigation are separate from presentation markers. A partial count is not an exact total, and a presentation limit must never become an implicit Replace All limit.

Change events expose source snapshots as non-enumerable `oldTextSource` and `newTextSource`. Their legacy string properties remain available for bounded changes. `TextBuffer.canMaterializeText(maxLength)` checks both a caller's budget and the runtime limit before requesting a full string. Prefer `getTextSnapshot()` and bounded reads when size is unknown. An oversized explicit string read fails before allocation with `ERR_TEXT_MATERIALIZATION_LIMIT`.

Text transactions finalize modified state and marker/display notifications even when an observer fails after publication. Atomic replacement reports a committed observer failure explicitly, so a caller does not mistake an already-applied edit for an operation that left the document unchanged. Undo remains available.

## Recovery and external changes

Session capture retains immutable text roots. [Session storage](session-state.md) persists bounded content-addressed nodes and publishes root references atomically after the nodes are durable. Subsequent edits reuse unchanged nodes, including history. Periodic autosaves retain undo/redo as well as unsaved text. Cancellation or an interrupted publication cannot replace a previously valid session with an incomplete snapshot.

Fine-grained diffs have allocation and computation budgets. A large difference can use exact shared text in a coarser patch rather than flattening both documents before reaching a timeout. Recovery and reload must preserve the distinction between a saved base, current text and an external file change; a cheaper diff is not permission to lose content or silently overwrite the file.

## Validation

Structural tests cover sparse multi-million-row edits, persistent sequence invariants, split geometry, folds, CRLF and surrogate boundaries. Renderer tests exercise physical CSS limits on both axes, long-line selections/cursors/IME, Unicode window transitions and direct hit testing. Search tests include documents exceeding the runtime's maximum string length, dense counts, cancellation, regex deadlines, actual replacement geometry and observer failures. Recovery tests include interrupted publication, concurrent references, lease cleanup, corrupt metadata, file conflicts and large undo history.

Performance measurements should use a separate profile, production rendering schedules and unchanged input hashes. Record command time separately from frame callbacks, first result separately from complete counts, and initial recovery storage separately from incremental updates. CPU profiles are diagnostic runs rather than acceptance timings. Local measurements do not establish cross-platform correctness; the regular Windows, Linux and macOS suites remain required.
