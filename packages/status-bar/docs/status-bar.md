# status-bar

The status bar's tile collection: a package adds an element to the left or right panel and receives a handle that removes it again.

|             |                                                      |
| ----------- | ---------------------------------------------------- |
| Version     | `1.0.0`                                              |
| Provided by | `provideStatusBar()` returning the four tile methods |
| Consumed by | `consumeStatusBar(statusBar)`                        |
| Owner       | `status-bar` (bundled)                               |

This is the most widely consumed service in the workspace. Read [Tile priorities](#tile-priorities) before picking a number — the ordering is a shared convention, not a free-for-all.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "status-bar": {
      "versions": { "^1.0.0": "consumeStatusBar" }
    }
  }
}
```

## Contract

```ts
type StatusBar = {
  addLeftTile(options: { item: unknown; priority?: number }): Tile;
  addRightTile(options: { item: unknown; priority?: number }): Tile;
  getLeftTiles(): Tile[];
  getRightTiles(): Tile[];
};

type Tile = {
  getItem(): unknown;
  getPriority(): number;
  destroy(): void;
};
```

| Option     | Type   | Description                                                                                                                              |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `item`     | any    | Required. Rendered through `atom.views.getView(item)`, so an `HTMLElement` works directly and a model works if it has a registered view. |
| `priority` | number | Position within the panel. Defaults to one past the last tile, which puts you innermost — always pass one instead.                       |

## Minimal example

```js
const { Disposable } = require("atom");

module.exports = {
  consumeStatusBar(statusBar) {
    const element = document.createElement("div");
    element.classList.add("inline-block");
    element.textContent = "ready";

    const tile = statusBar.addRightTile({ item: element, priority: 310 });
    return new Disposable(() => tile.destroy());
  },
};
```

## Tile priorities

**A lower priority sits closer to its panel's outer edge.** On the left panel that means further left; on the right panel it means further right. Tiles with equal priorities fall back to activation order, which is not stable, so every tile should carry its own number.

Priorities are grouped into bands of 100, numbered from the outer edge inwards, with a step of 10 inside each band so tiles can be inserted later without renumbering. A package that owns several adjacent tiles steps by one from its own slot instead, keeping the band's remaining tens free.

Left panel, from the left edge inwards:

| Priority | Band             | Tiles                                                            |
| -------- | ---------------- | ---------------------------------------------------------------- |
| 110      | Diagnostics      | linter                                                           |
| 210, 220 | Repository       | git-center repository, git-center branch                         |
| 310, 320 | File identity    | editor-status path, grammar-selector (when shown on the left)    |
| 410–450  | Language tooling | jupyter-repl, latex-tools, typst-tools, tasklist-tools, prettier |
| 510, 520 | View info        | editor-status cursor position, image-editor size                 |

Right panel, from the right edge inwards:

| Priority | Band           | Tiles                                                                   |
| -------- | -------------- | ----------------------------------------------------------------------- |
| 110      | Application    | settings-view                                                           |
| 210–243  | Editor modes   | cursor-leader, column-selection, overtype-mode, invert-colors (240–243) |
| 310, 320 | Source control | git-panel, github-panel                                                 |
| 410–430  | File identity  | grammar-selector, encoding-selector, line-ending-selector               |
| 510–540  | Observers      | latex-tools, typst-tools, prettier observed files, ide-client servers   |
| 610      | Activity       | busy-signal                                                             |
| 710, 720 | Warnings       | deprecation-cop, incompatible-packages                                  |

## Behavior

Tiles are inserted in priority order at the moment you add them, so a tile added later still lands in the right place.

The status bar itself lives in a bottom panel, or a footer panel when `status-bar.fullWidth` is on. A tile does not need to know which.

`getLeftTiles` and `getRightTiles` return the live, ordered collections. They are useful for inspection but are not a stable API for mutation — add and remove through tiles you own.

## Teardown

**Always keep the returned tile and `destroy()` it on teardown.** Removing only the element leaves the tile in the bar's ordered collection, and the next insertion positioned against that detached item throws. `Tile.destroy()` does both: it splices the tile out of the collection and removes its view.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
