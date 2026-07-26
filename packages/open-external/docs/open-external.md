# open-external

Opens a path in the system's default application or reveals it in the file manager, and lets a package take over either operation.

|             |                                                         |
| ----------- | ------------------------------------------------------- |
| Version     | `1.0.0`                                                 |
| Provided by | `provideOpenExternal()` returning three functions       |
| Consumed by | `consumeOpenExternal(service)` returning a `Disposable` |
| Owner       | `open-external` (bundled)                               |

Two audiences share one service. Most consumers only call `openExternal` or `showInFolder`; a package that integrates a specific file manager registers a handler instead and intercepts everyone else's calls.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "open-external": {
      "versions": { "^1.0.0": "consumeOpenExternal" }
    }
  }
}
```

## Contract

```ts
type OpenExternal = {
  openExternal(filePath: string): void;
  showInFolder(filePath: string): void;
  registerHandler(handler: Handler): Disposable;
};

type Handler = {
  priority: number;
  openExternal?(filePath: string): boolean | undefined;
  showInFolder?(filePath: string): boolean | undefined;
};
```

| Member                     | Description                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `openExternal(filePath)`   | Opens the path with whatever the platform associates with it.                                 |
| `showInFolder(filePath)`   | Reveals the path in the file manager, selecting it.                                           |
| `registerHandler(handler)` | Inserts a handler into the priority-ordered chain and returns a `Disposable` that removes it. |

A handler must have a **finite `priority`** and at least one of the two operations; anything else throws a `TypeError` at registration. Higher priority is consulted first.

## Minimal example

Calling the service:

```js
const { Disposable } = require("atom");

module.exports = {
  consumeOpenExternal(service) {
    this.openExternal = service;
    return new Disposable(() => (this.openExternal = null));
  },

  revealActiveFile() {
    const filePath = atom.workspace.getActiveTextEditor()?.getPath();
    if (filePath) this.openExternal.showInFolder(filePath);
  },
};
```

Taking over an operation:

```js
consumeOpenExternal(service) {
  return service.registerHandler({
    priority: 100,
    showInFolder: (filePath) => {
      if (!this.fileManagerIsInstalled()) return false;
      this.launchFileManager(filePath);
      return true;
    },
  });
}
```

## Behavior

Handlers form a chain ordered by descending priority. A handler claims the call by returning a truthy value; returning falsy — or not implementing that operation at all — passes it to the next one. The built-in platform behavior is the end of the chain, so declining always ends somewhere sensible.

Register a handler only when it can actually do the job. A handler that claims `showInFolder` and then fails silently leaves the user with nothing, because the platform fallback was skipped.

Both operations take a path, not a URI, and neither validates that it exists.

## Teardown

`registerHandler` returns a `Disposable` that removes the handler from the chain; return it directly from `consumeOpenExternal` when the handler is all you registered. A consumer that only calls the service should still return a `Disposable` that drops its reference.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
