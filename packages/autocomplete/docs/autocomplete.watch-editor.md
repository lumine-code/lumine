# autocomplete.watch-editor

A function that turns autocompletion on for an editor autocomplete would otherwise ignore — one inside a panel, a dock, or any pane item that is not a workspace-center tab.

|             |                                                                 |
| ----------- | --------------------------------------------------------------- |
| Version     | `1.0.0`                                                         |
| Provided by | `provideAutocompleteWatchEditor()` returning the watch function |
| Consumed by | `consumeAutocompleteWatchEditor(watchEditor)`                   |
| Owner       | `autocomplete` (bundled)                                        |

`autocomplete` watches every editor the workspace opens, under the label `workspace-center`. An editor you construct yourself and place in your own view is not one of those, so it gets no popup until you register it here — and registering it is also where you choose which providers may answer.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "autocomplete.watch-editor": {
      "versions": { "^1.0.0": "consumeAutocompleteWatchEditor" }
    }
  }
}
```

The service **is** a function, not an object with methods.

## Contract

```ts
type WatchEditor = (editor: TextEditor, labels: string[]) => Disposable;
```

| Argument | Type         | Description                                                                                                                  |
| -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `editor` | `TextEditor` | The editor to watch. Watching one that is already watched is a no-op and returns `undefined`.                                |
| `labels` | string[]     | Which providers may answer in this editor. A provider is eligible when its own `labels` share at least one entry with these. |

A provider that declares no `labels` defaults to `["workspace-center"]`, so passing that label opts your editor into every ordinary provider. Pass a label of your own instead — and have your provider declare it — when only your completions should appear.

Returns a `Disposable` that stops watching.

## Minimal example

```js
const { CompositeDisposable } = require("atom");

module.exports = {
  activate() {
    this.disposables = new CompositeDisposable();
  },

  consumeAutocompleteWatchEditor(watchEditor) {
    this.watchEditor = watchEditor;
    return new Disposable(() => (this.watchEditor = null));
  },

  openPanelEditor() {
    const editor = new TextEditor({ mini: true });
    // Ordinary providers, plus anything labelled for this panel.
    this.disposables.add(this.watchEditor(editor, ["workspace-center", "my-panel"]));
    return editor;
  },
};
```

## Behavior

Watching binds `focus` and `blur` on the editor's view: focus makes it the current editor for the popup, blur hides the suggestion list. If the editor already has focus when you call it, it becomes current immediately.

Labels are matched as a set union — a provider is eligible if _any_ of its labels appears in the array you passed. There is no ordering or priority between labels; ranking is still decided by the providers' own `inclusionPriority`, `suggestionPriority`, and `excludeLowerPriority`.

The service is `undefined` until `autocomplete` activates. Store the function when you receive it rather than calling it at activation, since your package may well be ready first.

## Teardown

Dispose what `watchEditor` returns when the editor goes away; if it was the current editor, the popup detaches from it. Disposing does not destroy the editor.

Autocomplete also disposes everything it holds when it deactivates, so a returned `Disposable` that outlives the provider is safe to dispose twice.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
