# Locality, compact indexes and request lifetimes

This round tests three ideas found in VS Code against Lumine's current JS model. The main gains are smaller indexes and cheaper repeated operations. The full typing experiment does not demonstrate another large latency improvement. [Raw measurements, fingerprints and validation](../benchmark/results/vscode-locality-lifetimes-2026-10-20.json) retain the unfavorable cases.

## Ideas and implementation

VS Code's [piece-tree implementation](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeBase.ts) caches a recently located piece and chooses compact integer arrays when local offsets fit. Lumine now caches the leaf used by `lineStart`, together with its absolute row and character offset. Each immutable snapshot owns its cache, so an edit cannot reuse another revision's absolute coordinates. The first row of a leaf remains excluded from cache hits when its line may start in an earlier piece. Existing caching of the last line's text remains unchanged.

Backing-buffer indexes for LF, CRLF and surrogate pairs now use `Uint16Array` when the buffer length fits 16 bits, with `Uint32Array` retained for larger buffers. Lumine currently limits backing buffers to 32768 UTF-16 units. These are local offsets; document positions remain ordinary safe-integer coordinates, and Unicode and newline semantics remain unchanged. The implementations are independent adaptations of the ideas, not copied VS Code code.

VS Code's [cancellation source](https://github.com/microsoft/vscode/blob/main/src/vs/base/common/cancellation.ts) separates disposal from cancellation and creates cancellation state lazily. Autocomplete now creates a controller only when providers exist, retains it through asynchronous publication, and releases manager ownership after the request finishes. A late old completion cannot clear a newer controller. Provider failure cancels unfinished siblings and releases the failed generation; synchronous exceptions use the same rejection path.

The provider contract explicitly scopes its signal to pending work, including popup publication. A successfully completed request is not subsequently aborted by the next request. Providers must own the lifetime of later work separately. Active and superseded requests retain cancellation behavior. This contract adjustment is documented in the package's provider API.

VS Code's [completion model](https://github.com/microsoft/vscode/blob/main/src/vs/editor/contrib/suggest/browser/completionModel.ts) also narrows an earlier result when refining a prefix. Lumine already implements that in its word index from the preceding round. Its alternate scoring policy for very large lists was not adopted: this experiment preserves existing scores and suggestions rather than changing ranking quality to obtain a timing gain.

## Local coordinate reads

Fresh Electron Node processes run before/after/after/before. The fixture contains 120000 rows, CRLF and Unicode. Fragmented cases first perform 2000 equal-length edits. Each lookup condition performs 200000 calls; edit/read cases perform 5000 edits with three coordinate reads. Checksums match an independent flat-offset oracle. The final candidate includes both the cache and compact indexes.

| Fragmented tree: operation | Before, ms | After, ms |
| -------------------------- | ---------: | --------: |
| Same row                   |    9.0–9.4 |       3.7 |
| Nearby viewport rows       |  10.1–10.2 |       4.1 |
| Sequential rows            |    7.2–7.7 |       2.6 |
| Random rows                |  31.6–32.5 | 31.3–31.7 |
| Edit followed by reads     |  16.1–17.8 | 17.4–17.9 |

The benefit depends on locality. Fresh-tree random reads vary between 12.7–16.7 ms before and 13.2–14.7 ms after; fresh-tree edit/read work is slightly slower, about 14.0–14.4 ms before and 14.9–15.7 ms after. These totals cover hundreds of thousands of lookups or thousands of edits, not one keystroke.

## Index payload

The memory benchmark counts the actual `byteLength` allocated by index-array factories in an instrumented copy of the selected module. It retains native typed arrays and verifies text, row count and the final row's offset. This is index payload, not process RSS, total model memory or JavaScript object overhead. An initial attempt using `process.memoryUsage().arrayBuffers` returned zero in embedded Electron and is excluded.

| Generated fixture        | Before, bytes | After, bytes |
| ------------------------ | ------------: | -----------: |
| 100000 source lines, LF  |        400000 |       200000 |
| 500000 CRLF lines        |       3999940 |      1999970 |
| 500000 astral/CRLF lines |       6000000 |      3000000 |
| 2097152 LF characters    |       8388608 |      4194304 |
| One long ASCII line      |             0 |            0 |

All four process runs agree on these payload sizes. Empty indexes have no payload to reduce. Persistent snapshots continue sharing their backing arrays.

## Completion request lifetime

A separate renderer benchmark uses the actual completion runtime and native `AbortController`, with one provider and no layout or RPC cost. For 500 completed requests, time falls from 3.5–3.8 ms to 1.4–1.5 ms, and unnecessary aborts fall from 499 to zero. For 500 pending requests, both variants still perform 500 aborts and take approximately 3.7–3.9 ms. The reduction is small in absolute terms and does not establish that the expensive active parser/LSP cancellation paths have been eliminated.

## Full fleet

The final candidate is compared before/after/after/before in fresh Electron processes, once with local Tree-sitter symbols and 38 explicitly activated packages, and once with the actual SOFiSTiK LSP and 43 packages. Core and package sources are frozen. Outline is closed. Each process opens the supplied large file at its middle and 100 rows before EOF, requires a complete 195778-symbol cache, types 60 characters at 60 Hz, then scrolls for three seconds and observes another six seconds.

Both variants produce equal edited text and matching syntax input, revision, extent and error-state checks. The original file is never copied or saved. Tests and timing experiments are run separately, without forced GC. The earlier candidate using 32-bit indexes is a pilot; final fleet and locality results use the 16-bit candidate.

Typing medians overlap: approximately 0.6–0.9 ms without LSP and 0.9–1.0 ms with LSP. The middle-of-file LSP p95 is slightly worse in the final candidate, about 1.8–1.9 ms versus 1.6–1.7 ms, while other conditions overlap or differ by about 0.1 ms. These two process-level observations per variant do not establish a meaningful whole-typing speedup. Frame intervals still reach approximately 33 ms in the local-symbol scenario. RequestAnimationFrame timestamps are not physical presentation latency.

## Validation and reproduction

All 720 tests pass: 34 document/text-store tests, 214 editor integration specs and 472 autocomplete specs. Document tests cover fragmented edits, old snapshots, LF/CRLF, lone CR, surrogate pairs and native-reference coordinate equivalence. Editor integration tests cover highlighting, indentation, combined injections, editing and undo/redo. Autocomplete tests cover completed requests, pending publication, superseded generations and synchronous/asynchronous provider failures. Changed sources pass ESLint and formatting checks; autocomplete's package audit reports zero vulnerabilities and its package-content check passes.

Reproduce using [piece-locality-benchmark.js](../benchmark/piece-locality-benchmark.js), [piece-index-memory-benchmark.js](../benchmark/piece-index-memory-benchmark.js), [completion-lifetime-benchmark-spec.js](../benchmark/completion-lifetime-benchmark-spec.js) and the existing [post-edit-refresh-benchmark-spec.js](../benchmark/post-edit-refresh-benchmark-spec.js). Use the configurations documented in their source, isolated homes and `CI` unset. Results are local Windows measurements against the preceding JS model, not a new comparison with Superstring. Dependency pins are unchanged.
