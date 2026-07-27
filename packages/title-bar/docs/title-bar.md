# title-bar

The title bar's control tile collection: a package inserts an element beside the window buttons and receives a handle that removes it.

|             |                                                           |
| ----------- | --------------------------------------------------------- |
| Version     | `1.0.0`                                                   |
| Provided by | `provideTitleBar()` returning the control tile collection |
| Consumed by | `consumeTitleBar(titleBar)`                               |
| Owner       | `title-bar` (bundled)                                     |

The same shape as `status-bar`, for the strip at the top of the window rather than the bottom. Reserve it for controls that act on the window itself — layout, presentation, window state — rather than on the file being edited.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "title-bar": {
      "versions": { "^1.0.0": "consumeTitleBar" }
    }
  }
}
```

## Contract

```ts
type TitleBar = {
  addItem(options: { item: HTMLElement; priority?: number }): Tile;
  getTiles(): Tile[];
};

type Tile = {
  getItem(): HTMLElement;
  getPriority(): number;
  destroy(): void;
};
```

| Option     | Description                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `item`     | Required, and an `HTMLElement` — unlike the status bar, this is inserted into the DOM directly rather than through a view registry. |
| `priority` | Defaults to `0`. Lower sits closer to the outer edge; equal priorities fall back to insertion order.                                |

`getTiles()` returns a copy of the ordered list, so mutating it does nothing.

## Minimal example

```js
const { Disposable } = require("atom");

module.exports = {
  consumeTitleBar(titleBar) {
    const button = document.createElement("button");
    button.classList.add("btn", "icon", "icon-versions");
    button.addEventListener("click", () => this.toggleLayout());

    const tile = titleBar.addItem({ item: button, priority: 10 });
    return new Disposable(() => tile.destroy());
  },
};
```

## Behavior

The service is `undefined` when the title bar is not rendered — on platforms or configurations using the native window frame, `provideTitleBar` resolves through an optional chain and yields nothing. **Guard your consumer**: it may be handed `undefined` rather than never being called.

Tiles are inserted in priority order at the moment they are added, so a later tile still lands in the right place.

There are few consumers, so no priority band scheme has been established. Keep numbers small and leave gaps.

## Teardown

Keep the returned tile and `destroy()` it. As with the status bar, removing only the element leaves the tile in the ordered collection and the next insertion positioned against a detached node.

Destroying the title bar destroys every tile it holds, so a tile disposed after that is disposed twice — make your own teardown tolerate it.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
