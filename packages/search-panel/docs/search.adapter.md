# search.adapter

Makes a pane item that is not a `TextEditor` searchable with the ordinary find panel — a notebook, a data grid, a rendered preview.

|             |                                                          |
| ----------- | -------------------------------------------------------- |
| Version     | `1.0.0`                                                  |
| Provided by | `provideSearchAdapter()` returning an adapter factory    |
| Consumed by | `consumeSearchAdapter(service)` returning a `Disposable` |
| Owner       | `search-panel` (bundled)                                 |

The find panel normally binds to the active text editor. An adapter lets your item take that slot instead: the panel's UI, options, and commands stay exactly as the user knows them, and your item answers the search.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "search.adapter": {
      "versions": { "1.0.0": "provideSearchAdapter" }
    }
  }
}
```

## Contract

The service is a **factory**, asked which item it handles; the adapter it returns is what does the work.

```ts
type SearchAdapterService = {
  getActiveAdapter?(): SearchAdapter | null;
  handlesItem?(paneItem: object): boolean;
  getAdapterForItem?(paneItem: object): SearchAdapter | null;
};
```

Implement either `getActiveAdapter` — checked first, and useful when your package always knows what is focused — or the `handlesItem` / `getAdapterForItem` pair.

The adapter itself. These are required:

| Member                               | Description                                                       |
| ------------------------------------ | ----------------------------------------------------------------- |
| `search(findOptions)`                | Runs a search. Read the pattern and flags off the options object. |
| `getResultCount()`                   | How many matches the last search found.                           |
| `getCurrentResultIndex()`            | Which one is current, for the "3 of 17" counter.                  |
| `selectNext()`, `selectPrevious()`   | Move the current match. Return the new one.                       |
| `onDidUpdate(callback)`              | Fires when the result set changes.                                |
| `onDidChangeCurrentResult(callback)` | Fires when the current match moves.                               |

And these are optional, each with a defined fallback:

| Member                                                     | Fallback when absent                                     |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `canReplace`                                               | Replace is disabled.                                     |
| `replaceCurrentMatch(text, direction)`, `replaceAll(text)` | Only called when `canReplace` is truthy.                 |
| `selectFirstFromCursor()`                                  | Falls back to `selectNext()`.                            |
| `selectAll()`                                              | Select-all does nothing.                                 |
| `hasSelectionMatchingResult()`                             | Treated as `false`.                                      |
| `isSelectionEmpty()`                                       | Treated as `true`.                                       |
| `getSelectedText()`, `getWordUnderCursor()`                | Empty string — so "use selection for find" does nothing. |
| `getWrapIconHost()`                                        | No wrap indicator is shown.                              |
| `onDidError(callback)`                                     | Errors are not surfaced.                                 |
| `deactivate()`                                             | Nothing is torn down when focus leaves your item.        |
| `refresh()`                                                | Not called.                                              |

## Minimal example

```js
module.exports = {
  provideSearchAdapter() {
    return {
      handlesItem: (paneItem) => paneItem instanceof MyGridView,
      getAdapterForItem: (paneItem) => paneItem.getSearchAdapter(),
    };
  },
};
```

with the adapter on your view:

```js
getSearchAdapter() {
  return {
    canReplace: false,
    search: (findOptions) => this.runSearch(findOptions.findPattern, findOptions),
    getResultCount: () => this.matches.length,
    getCurrentResultIndex: () => this.currentIndex,
    selectNext: () => this.step(+1),
    selectPrevious: () => this.step(-1),
    onDidUpdate: (callback) => this.emitter.on("did-update-matches", callback),
    onDidChangeCurrentResult: (callback) => this.emitter.on("did-change-current", callback),
  };
}
```

## Behavior

Registered services are consulted **in registration order**, and the first adapter returned wins. `getActiveAdapter()` is tried before `handlesItem`, so a service implementing both effectively overrides its own item test.

The panel re-resolves the adapter on every active-pane-item change, and registering or unregistering a service re-resolves immediately — so an adapter that becomes available later takes over the currently focused item without the user doing anything.

When an adapter is active the panel detaches from any text editor entirely, so your adapter is the only thing answering. `deactivate()` is your signal that focus has moved on.

`search` is called with the panel's live `findOptions`, not a plain string: read `findPattern` plus the case, regex, and whole-word flags from it so your results match what the checkboxes say.

## Teardown

`consumeSearchAdapter` returns a `Disposable` that unregisters the service and re-resolves the active item. Your adapter's own `deactivate()` is called when the panel switches away from your item, which is where per-item highlight state should be cleared.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
