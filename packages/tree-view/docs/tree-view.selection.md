# tree-view.selection

Read what is selected in the tree, find the element for a path, and scroll a path into view.

|             |                                                        |
| ----------- | ------------------------------------------------------ |
| Version     | `1.0.0`                                                |
| Provided by | `provideTreeViewSelection()` returning three functions |
| Consumed by | `consumeTreeViewSelection(treeView)`                   |
| Owner       | `tree-view` (bundled)                                  |

This is how a package acts on "the files the user has selected" — a publish command, a formatter, a linter run, a clipboard operation. It is read-and-reveal only: nothing here changes the selection or the project folders.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "tree-view.selection": {
      "versions": { "^1.0.0": "consumeTreeViewSelection" }
    }
  }
}
```

## Contract

```ts
type TreeViewSelection = {
  selectedPaths(): string[];
  entryForPath(entryPath: string): HTMLElement | undefined;
  revealPath(filePath: string, options?: object): Promise<void>;
};
```

| Member                    | Description                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `selectedPaths()`         | Absolute paths of every selected entry, in tree order. Empty when nothing is selected.                   |
| `entryForPath(entryPath)` | The entry element for a path, or `undefined` if that path is not currently rendered.                     |
| `revealPath(filePath)`    | Expands the tree to the path, selects it, and scrolls it into view. Also shows the tree if it is hidden. |

## Minimal example

```js
const { Disposable } = require("atom");

module.exports = {
  consumeTreeViewSelection(treeView) {
    this.treeView = treeView;
    return new Disposable(() => (this.treeView = null));
  },

  formatSelection() {
    for (const filePath of this.treeView?.selectedPaths() ?? []) {
      this.format(filePath);
    }
  },
};
```

## Behavior

`selectedPaths` reflects the tree's current selection, which is not the same as the active editor. A command that should work from either needs its own fallback — the usual pattern is to prefer the tree selection when the tree has focus and the active editor's path otherwise.

Entries are only rendered while their parent directory is expanded, so `entryForPath` returns `undefined` for a collapsed subtree even though the path exists on disk. Do not use it to test existence.

`revealPath` expands directories on the way, so it may touch the filesystem and is asynchronous.

The service resolves against the live tree-view instance on each call, so holding the service object across a tree-view teardown and re-creation is safe.

## Teardown

Return a `Disposable` from `consumeTreeViewSelection` that drops your reference. The service object itself needs no disposal.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
