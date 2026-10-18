# JavaScript document core

The running editor now owns its text entirely in JavaScript. `TextBuffer` uses `TextStore`, persistent `PieceTree` snapshots, JavaScript spatial patches and a JavaScript marker index. Superstring is a development-only reference for differential tests and native benchmarks; it is not loaded by the document runtime. Tree-sitter continues to run through the existing WASM adapter. The migration is preproduction work. Local implementation checkpoints are committed; dependency repins and publication are separate steps.

## Ownership

| Component                                          | Responsibility                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `piece-tree.js`                                    | Immutable text roots, UTF-16 coordinates, bounded readers and indexed line lookup.       |
| `document-core.js`                                 | Private drafts, validated atomic publication and optional standalone root history.       |
| `text-store.js`                                    | Prepared edits, saved-base identity, decoding/encoding, file snapshots and regex search. |
| `text-patch.js`, `change-tree.js`                  | Composed text deltas and display geometry in persistent balanced trees.                  |
| `marker-index.js`                                  | Interval queries, invalidation and lazy translation of marker suffixes.                  |
| `text-buffer.js`, `default-history-provider.js`    | Public editor policy, notifications, undo grouping and marker/selection history.         |
| `tree-sitter-document.js`, `tree-sitter-parser.js` | Revision journals, immutable parser sources and WASM input callbacks.                    |

`TextStore` disables `DocumentCore`'s standalone history: the editor history provider is the single owner of user-visible undo and redo. This avoids retaining a second undo stack. The public TextBuffer transaction and notification contract remains intact for package compatibility. Kernel drafts publish atomically; an outer editor transaction can still publish sequential internal edits before its consolidated change event. See [Document edit contract](document-edit-contract.md).

## Text and geometry

The storage design takes inspiration from VS Code's piece tree, with no copied VS Code source. Text lives in indexed buffers and pieces refer to their ranges. Lumine uses a persistent AVL tree: an edit copies affected search paths, while a snapshot retains the root without enumerating pieces. Adjacent ranges of one buffer can coalesce; small pieces from different buffers merge with bounded copying to avoid one leaf per typed character.

Buffers hold at most 32768 UTF-16 units and typed LF/astral indexes. Subtree summaries retain length, line count, trailing column and astral-character presence. CRLF, lone CR, NUL and unpaired surrogates are preserved. Only LF advances the row. Storage offsets can address the physical boundary inside CRLF; cursor clipping and normalization belong to TextStore/TextBuffer. The parser reader handles a surrogate pair split across pieces.

`replace` and `subtext` share immutable pieces. `slice`, `toString` and public string APIs explicitly materialize text. Snapshot capture, ordinary incremental edits and parser callbacks do not flatten the document. TextStore caches up to 256 line-bound records and one materialized line for repeated display/cursor reads; every committed edit and reset invalidates them. String backing-store retention remains dependent on V8; bounded pieces do not guarantee that V8 releases every deleted portion of a backing string.

`ChangeTree` stores ordered geometry changes with lazy old/new coordinate translations, so insertion near the start does not rewrite every later wrap or fold record. Patch copies retain persistent roots. `MarkerIndex` is an augmented interval treap with lazy suffix translation and packed range operations. Stored marker coordinates are finite nonnegative integers; query probes support clipping and infinity. Cross-layer marker comparison uses ranges, because an ID in one layer is not an ID in another.

## Package-facing reads and edit plans

`TextBuffer.getTextSnapshot()` is now public. It returns immutable text with UTF-16 indexed reads, bounded chunks, a `lines(startRow, endRow)` iterator and a `lineReader()` function for sequential rows with indexed jumps. Consumers can retain it across edits and undo. Display geometry uses the sequential reader; Log Filter streams lines, and Code Format validates sparse edits with snapshot character reads instead of flattening the document.

`TextBuffer.setTextInIndependentRanges(edits, { expectedRevision })` accepts one single-line edit per row, in any order. It validates the complete plan before mutation, rejects repeated rows and line-ending replacements, filters identities, and rejects a stale optional revision. The batch is one undo operation. Large batches prepare one persistent text root, preserve unchanged pieces and invalidate display geometry once; custom range trackers that need intermediate text retain the scalar callback path. This is an explicit package contract, not an undocumented performance hint.

The saved-base patch and user history remain granular even when storage commits one root. Sparse batches no longer flatten the document or fall back merely because most of the source is unchanged. Whitespace uses this API for trimming and indentation conversion, including grouping multiple tab replacements on the same row.

```js
const revision = buffer.getTextRevision();
const snapshot = buffer.getTextSnapshot();
const edits = [];
let row = 0;
for (const line of snapshot.lines()) {
  const trimmed = line.replace(/[ \t]+$/, "");
  if (trimmed !== line) {
    edits.push({
      range: [
        [row, trimmed.length],
        [row, line.length],
      ],
      text: "",
    });
  }
  row++;
}
buffer.setTextInIndependentRanges(edits, { expectedRevision: revision });
```

