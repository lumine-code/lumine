# Independent text edits

`TextBuffer.setTextInIndependentRanges(edits, { expectedRevision, normalizeLineEndings })` applies a plan of disjoint replacements against one buffer revision. Ranges and replacement text may span multiple rows, but ranges must not overlap or have the same start. The method accepts unsorted input, validates the entire plan before mutation, skips identical replacements and groups the operation into one undo entry. An obsolete `expectedRevision` rejects with `ERR_STALE_EDIT`.

Replacement text is literal by default. With `normalizeLineEndings: true`, each replacement uses the preferred line ending, or the ending of its original start row (falling back to the preceding original row). This is a revision-bound plan: normalization does not depend on which other edit happens to execute first. `code-format` requests normalization explicitly, including for mixed-ending documents.

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

Both ranges above address the original revision. The caller does not shift the second range after applying the first. Replacements below the batch threshold still use the same contract; the facade rebases rows and columns during scalar application. Physical offsets remain valid even when an earlier replacement forms CRLF around a later edit boundary.

## Commit and notification ownership

For batches of at least 64 eligible changes, storage builds and publishes one persistent text root, history receives one canonical patch, and display layers update once over the affected extent. Canonical patch coordinates refer to the original and final documents. The granular `onDidApplyChanges` sequence instead describes the ordered intermediate splices, including row shifts, cumulative columns within a row and cumulative character offsets. Replaying those events reconstructs the final text. Undo and redo use the same batch path when their canonical ranges remain eligible.

Marker indexes still process every splice, preserving boundary affinities and invalidation strategies. Their history coordinate maps synchronize once at the end of the batch. A snapshot requested during the batch synchronizes them immediately; subsequent changes cannot mutate that retained snapshot. This avoids visiting every history marker after every independent edit while keeping intermediate snapshots valid.

Layers with range-tracking callbacks or automatic destruction of invalidated markers retain scalar application so their callbacks see the expected intermediate text. Edits that split or form CRLF at their boundaries also retain scalar storage's boundary expansion and marker-affinity behavior; ordinary CRLF inside multiline ranges remains eligible. The guard is checked again after `onWillChange`, because observers may install a layer. Errors from syntax or marker updates finish recording the batch before rollback; undo/redo and change-origin events use the same coordinate contract.

Language modes may opt into one conservative invalidation for a large batch while the public applied-change journal remains granular. The [web-tree-sitter integration](text-buffer-tree-sitter.md) uses this only at its existing fresh-parse threshold, so parser policy remains owned by the parser adapter.

## Consumers

Core `TextBuffer.replace()` uses the batch path when all matches and replacements are eligible, including multiline replacements, retaining the original regex substitution behavior. It still materializes text for JavaScript RegExp execution; this change does not claim streaming support for arbitrary regular expressions.

Regex offsets that fall between CR and LF use storage's physical-boundary path instead of clipped editor points. This preserves replacements of either half of CRLF and zero-width matches inside the pair. Reentrant replace-all calls from change observers are rejected before preparing a batch.

`search-panel` submits eligible replace-all matches as one plan and removes result markers after the edit. `code-format` uses the same path for sparse edit arrays, including multiline edits. Validated complete plans retain their existing single whole-document write and restore explicitly translated selections: replaying a dense full-text plan through the sparse path was measurably slower.

Whitespace commands already use the independent-edit API. Multicursor commands retain scalar selection callbacks and intermediate text; with at least 64 selections, history coordinates are deferred after row-changing edits and synchronized on demand or at completion. Column-only edits keep local marker queries. Transaction history also composes large ordered, disjoint patch sequences directly, falling back to the general composer for overlapping or reordered edits. These optimizations preserve insertion observers, indentation, selection direction and rollback rather than bypassing `Selection.insertText`.
