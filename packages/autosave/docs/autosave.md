# autosave

Registers a veto: a predicate that stops autosave from writing a particular pane item.

|             |                                                |
| ----------- | ---------------------------------------------- |
| Version     | `1.0.0`                                        |
| Provided by | `provideAutosave()` returning `{ dontSaveIf }` |
| Consumed by | `consumeAutosave(service)`                     |
| Owner       | `autosave` (bundled)                           |

**No package consumes this today.** It is an extension point for items that must not be written behind the user's back — a scratch buffer, a remote file mid-transfer, a generated view that happens to be backed by a real path.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "autosave": {
      "versions": { "^1.0.0": "consumeAutosave" }
    }
  }
}
```

## Contract

```ts
type Autosave = {
  dontSaveIf(predicate: (paneItem: object) => boolean): void;
};
```

`dontSaveIf` registers a predicate and returns `undefined`. Autosave writes an item only when **every** registered predicate returns falsy for it, so returning `true` vetoes the save.

## Minimal example

```js
module.exports = {
  consumeAutosave({ dontSaveIf }) {
    dontSaveIf((paneItem) => paneItem instanceof MyScratchView);
  },
};
```

## Behavior

The predicate is called for every pane item autosave considers — on window blur, on editor blur, and for each item when saving everything — so it must be synchronous and cheap.

It receives arbitrary pane items, not just text editors. Guard with an `instanceof` or a duck-typed check before touching properties.

A veto is absolute: one predicate returning `true` prevents the save regardless of what any other package registered.

## Teardown

**There is no way to unregister a predicate.** `dontSaveIf` returns nothing and the list only grows, so a package that deactivates leaves its predicate behind. Write predicates that stay correct once your package is gone — test `instanceof` against a class that will simply have no instances, rather than reading state you will have torn down.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
