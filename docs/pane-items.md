# Pane items

A pane item is the complete model or view displayed in one workspace tab. An editor embedded inside another item belongs to that item; pane commands act on the containing tab.

## Identity and locations

One item instance belongs to at most one pane, and owns one view root for its lifetime. Moving transfers that instance and its live DOM, buffers, processes, observers and other resources. Copying creates a fresh item with a separate root. Multiple items may represent the same resource URI.

Items implement `getTitle()` and expose a DOM element through `getElement()`, their element identity, or a registered view provider. `getAllowedLocations()` restricts the item to `center`, `left`, `right` and/or `bottom`; its default is the location returned by `getDefaultLocation()`, which itself defaults to `center`.

`copy({ signal })` and `canCopy()` are optional. Implement `copy` when an item supports creating another view; omit it when copying is unsupported. An optional `canCopy()` returning false disables copying even when `copy` exists. Copy capability and resource uniqueness are independent: disabling copy does not impose one global instance of the item's type.

`getSingletonKey()` returns a namespaced non-empty string for a resource that has one item in this workspace, or null when uniqueness is not required. Workspace tools use a constant key; independent search results and command executions use different resource keys. Reopening an existing key activates its existing item without making a split. Changing the key emits `onDidChangeSingletonKey(callback)`, or `onDidChangeURI(callback)` when it follows the URI; subscriptions return a Disposable. Publish the change before awaiting rendering so the former resource slot is immediately available. Closing the item releases its key.

## Moving and copying

Use the Workspace methods for item operations:

```js
const item = lumine.workspace.getCenter().getActivePaneItem();
const sourcePane = lumine.workspace.paneForItem(item);
const moved = await lumine.workspace.movePaneItem(item, {
  sourcePane,
  splitDirection: "right",
});
const copied = await lumine.workspace.copyPaneItem(moved.item, {
  targetPane: sourcePane,
});
```

Move resolves to `{ pane, item }`; copy resolves to that pair or null when `copy` is absent or `canCopy() === false`. Disabled copy and split-copy silently skip without notifications, provider calls, layout mutation, preview promotion or focus changes. Focus and move, including split-move, remain available. Supply a destination `targetPane` or a relative `splitDirection` (`up`, `down`, `left`, `right`), optionally an insertion `index`. `activatePane: false` suppresses activation. Copy also accepts an `AbortSignal`. Empty `pane.splitUp()`, `splitDown()`, `splitLeft()` and `splitRight()` calls manipulate geometry; item movement and duplication use the Workspace methods.

`workspace.focusPaneInDirection(direction, { sourcePane })` focuses the nearest visible pane, including panes in docks. Window focus commands use `window:focus-pane-up/down/left/right`; item transfer commands use `pane:move-active-item-up/down/left/right` and `pane:copy-active-item-up/down/left/right`. Split commands use `pane:split-<direction>-and-move-active-item` and `pane:split-<direction>-and-copy-active-item`. Core registers these commands once on the workspace and resolves their containing pane from the dispatch target.

## Presentation windows

`workspace.getCenter()` aggregates document panes in every physical window. Its item and editor enumerations and observers include windows created after an observer subscribes. Pane location remains `center`, `left`, `right` or `bottom`; an additional window is a presentation of the workspace center. Obtain local geometry and activity from `editorWindow.getEditorContainer()`. `workspace.getMainWindow()`, `getWindows()` and `observeWindows(callback)` expose current and future presentation windows; `workspace.getWindowForElement(element)` resolves the host of DOM content.

A command event's `context` captures its window, pane, pane item and editor at dispatch. Keep that captured context before awaiting preparation. Global center activity follows editing in any window, while bars and layout commands use their local container. Resolve a keystroke's or context menu's containing editor first; use the captured active editor for a palette or application-menu invocation.

`workspace.detachPane(pane)` and `detachItem(item)` prepare a destination before committing movement. `workspace.attachWindow(editorWindow)` returns its complete layout to main. Transfers preserve the pane/item identities and tab order, validate the source and destination, and restore source ownership if presentation mounting fails. Dock items stay in main. Do not reopen an item by URI or start a replacement terminal or kernel to implement a presentation transfer.

Ordinary DOM views are adopted into the destination document. Use `element.ownerDocument` and `ownerDocument.defaultView` for rendering, focus, coordinates, timers, observers and listeners; use document models for shared content. `didAttachToWindow({ window, document })` binds presentation listeners synchronously on initial mounting and after adoption. Dispose the previous document's subscriptions when changing hosts.

An iframe's browsing context is recreated across documents. A stateful item can implement `prepareWindowChange(context)` to return a state or Promise, `didChangeWindow({ sourceWindow, targetWindow, state, rollback })` to restore it, and `cancelWindowChange({ state })` to release an abandoned preparation. A returned state's optional `dispose()` is called after commit or rollback. Mounting may be asynchronous; core awaits it before releasing a source window. If a native host disappears unexpectedly, recovery sets `sourceUnavailable: true`: return the last captured display state without waiting for the lost frame, and rebuild presentation against the surviving shared document. Core returns those editors to main even when a presentation checkpoint fails. Reject preparation when a view cannot preserve its state so its source remains intact.

Embedded components register the same hooks through `lumine.views.addWindowParticipant(root, component)`, retaining the returned Disposable. Core prepares the item and registered components together, including components added after the item first mounts. `editorWindow.postMessageToFrame(frame, data, origin, ports)` sends from the physical parent realm, so an opaque sandbox can continue authenticating `event.source === window.parent`. Keep the nonce, origin, frame-source and transferred-port checks; do not weaken them because package code belongs to the shared main runtime.

