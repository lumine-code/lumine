# Syntax analysis ownership

The editor uses one worker per window to own Tree-sitter parsers, WASM trees, injection layers and queries. The renderer owns the authoritative TextBuffer, selections, undo history and presentation. There is no second renderer syntax tree. The inline backend remains available for parser tests and controlled performance comparisons. The Jasmine runner defaults to inline for engine-level fixtures; set `LUMINE_SYNTAX_EXECUTION=worker` to run package scenarios against the application backend.

The editor manifest declares the optional packages used by integration specs in `specPackages`. A full workspace resolves them from sibling repositories. In a standalone checkout, run `node script/install-spec-packages.js --package . --home <isolated-home>` and run tests with `LUMINE_HOME` pointing at that home. CI provisions it automatically. These test packages remain outside the bundled distribution.

## Document synchronization

A document opens from an immutable text snapshot, sent in strings of at most 65536 UTF-16 code units. Subsequent edits preserve their exact offsets and source revision. Small transactions take one message; larger transactions use acknowledged packets containing at most 128 changes and 65536 inserted code units. A large individual insertion is split into text packets. The worker applies the complete transaction atomically and keeps analyses waiting until it commits. Its mirror does not retain editor undo history.

Responses identify the source revision and syntax generation. Grammar, query, configuration, path and root-range-policy changes invalidate pending requests even when the text is unchanged. Closing a document cancels its streams and releases its worker session. A worker failure permits one recovery from authoritative renderer snapshots; repeated failure is reported instead of entering a restart loop. The idle worker terminates after the last document has been released.

## Package analyses

Use `editor.analyzeSyntax(modulePath, method, params, options)` for operations tied to an editor, or `buffer.analyzeSyntax(...)` for shared document data that must survive closing one split. The module path must be absolute. Params are cloneable data. An invocation returns a promise; `null` means it became obsolete. Parse failures also return `null`, while programming errors reject the promise. Editor analyses include pending automatic indentation before acquiring syntax. Consumers must still validate selections and their own UI or service lifetime before applying an answer.

```js
// Renderer-side package code.
const ranges = await editor.analyzeSyntax(
  require.resolve("./syntax-analysis"),
  "findCalls",
  { name: "print" },
  { signal },
);
```

```js
// syntax-analysis.js: runs beside the parser, without DOM or editor globals.
exports.findCalls = (context, { name }) => {
  const root = context.getRootSyntaxNode();
  if (!root) return [];
  return root
    .descendantsOfType("call")
    .filter((node) => node.childForFieldName("function")?.text === name)
    .map((node) => ({ start: node.startPosition, end: node.endPosition }));
};
```

The read-only context provides document reads through `context.buffer`, editor-style text and coordinate helpers, the root node, node lookup, query capture groups, scope ranges, comment delimiters, fold queries and indentation hints. `context.signal` is aborted when the invocation ends. Do not retain nodes, cursors, context methods or unfinished asynchronous work beyond that lifetime. Poll the signal and yield during long JavaScript loops. DOM operations, editor mutations, package-manager access and renderer closures belong outside the analysis module.

Renderer methods that expose raw nodes or query captures are restricted to the inline backend and throw with worker syntax. Move that computation into an analysis module instead of requesting cloned nodes or relying on an empty result. The same pure module runs beside the inline parser in comparison tests.

Return plain data, arrays, maps or typed arrays. Point and Range values become plain coordinate records. WASM nodes, functions, accessors and other class instances are rejected rather than transported as unusable handles. Convert coordinates with `Point.fromObject` or `Range.fromObject` when the renderer needs those classes.

For large results, the analysis receives `{ signal, emit }` as its third argument. Await every `emit(packet, transferList)` and keep each packet bounded. The renderer supplies `options.onChunk(packet)`, which may return a promise. Acknowledgement follows that promise, so decoding and consumer work participate in backpressure. The promise returned by `emit` resolves to the consumer's cloneable acknowledgement value. This lets a worker scan resume from a renderer-owned handler's consumed offset without serializing that handler. Do not accumulate raw packets and then decode the whole result in one final renderer loop. Return a small completion summary; discard accumulated output if the final result is `null`.

## Exact semantics and presentation

`getScopeDescriptorsForBufferPositions` and `getCommentDelimitersForBufferPositions` query many positions in one bounded operation, including positions outside visible rows. They return `null` when superseded. Use them for semantic decisions. Fold, syntax-scope, token, paragraph and comment queries can resolve asynchronously with worker syntax; await them before changing editor state. `getSyntaxSnapshotToken()` supplies an opaque identity for settled semantic caches and returns `null` while syntax is pending.

Synchronous scope reads remain presentation reads: they use prepared coverage and may show retained scopes while a new revision is being parsed. They cannot be used to claim an exact AST result. Rendering requests belong to their view owner, including a separate minimap owner. `requestHighlightingForScreenRows(owner, start, end)` prepares the complete view; pass that owner to `tokensForScreenRow` and an optional `maxTokens` to bound token conversion. Release coverage with an empty range. Scope boundaries stream in packets of at most 4096 events. A narrow viewport is prepared as one complete range before the surrounding 128-row cache tiles; crossing a tile boundary does not require two round trips to color the view. Each completed range publishes immediately, and its acknowledgement selects the next missing range from live requests. Visible editor splits precede their prefetch, followed by minimap requests and single-line measurements. Measurement reads do not request prefetch. The surrounding lead follows approximately 120 ms of measured row movement, bounded between 128 and 1024 rows, with 128 rows retained behind. Native scrollbar input starts preparation before the scheduled frame and coalesces painting without dropping subsequent input positions. Unchanged coverage is reused, and highlighting does not wait for scrolling to stop or for a minimap batch to finish. Row reads locate scope boundaries with binary search and reuse lazy checkpoints instead of replaying the whole tile prefix for every row.

