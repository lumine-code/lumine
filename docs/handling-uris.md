# Handling URIs

Lumine can receive `lumine://` links from a browser, script, or another application. A package can use one to open its own screen or prepare an action for the user to confirm.

## How it works

Installed builds can register the `lumine://` scheme automatically on Windows and macOS. On Linux or another desktop integration, forward the URI to `lumine --uri-handler`. The editor routes the URI's host to the package with that exact `name`.

Treat every URI as untrusted external input. Validate its path and arguments, and never install or delete content, run a command, or write data on the user's behalf without an explicit confirmation.

## Declaring a handler in your package

Add a `uriHandler` entry to `package.json` naming the method to call:

```json
{
  "name": "my-package",
  "uriHandler": {
    "method": "handleURI"
  }
}
```

Then implement that method on your package's main module:

```js
module.exports = {
  handleURI(parsed, rawURI) {
    if (parsed.pathname !== "/open-thing") return;
    const id = String(parsed.query.id || "");
    if (!id) return;
    // Show what will happen and ask the user to confirm it.
  },
};
```

`lumine://my-package/open-thing?id=42` calls the handler on the package's already-bootstrapped module with an object shaped like Node's legacy `url.parse(uri, true)` result, followed by the raw URI string. Keep expensive URI work behind a package-owned lazy function if the handler is not used during normal startup.

The `settings-view` package is a working example: `lumine://settings-view/show-package?package=tree-view` reaches its handler, which opens the internal workspace URI `lumine://config/packages/tree-view`.

The website's Install links use `lumine://settings-view/install?source=lumine-code%2Fjupyter-view`. Settings validates the public repository source, opens its Install panel and searches for that exact source. Encode the complete source, including any ref selector, as a single query argument. The user confirms installation in the editor; opening the URI never installs a package automatically.

## From the command line

The `lumine` command accepts `--uri-handler` so desktop integration can forward one `lumine://` link to a running window.

## Workspace openers and preview reuse

`lumine.workspace.addOpener()` handles internal workspace URIs, such as a package's own panel. Register file and directory viewers or actions with `lumine.workspace.addPathOpener()` so the editor can discover their availability and names without opening anything:

```js
const registration = lumine.workspace.addPathOpener({
  id: "my-viewer",
  label: "My Viewer",
  canOpen: (uri) => supportsURI(uri),
  open: (uri) => new Viewer(uri),
  handlesItem: (item) => item instanceof Viewer,
  canReusePendingItem: (item, uri) => item instanceof Viewer && supportsURI(uri),
  reusePendingItem: (item, uri, options, { signal }) => item.openDocument(uri, { signal }),
});
```

Every descriptor has a unique `id`, a display `label`, a synchronous `canOpen(uri, options)` predicate and an `open(uri, options)` callback. Predicates return booleans without constructing views, loading runtimes or changing files. `pathKinds` defaults to `["file"]`; a directory opener declares `["directory"]`, and an action that handles both declares `["file", "directory"]`. Predicate options always include the detected `pathKind`, which callers may supply when already known. An optional synchronous `isDefaultEligible(uri, options)` predicate separates automatic-opening preferences from availability: a viewer disabled as the default remains available in Open With. The first applicable automatic opener in registration order is the default; the fallback is Text Editor for files and Project Folder for directories. Project Folder opens the folder's saved project state in the current window through `lumine.project.setState()`.

`lumine.workspace.getAvailablePathOpeners(path, options)` returns `{id, label, isDefault, destinations}` entries with the default first. Text Editor is included only for files, and Project Folder only for directories. `lumine.workspace.open(path, {opener: "my-viewer"})` selects exactly that opener regardless of its automatic preference; `{opener: "text-editor"}` opens the file as text. An unavailable or retired explicit opener rejects the opening. A selected opener's refusal or cancellation does not fall through to another viewer. An opener that performs an action instead of returning a pane item returns an empty string, including asynchronously.

`destinations` defaults to `["current", "new-window", "detached-window"]` for viewers. Side-effect actions such as opening an external application or revealing a path declare `["current"]`, so they have no window variants. Project Folder supports only `current` and `new-window`. `lumine.workspace.openPathInNewWindow(path, {opener, signal})` validates the selected opener before requesting a new independent window and carries its ID to that path's startup opening. File openings retain the source window's project roots without applying the file opener to them; directory openings use the selected directory as the project. An aborted signal prevents the request. The automatic default is resolved in the source window if no opener is given. A detached viewer opening supplies its destination pane and `destination: "detached-window"` to `workspace.open()`. Unsupported destinations reject before the opener runs.

File openings resolve their opener before searching existing items. Matching requires the same file URI or path and the same opener type. `handlesItem(item, uri, options)` recognizes restored viewers too and can distinguish fragment-specific views; when omitted, only items created by the current registration can be recognized. Local file URLs are normalized to disk paths before discovery and opening, with their fragment forwarded in `options.uriFragment`. A text editor and a specialized view of the same file can therefore coexist, and ordinary Open activates the default type even after an alternative was opened. Disposing the registration removes it from both automatic opening and Open With; an unpresented asynchronous result arriving after disposal is destroyed.

The workspace checks pending reuse after looking for an already open item of the selected type. It offers only an unmodified pending item in the same destination pane, for an opening with `pending: true` that does not request a split or `activateItem: false`. Permanent tabs and incompatible items follow ordinary opening behavior. Internal URI openers can still declare the same pending reuse capabilities in the optional second argument to `addOpener()`.

`canReusePendingItem(item, uri, options)` is synchronous and has no side effects. `reusePendingItem(item, uri, options, { signal })` returns a Promise; resolving `false` declines reuse without changing the item, while any other resolved value accepts it. Prepare the new document before committing, preserve the previous document on failure, and check `signal.aborted` before changing the item. A newer opening, keeping the pending tab, closing it or moving it cancels an unfinished reuse. Throwing an `AbortError` also cancels the opening when the viewer's own navigation or reload supersedes it; other errors reject the opening. The normal successful-open events and hooks still run for a reused item.

A viewer whose URI can change exposes `onDidChangeURI(callback)`, returning a disposable subscription. Emit after committing the new document, together with the existing path, title and file-state notifications that changed. The workspace reads `getURI()` and publishes `onDidChangePaneItemURI(callback)` with `{ item, pane, oldURI, newURI }`. Consumers use this event when their context follows the resource inside an item, rather than only reacting to a different active item. Reuse preserves item and view identity and emits neither an item-add nor an item-destroy event.

Openers create or reuse resource items; explicit copying uses the item's optional `copy({ signal })` method. Copying silently skips when it is absent or the optional `canCopy()` returns false. See [Pane items](pane-items.md) for shared pane operations and ownership rules.
