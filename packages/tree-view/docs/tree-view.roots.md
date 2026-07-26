# tree-view.roots

Registers a virtual root section above the project folders — a list of paths the tree shows and navigates like a project, but that no project folder backs.

|             |                                                       |
| ----------- | ----------------------------------------------------- |
| Version     | `1.0.0`                                               |
| Provided by | `provideTreeViewRoots()` returning `{ registerRoot }` |
| Consumed by | `consumeTreeViewRoots(roots)`                         |
| Owner       | `tree-view` (bundled)                                 |

Favourites, recent files, search results — anything that is a set of paths rather than a directory. The section renders with a collapsible header styled like a project root, and its entries behave like ordinary tree entries.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "tree-view.roots": {
      "versions": { "^1.0.0": "consumeTreeViewRoots" }
    }
  }
}
```

## Contract

```ts
type TreeViewRoots = {
  registerRoot(config: RootConfig): RootHandle;
};

type RootConfig = {
  name: string;
  className: string;
  entryClassName: string;
  iconClass: string;
  getEntries(): string[];
};

type RootHandle = {
  readonly element: HTMLElement | null;
  update(): void;
  toggle(): void;
  dispose(): void;
};
```

The config, all five required:

| Field            | Description                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `name`           | Header text, also used as its tooltip.                                                          |
| `className`      | CSS class on the section's root `<ol>`. The header entry gets `<className>-root`.               |
| `entryClassName` | CSS class on each entry `<li>`, for styling the rows.                                           |
| `iconClass`      | Icon class on the header, e.g. `icon-star`.                                                     |
| `getEntries()`   | Returns the absolute paths to show. Called on every refresh — return the current set each time. |

The handle:

| Member      | Description                                                                               |
| ----------- | ----------------------------------------------------------------------------------------- |
| `element`   | The section's root element, or `null` while the tree view is not attached. A live getter. |
| `update()`  | Re-reads `getEntries()` and rebuilds the rows.                                            |
| `toggle()`  | Shows or hides the whole section.                                                         |
| `dispose()` | Unregisters the section and removes it.                                                   |

## Minimal example

```js
const { Disposable } = require("atom");

module.exports = {
  consumeTreeViewRoots(roots) {
    this.root = roots.registerRoot({
      name: "Favourites",
      className: "my-favourites",
      entryClassName: "my-favourites-entry",
      iconClass: "icon-star",
      getEntries: () => this.favourites,
    });
    return new Disposable(() => this.root.dispose());
  },

  addFavourite(filePath) {
    this.favourites.push(filePath);
    this.root.update();
  },
};
```

## Behavior

`getEntries` is a pull, not a push: the tree calls it, so changing your own list does nothing visible until you call `update()`.

Each path is stat'ed when its row is built, and a directory renders as a directory — but a virtual directory does not expand. It reports that it contains nothing, and expanding it is a no-op.

Sections are inserted above the project folder list, in registration order, and survive the tree view being destroyed and re-created: the registration is held by the package, not by the view, and re-attaches on its own.

`element` is a getter that returns `null` rather than throwing when the tree view is not attached, so it is safe to read at any time — but do not cache it.

## Teardown

Call `dispose()` on the handle from the `Disposable` you return. It removes the section and forgets the registration, so it does not come back when the tree view is re-created.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