The renderer retains up to 256 scope fragments under the existing 128000-event allowance, instead of discarding colors after sixteen fragments. Visible requested ranges and the packet being published remain protected. When foreground requests are satisfied, the worker prepares missing 128-row fragments near the visible editor, within 16384 rows in each direction. Background growth stops at 75% of either cache allowance, leaving room for new scroll destinations. Once full, it can replace a more distant fragment with nearer missing coverage, with a two-tile hysteresis; it never evicts another view’s requested coverage or lead. Each packet acknowledgement rechecks current foreground requests. Folded views do not warm hidden interiors, measurements do not initiate background preparation, and hiding an editor releases its viewport request. This permits a modest document to keep prepared colors without building an unbounded whole-file cache for large inputs. Edits before a retained fragment accumulate a row offset instead of walking all its scope events; reads translate only consumed events, while partial replacements materialize the affected fragment. Retaining scroll coverage therefore does not make each newline proportional to all cached scopes.

For multiline completion edits, track inserted ranges through additional edits and call `autoIndentBufferRowsAtRows(rows, { groupWithPrevious: true })` after the transaction. The sparse plan applies once against one revision. Independent edits or indentation-setting changes cancel the correction. Automatic newline indentation follows marked rows through continued typing in the same editor and remains part of its undo operation.

An uncached scroll destination may wait for at most one animation frame before replacing the displayed lines. Arrival of its colors publishes text and scopes together without blocking the event loop; expiry permits an uncolored fallback. Further scroll input and lazy geometry updates cannot extend the deadline. Editing the source, changing its language mode, hiding the view or detaching it cancels the wait. Native scrollbars, wheel animations, selection autoscroll and the public scroll setters used by packages share this policy. Prefetch publishes only uncovered or changed ranges; already current coverage and touching offscreen ranges do not redraw the viewport. Colors arriving for mounted lines update those lines immediately, preserving their scroll transform and decorations even while a newer destination is waiting. The pending destination must never delay colors that are already available for the displayed text.

## Grammar modules and root ranges

Register dynamic injections through `lumine.grammars.registerSyntaxModule(require.resolve("./injections"), { method: "register", args: [] })`. Its exported factory receives the grammar registry followed by the supplied arguments and returns a disposable. Put node callbacks inside that module; do not send functions from the renderer. Registration captures injection disposables for rollback, and package teardown must dispose the module registration. Module code must not use DOM APIs or renderer package singletons.

`setRootLanguageRanges(buffer, { module, method, params })` registers a portable root-range policy. Its exported synchronous function receives the current immutable PieceTree snapshot and params, returning ranges or `null` for the whole source. An empty array excludes all source. The policy follows grammar changes and reevaluates against each new text state. Disposing an obsolete registration cannot remove its replacement. Renderer callbacks are not accepted by the worker backend.

## Scroll benchmark

Run `npm run test:only -- benchmark/syntax-worker-scroll-spec.js` in an isolated profile with the desired package sources available. Set `LUMINE_SYNTAX_BENCHMARK_CONFIG` to a JSON object with `file`, `out`, `packages` (package names), and `backend` (`worker` or `inline`). Optional `minimap` shows the minimap, `synthetic` substitutes a small unsaved JavaScript buffer, `gesture: "thumb"` exercises the native scrollbar event path, `delta` selects pixels per event (before the Alt multiplier for wheels; default 100), and `interval` selects milliseconds between events (default 16.667). Thumb movement reverses at document edges so a short file cannot report success merely by remaining at EOF. The benchmark activates every listed package and checks that the input file's hash is unchanged.

The benchmark covers the middle, end and a direction reversal, recording prepared coverage, colored DOM spans, frame intervals, callback delay, input delay and renderer paint-packet costs. Input timers are queued before the gesture so slow dispatch cannot silently reduce the requested input rate. Summaries exclude the settling period after the last wheel event. These probes add measurement overhead; packet cost is not the whole frame cost, and full coverage alone does not establish a frame-rate improvement.

Set `trusted: true` to inject mouse events through Electron's spec-window input API. Thumb tests then grab the actual scrollbar and move the pointer; they start in the middle and include both directions and reversal. The benchmark verifies movement, samples scope classes from the rendered DOM, and records whether a missing scope followed an expired paint deadline. `frameDeadline: false` disables that waiting policy only in the isolated benchmark editor for comparison. A frame with no colored spans can contain naturally unstyled text, so interpret it alongside scope mismatches and coverage rather than as proof of a rendering defect.

A complementary normal-window probe avoids relying solely on the spec runner. Launch an isolated window with `node script/drive.js launch <fixture> --home <scratch-profile> --port 9247`, provision its package links, and run `node benchmark/syntax-worker-scroll.js <config.json>` with `{ "port": 9247, "out": "<results-directory>", "gesture": "wheel", "warmup": 1000 }`. Use `gesture: "thumb"` for native scrollbar dragging, `warmup: 0` for a cold destination and `capture: true` to save actual compositor frames as PNGs. Input dispatch is paced independently of its acknowledgements. The report observes every visible mounted row, records active packages and cache occupancy, and verifies the fixture hash. Captured frames contain the real document and remain local test artifacts. Plain-span counts alone are not correctness assertions: naturally unstyled content must be distinguished from missing cached scopes.