## Edits, persistence and I/O

A prepared edit owns its original revision and immutable before/after fragments. Commit is one-shot and rejects stale revisions. CRLF boundary canonicalization gives history and parsers the exact same code units. Metadata remains an immutable value after disposal. `TextStore` tracks a composed patch against the saved root rather than comparing the whole document on each keypress.

File loading streams decoded chunks into pieces using `iconv-lite`; saving streams a captured root and carries incomplete surrogate pairs across chunk boundaries. Invalid encodings reject before opening a destination. Edits after a save begins remain dirty. Save sequence and reset-generation guards prevent stale completion from replacing a newer saved base. Load cancellation, callback errors, rollback and encoding changes retain the existing public behavior.

History serialization is version 7 and JS patch serialization is version 2. Saved-base digests use SHA-256 over UTF-16LE chunks. Existing sessions with incompatible old history use the existing restoration fallback: text is retained, while old native undo history is discarded. No binary native patch format is interpreted by the new implementation.

## Parsing and search

The Tree-sitter journal retains one immutable PieceTree per source revision. WASM input callbacks consume bounded strings, and published syntax nodes retain their own revision's source. Explicit `tree.input` access still returns a complete string for existing consumers; it is not used by the incremental parser path. The native-versus-JS benchmarks use the same WASM grammars and query runtime.

Regex search now uses JavaScript RegExp with the editor's LF/CRLF anchor policy. Its asynchronous API captures the invocation snapshot, yields before searching and yields between match batches at roughly four-millisecond checkpoints. The RegExp engine still runs on the calling thread and materializes the requested search range; one expensive RegExp execution cannot be interrupted by those checkpoints. It is not a worker implementation and a difficult expression can still block that thread. Fuzzy search scans bounded chunks, yields cooperatively at roughly four-millisecond checkpoints and retains only the top requested candidates; scores, match paths and positions are checked against the native reference. Neither syntax workers nor worker-based regex execution are claimed by this migration.

## Validation and performance

`npm run test:document-core` covers randomized text/history operations, marker queries and invalidation against the native oracle, patch composition and old-coordinate invalidation, persistent geometry copies, stale edits, encodings, stream boundaries and saved-base races. A child-process regression asserts that a real TextBuffer edit/marker/undo path does not load Superstring. `npm run test:tree-sitter-runtime` covers bounded parser input, source lifetime and revision behavior. The full editor, main-process and relevant package suites exercise the public integration.

The [2026-10-19 integration report](javascript-document-performance.md) records the first same-facade and real-editor comparison, before the subsequent fleet/API optimization pass.

The comparison driver is `npm run benchmark:document-integration`. It takes `--baseline PATH` pointing at a frozen native editor checkout and freezes the current tracked and untracked WIP into a separate directory. Both sources execute identical benchmark scripts with the same installed dependencies. Each run records source, driver, lockfile and native-addon hashes and rejects changes during measurement. Use a fresh `--output PATH`; the driver deliberately refuses to replace a candidate directory.

The default run uses four fresh processes per implementation, alternating native/JS then JS/native, with three warmups and nine samples per scenario. The aggregate is the conventional median of process medians; individual samples and per-process statistics remain in the report. This controls some process/JIT and order effects but does not turn nine samples into a stable tail-latency estimate. Measurements are specific to the recorded machine, operating system and runtime.

Renderer scenarios use actual TextEditor commands, selections, marker history, grammar settlement and explicit DOM/layout updates. They cover 1/8/32-million-unit documents, 10000 markers, long lines, 1000 cursors, one-million-unit paste, JavaScript syntax and IPython injections. Assertions compare resulting text, undo selections, restored markers, syntax signatures and screen-line counts. Timings exclude fixture setup and verification. They measure command-to-layout completion and a queued timer delay, not physical keyboard-to-screen paint or clipboard IPC.

The accompanying model benchmark uses the same TextBuffer facade on both sides for edits with and without parser snapshots through 128 million UTF-16 units, 100 edit/undo pairs after 5000 scattered edits, regex and fuzzy search. GC runs between model samples; setup is outside timing and verified output is outside timing. The separate 21-snapshot retention case also runs GC inside its measured interval so its memory deltas are comparable; its elapsed time includes that collection and is not a typing-latency measurement. One fragmented-session measurement is a batch of 100 edit/undo pairs. This benchmark does not substitute the bare JS kernel for a fully featured native buffer.

The older [kernel report](../benchmark/results/javascript-document-2026-10-18.json) compared a native TextBuffer/string snapshot with a smaller standalone DocumentCore. Its large snapshot gains demonstrate the cost of full-string materialization, not complete-editor speed. Its original commits were removed from master when this work was returned to WIP; it is retained only as historical exploratory evidence. Use the integration report for decisions about the current migration.
