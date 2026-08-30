# Detached panes

A detached pane is a one-item pane from the workspace center presented in a native window of its own.

Detached panes do not create another `Environment`, `Workspace`, `Project`, package manager, pane item, buffer, or provider session. The child window has its own `Window` and `Document`, but it is controlled by the opener's renderer and presents the same pane-item model and view objects.

## Invariants

- A `DetachedPane` belongs to `workspace.getCenter()` and is returned by `paneForItem()` and the center's normal pane and item enumeration.
- A detached pane contains exactly one item, has no `PaneAxis` parent, and never participates in tiled layout calculations.
- `getPanes()` includes tiled and detached panes; spatial code uses `getTiledPanes()`.
- Opening a new item always targets a tiled pane. An already-open detached item is activated in its existing window.
- Detaching and attaching transfer ownership atomically and emit no workspace-level item add or destroy event.
- Closing a detached native window closes its item through the normal save prompt. Attaching it is nondestructive and prompts for nothing.
- A detached child cannot outlive its logical Lumine window and is not stored as an application-level project window.

## Opening and attaching

Detachment is always explicit. Normal openers and unaccepted tab drags leave items tiled; the core `pane:detach-item` command, also exposed in the tab context menu, calls `await lumine.workspace.detachPaneItem(item)`. The titlebar pin calls `await lumine.workspace.attachDetachedPane(pane)`.

The return target is the original tiled pane and tab index while that pane exists, then the active tiled pane, then the center root. A new open or split requested from a detached item uses the same tiled target and never adds a second item to the detached pane.

Native window commands target the surface that received them: close, minimize, maximize, full screen, and developer tools act on that detached `BrowserWindow`. Reload is deliberately different because a detached child is not independently bootstrapped: `window:reload` reloads the owning editor window, which tears down and rebuilds all of its surfaces; reloading only the child's `webContents` would discard its mounted pane without a renderer lifecycle capable of restoring it.

## DOM realms

Every movable pane-item view must use its element's realm. Create nodes through `element.ownerDocument`, subscribe to globals through `element.ownerDocument.defaultView`, and use that window's `requestAnimationFrame`, `ResizeObserver`, `getComputedStyle`, and DOM constructors.

The child navigates to the internal `static/detached-pane.html` document with Node integration disabled. Do not replace it with `about:blank`: Electron copies the opener's privileged web preferences to a synchronous blank child and cannot override them on that path.

`lumine.workspace.observePaneItemSurface(item, callback)` is a post-commit observer: it runs immediately and after a complete successful move, never while the model and DOM disagree and never for a rolled-back move. `getWindowSurface(item)` returns a surface with `id`, `kind`, `window`, `document`, `element`, `onDidFocus()` and `onDidBlur()`.

A movable item that must stop a native renderer or remove document/window listeners before adoption implements `async beginWindowSurfaceTransition(context)`. It runs while the old DOM is still connected and receives a frozen `{id, reason, item, from, to, signal}` context, where `reason` is `detach`, `attach`, `restore`, or `recovery`. It may return `{async commit(context), async rollback(context)}`: `commit` runs after the same DOM has been adopted and connected in `to`, and must finish every realm-local rebuild before the native child is shown; if preparation, movement, rebuild, or native commit fails, core physically restores the DOM and model to `from` before calling `rollback` in reverse participant order. Services that are not owned by the item register the same participant contract through `workspace.addWindowSurfaceTransitionObserver(callback)`.

`recovery` is the crash-only exception: its native source is already dead, so core runs preparation best-effort, physically attaches the item to primary, and awaits `commit` there before publishing the surface change. A failed recovery commit cannot roll back to a destroyed renderer; core keeps the only live model in primary, aborts the transition, reports the error, and emits no successful surface-change event.

Custom elements intended for movable views are registered through `lumine.elements.define()`, whose factory receives the target window's `HTMLElement`, `window`, and `document`. A custom-element constructor from one realm must never be registered in another realm.

A UMD runtime that binds itself to `window` must be loaded in the destination realm with `await lumine.dom.loadScript(surface.document, sourcePathOrURL, {global: "LibraryName"})`. The loader converts filesystem paths to `file:` URLs, caches one execution per source and `Document`, returns the named child-window global, and rejects on load failure or window closure; it never falls back to `require()` in the privileged primary realm.

## Chrome and overlays

A detached surface contains the pane, a pin control, and a transient modal overlay. It has no tab bar, dock, status bar, or tiled pane axis. Package-owned dock panels remain in the primary window and may continue to follow the active detached center item.

Modal lists and input dialogs should pass their owning pane item as `owner`; this presents them in the owner's current surface while leaving application-level notifications and permanent panels in the primary window. A reusable dialog keeps one `Panel` identity and a validated route: an owner-routed panel follows its item through detach, attach, and rollback and is destroyed with that item; an explicit `surface` stays fixed while it is live; and an unowned dialog captures the active surface on each explicit show. Moving a visible panel preserves visibility, focused content, prior-focus restoration, and the complete modal flow without emitting synthetic hide/show events. `Panel#onDidChangeDocument` is the hook for rebuilding browser objects tied to the old realm, while `Panel#isTransferring()` distinguishes adoption blur from dismissal. Detached-surface teardown rehomes every surviving relocatable panel to primary before destroying the child container.
