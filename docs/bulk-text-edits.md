# Independent text edits

`TextBuffer.setTextInIndependentRanges(edits, { expectedRevision })` applies a plan of disjoint single-line replacements against one buffer revision. Ranges may share a row, but must not overlap or have the same start. Replacement text cannot contain CR or LF. The method accepts unsorted input, validates the entire plan before mutation, skips identical replacements and groups the operation into one undo entry. An obsolete `expectedRevision` rejects with `ERR_STALE_EDIT`.

Use this API for sparse formatting, whitespace transforms and many independent replacements. Do not merge separated matches into one large replacement: markers and selections in the unchanged gaps must retain their positions. A command operating through the buffer must check its editor's writable state; the buffer can be shared by editors with different view policies.

```js
const revision = buffer.getTextRevision();
const edits = [
  {
    range: [
      [0, 1],
      [0, 3],
    ],
    text: "longer",
  },
  {
    range: [
      [0, 8],
      [0, 10],
    ],
    text: "x",
  },
];
buffer.setTextInIndependentRanges(edits, { expectedRevision: revision });
```

Both ranges above address the original revision. The caller does not shift the second range after applying the first. Single-line replacements below the batch threshold still use the same contract; the facade rebases their coordinates during scalar application.

## Commit and notification ownership

For batches of at least 64 eligible changes, storage builds and publishes one persistent text root, history receives one canonical patch, and display layers update once over the affected extent. Canonical patch coordinates refer to the original and final documents. The granular `onDidApplyChanges` sequence instead describes the ordered intermediate splices, including cumulative columns within a row and cumulative character offsets across rows. Replaying those events reconstructs the final text.

Marker indexes still process every splice, preserving boundary affinities and invalidation strategies. Their history coordinate maps synchronize once at the end of the batch. A snapshot requested during the batch synchronizes them immediately; subsequent changes cannot mutate that retained snapshot. This avoids visiting every history marker after every independent edit while keeping intermediate snapshots valid.

Layers with range-tracking callbacks or automatic destruction of invalidated markers retain scalar application so their callbacks see the expected intermediate text. The guard is checked again after `onWillChange`, because observers may install a layer. Errors from syntax or marker updates finish recording the batch before rollback; undo/redo and change-origin events use the same coordinate contract.

Language modes may opt into one conservative invalidation for a large batch while the public applied-change journal remains granular. The [web-tree-sitter integration](text-buffer-tree-sitter.md) uses this only at its existing fresh-parse threshold, so parser policy remains owned by the parser adapter.

## Consumers

Core `TextBuffer.replace()` uses the batch path when all matches and replacements are eligible, retaining the original regex substitution behavior and scalar fallback for multiline replacements. It still materializes text for JavaScript RegExp execution; this change does not claim streaming support for arbitrary regular expressions.

Regex offsets that fall between CR and LF use storage's physical-boundary path instead of clipped editor points. This preserves replacements of either half of CRLF and zero-width matches inside the pair. Reentrant replace-all calls from change observers are rejected before preparing a batch.

`search-panel` submits eligible replace-all matches as one plan and removes result markers after the edit. `code-format` uses the same path for eligible sparse edit arrays. Validated complete plans retain their existing single whole-document write and restore explicitly translated selections: replaying a dense full-text plan through the sparse path was measurably slower. Other formatting and replacement shapes keep their existing paths.

Whitespace commands already use the independent-edit API, so they benefit from the marker-history improvement without another package API. General multicursor insertion, large paste and multiline formatting are separate workloads; the benchmark matrix includes controls to detect regressions rather than assuming these operations all become faster.
