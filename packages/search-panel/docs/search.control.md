# search.control

Drives the find and replace panels from another package: read the options, show or hide the panels, trigger a search, and follow the results.

|             |                                                       |
| ----------- | ----------------------------------------------------- |
| Version     | `1.0.0`                                               |
| Provided by | `provideSearchControl()` returning the control object |
| Consumed by | `consumeSearchControl(search)`                        |
| Owner       | `search-panel` (bundled)                              |

Read-and-drive, not replace: this controls the panels that exist. To make a _different kind of pane item_ searchable, provide [`search.adapter`](search.adapter.md) instead.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "search.control": {
      "versions": { "^1.0.0": "consumeSearchControl" }
    }
  }
}
```

## Contract

```ts
type SearchControl = {
  // Results
  resultsMarkerLayerForTextEditor(editor: TextEditor): DisplayMarkerLayer;
  onDidUpdate(callback: (markers: DisplayMarker[]) => void): Disposable;
  onDidChangeCurrentResult(callback: (result: object) => void): Disposable;

  // Options
  getFindOptions(): FindOptions;
  onDidChangeFindOptions(callback: () => void): Disposable;

  // Visibility
  showFind(): void;
  showReplace(): void;
  showProjectFind(): void;
  hideFind(): void;
  hideProjectFind(): void;
  isFindVisible(): boolean;
  isProjectFindVisible(): boolean;
  onDidChangeFindVisibility(callback: (visible: boolean) => void): Disposable;
  onDidChangeProjectFindVisibility(callback: (visible: boolean) => void): Disposable;

  // Triggers
  search(findPattern: string, options?: object): void;
  projectSearch(findPattern: string, pathsPattern?: string): void;
};
```

| Group      | Notes                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Results    | `resultsMarkerLayerForTextEditor` gives the live marker layer of the current matches — this is what a scrollbar overview draws. |
| Options    | `getFindOptions()` returns the live options object, including the pattern, the regex and case flags, and the paths filter.      |
| Visibility | Showing one panel hides the other; `showReplace` opens find with the replace field focused.                                     |
| Triggers   | `search` runs a buffer search in the active editor; `projectSearch` sets the pattern and path filter and runs a project search. |

## Minimal example

```js
module.exports = {
  consumeSearchControl(search) {
    return search.onDidUpdate(() => {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) return;
      const layer = search.resultsMarkerLayerForTextEditor(editor);
      this.drawMarkers(layer.getMarkers().map((m) => m.getStartScreenPosition().row));
    });
  },
};
```

## Behavior

**Several members create the panels as a side effect.** `showFind`, `showReplace`, `showProjectFind`, `search`, `projectSearch`, `onDidChangeFindVisibility`, and `onDidChangeProjectFindVisibility` all build the views if they do not exist yet. The `hide*` and `is*Visible` members do not, and answer `false` for a panel that has never been created. Subscribing to a visibility event therefore materialises a panel — prefer `isFindVisible()` when you only want to read.

`resultsMarkerLayerForTextEditor` returns the layer for that editor whether or not a search is running; it is simply empty when there are no matches. The markers are live, so read positions when you need them.

`onDidUpdate` fires on every result-set change, including one that clears the results.

## Teardown

Every `on*` member returns a `Disposable`; collect them and dispose on teardown. The panels belong to `search-panel` — do not destroy them, and do not assume they are gone after you hide them.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