## Saving shared documents

Persist each shared document once in package state and serialize its stable identity from every pane item. View state holds independent cursors, selections, scrolling and layout. Restore the document registry before pane deserializers run so views in separate windows resolve to the same retained document. Preserve unsaved content independently of the backing file; reopening a file cannot reconstruct dirty or untitled pixels or table data.

Call `editor.setSaveConfirmation({ message, detail })` to flag a file whose original contents should only be overwritten deliberately, such as a packaged example. Core asks through a warning notification before writing that path, including Save All and saving while closing. The flag belongs to the shared text buffer and survives workspace restoration. Save As to a different path creates an ordinary editable copy and clears the flag after a successful save. Call `editor.setSaveConfirmation(null)` to remove it explicitly.

The warning offers "Yes, always", "Yes" and "No". "Yes, always" allows saving this buffer for the rest of its session, including automatic saves; "Yes" approves only the current save, and "No" cancels it. Shared editor views use the same choice. Session approval is not serialized, so restoring the buffer asks again. `editor.canSaveAutomatically()` and `buffer.canSaveAutomatically()` let background writers skip flagged buffers until session approval without opening a notification.

A package with asynchronous snapshot work implements `prepareToSerialize(options)`. Core awaits this hook before synchronous `serialize()` when saving the workspace, switching projects or serializing a package for unload. Prepare pending edits, file writes and encodings there; `serialize()` returns JSON-compatible state immediately and propagates failures. If content changes after preparation, throw an error with `code: "STATE_SNAPSHOT_CHANGED"` to request a fresh capture. A failed durable capture keeps the closing window open.

## Implementing copy

The optional `copy({ signal })` method returns a fresh item or a Promise for one. Capture the displayed document and presentation state before asynchronous work. The result must be alive, detached, unowned and allowed at the destination. Construction and state restoration must not activate a pane or take focus; core decides activation when the operation commits.

Document editors share a retained document, including mutable contents, undo history, save state and backing-file observation. Their views keep independent selections, cursors, scrolling and layouts. Read-only result or patch views can clone their displayed snapshot and keep independent mutable buffers and markers. A terminal copy intentionally starts a separate process with the captured shell and working directory.

Check `signal.aborted` before and after awaiting. Core cancels when the source or destination closes, the source changes resource, or the provider disappears. An optional `getPaneItemRevision()` returns a monotonic document generation so replacement at the same URI is also detectable. Expose `onDidChangeURI(callback)` when the represented URI changes; do not reset its generation when navigating back to a previous resource.

The workspace stages a copy before creating its destination split. Disabled copying, a malformed copy or a cancelled operation leaves no empty pane. Source and destination observers receive the final active item after a synchronous commit. A user who navigates elsewhere while a copy prepares keeps their focus and selected tab.

## Lifecycle and focus

Expose `onDidDestroy(callback)` with a disposable subscription and make `destroy()` idempotent. Close one view by releasing its subscriptions and document retain; release shared document resources after its last view closes. Track prepared copies as well as mounted items so package deactivation also destroys copies that never entered the workspace. An aborted preparation must release workers, markers, observers and retained documents.

The item's view root must accept focus or redirect it to a useful remembered descendant. Composite views preserve their active region, such as the selected comparison column, and use a safe root fallback while loading. Delayed document loading can restore state without taking focus again.

Core uses connected DOM moves to preserve iframe runtimes and focused descendants during movement within one document and pane restructuring. Across documents, use the explicit presentation state hooks above. Custom elements in item subtrees implement `connectedMoveCallback()` to preserve their attachment resources; it may update measurements or ancestor-dependent state, but must not perform teardown or recreate the view. Reserve `disconnectedCallback()` for real removal. See the [HTML custom-element move lifecycle](https://html.spec.whatwg.org/dev/custom-elements.html#preserving-custom-element-state-when-moved).

Core routes the twenty directional pane and focus commands from focused iframe documents, including sandboxed notebook results and remote content. Bindings use the parent iframe element's workspace scope. Ordinary input remains in the child document; unsuccessful chords restore the suppressed keys there, and moving preserves the focused descendant.

The workspace registers live pane item frames automatically. A composite view that retains frames after its host retires also owns `lumine.keymaps.registerFrameHost(root)`, which returns a Disposable. Dispose that registration before moving a retired frame into a cache or destroying its host. Child scripts send no keyboard messages or command names to the workspace. Custom keystroke resolver functions disable native frame routing because they cannot cross processes.

For a trusted same-origin viewer that forwards other keyboard events itself, `lumine.keymaps.shouldContinuePendingKeyboardEvent(event, { target: host })` reports whether a plain input event continues that host's pending chord or expected keyup. Forward matching suffixes, including wrong suffixes that end the chord, and keyup events; leave ordinary editable input native.

## Verification

Test the real pane item through `workspace.movePaneItem` and `workspace.copyPaneItem`, including loading, cancellation, pending preview replacement, sibling closure and provider unload. Assert a stable model/root during move, a fresh root during copy, retained shared documents where appropriate, and unchanged focus/layout after rejection. Reacquire package constructors and helpers after unload before testing the next generation. `lem pane-items` detects obsolete command names and removed split options across the active fleet.
