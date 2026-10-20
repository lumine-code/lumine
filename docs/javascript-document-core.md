# JavaScript document core

The running editor owns its text entirely in JavaScript. `TextBuffer` uses `TextStore` and the internal `src/text-model` module: persistent `PieceTree` snapshots, document drafts, spatial patches and a marker index. Native Superstring is absent from normal dependencies, installation and tests. Tree-sitter continues to run through the existing WASM adapter.

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

The source directory stays flat. Production consumers import `src/text-model.js`, which exports `PieceTree`, `DocumentCore`, `ChangeSet`, `TextPatch` and `MarkerIndex`; `ChangeTree` is an implementation detail. The module imports only its own files. Patch byte serialization retains the host `Buffer` API, so this is a Node/Electron module, not a claim of browser portability. `TextStore` remains a core adapter for saved-base state, I/O and search. User history, display policy and parser ownership stay outside the module. Tests and benchmarks may address implementation files for white-box instrumentation.

This is an internal module, not a separately versioned library. Snapshot and patch objects cross the boundary by reference without text conversion, cloning or a second constructor identity. Packages continue to use the public `TextBuffer` APIs; they do not depend on internal file paths.

The internal contract requires `TextPatch.spliceMany` and `changesForOldPositions`, and `MarkerIndex.splicePacked` and `getRanges`. Consumers call these directly; they do not negotiate capabilities with an older backend. Scalar paths remain for small workloads and custom display callbacks. `mergeAdjacentChanges` is the sole patch merge option; balancing belongs to the data structure, with no caller-managed `rebalance` phase.

The 2026-10-21 contract cleanup passed 63 model tests, 58 Tree-sitter runtime tests and 1212 editor integration specs on Windows. Coverage includes display geometry, marker invalidation and event ordering, history, file changes, parser snapshots, injections, syntax publication and update budgets. These are correctness checks; no new performance or worker measurements are implied.

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

The Tree-sitter journal requires `getTextSnapshot()` and retains one immutable PieceTree per source revision. It does not fall back to a flattened `getText()` string. WASM input callbacks consume bounded strings, and published syntax nodes retain their own revision's source. Explicit `tree.input` access still returns a complete string for existing consumers; it is not used by the incremental parser path.

Regex search now uses JavaScript RegExp with the editor's LF/CRLF anchor policy. Its asynchronous API captures the invocation snapshot, yields before searching and yields between match batches at roughly four-millisecond checkpoints. The RegExp engine still runs on the calling thread and materializes the requested search range; one expensive RegExp execution cannot be interrupted by those checkpoints. It is not a worker implementation and a difficult expression can still block that thread. Fuzzy search scans bounded chunks, yields cooperatively at roughly four-millisecond checkpoints and retains only the top requested candidates; scores, match paths and positions have independent JavaScript regression coverage. Neither syntax workers nor worker-based regex execution are claimed by this migration.

## Validation and performance

`npm run test:document-core` covers randomized text/history operations against flat strings, patch replay and inversion, marker affinity and coordinate lists, persistent geometry copies, stale edits, encodings, stream boundaries and saved-base races. Boundary tests guard the module's imports and the absence of Superstring from the normal install. A child-process regression asserts that a real TextBuffer edit/marker/undo path does not load Superstring. `npm run test:tree-sitter-runtime` covers bounded parser input, source lifetime and revision behavior. The full editor, main-process and relevant package suites exercise the public integration.

Native differential suites and their external-reference loader were retired on 2026-10-21. Current validation uses the independent JavaScript oracles and editor integration tests above; no native text-model checkout or binary is required.

Validation after that retirement passed 63 model tests and the renderer benchmark spec. Smoke runs also completed 32 buffer/editor-model cases, two snapshot/read cases, 22 marker-history cases and three renderer operations with their correctness assertions. These runs verify the maintained JavaScript benchmark entry points; they are not a new performance comparison.

The 2026-10-20 internal-module cleanup keeps `src` flat and leaves the five data-structure implementations unchanged. Local validation after removing the installed native package passed 64 document-model tests, 58 Tree-sitter runtime tests, 858 editor integration specs and all 15 optional native comparisons. The display benchmark also froze a JavaScript baseline successfully without a native addon, and bundled-dependency validation passed. These are local Windows results; no cross-platform CI result is implied.

A serial before/after/after/before model comparison against `aef9280eb5` covered 32 insertion, replacement, undo and redo scenarios on buffer and editor-model surfaces, using flat and multiline payloads of 128 and 1000000 UTF-16 units, two warmups and seven measured samples per process. All checksums matched. No scenario exceeded both a 5% and 0.5 ms increase in the aggregate median. The largest absolute increase was multiline editor redo at 1000000 units: 59.18 to 60.87 ms, about 2.9%; this small process-level sample does not prove zero performance variation. The benchmark excludes DOM presentation and syntax parsing. Raw local runs are retained under `.dev/internal-text-model-20261020`.

The [2026-10-19 integration report](javascript-document-performance.md) records the first same-facade and real-editor comparison, before the subsequent fleet/API optimization pass.

Use `npm run benchmark:text-model` for buffer and editor-model operations, and `npm run benchmark:text-model-renderer` for command and synchronous DOM/layout costs. The model driver accepts `--source`, `--samples`, `--warmups`, `--units`, `--filter`, `--gc-after-setup` and `--output`. Run frozen JavaScript revisions in separate processes and alternate their order; preserve source hashes and output checksums. Native binding overrides are no longer supported.

The broader renderer/fleet scenarios remain in `benchmark/document-editor-integration-spec.js`, runnable through `npm run test:only -- benchmark/document-editor-integration-spec.js`. `LUMINE_DOCUMENT_BENCH_CONFIG` supplies JSON with `samples`, `warmups`, `filter`, `packages` and optional scenario flags; `LUMINE_DOCUMENT_BENCH_OUTPUT` selects the result file. They cover real commands, markers, multiple cursors, syntax settlement, injections and DOM/layout updates. Timings exclude fixture setup and verification and do not measure physical keyboard-to-screen latency.

Historical native-versus-JavaScript reports retain their original measurements and source hashes. Their retired drivers and prototype patches are available in Git history; they are not supported reproduction commands for the current checkout. Use current JavaScript benchmarks to evaluate subsequent changes.
