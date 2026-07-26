# project-list

Exposes the project list manager: which project the window currently has open, and when that changes.

|             |                                              |
| ----------- | -------------------------------------------- |
| Version     | `1.0.0`                                      |
| Provided by | `provideProjectList()` returning the manager |
| Consumed by | `consumeProjectList(projectList)`            |
| Owner       | `project-list` (bundled)                     |

A window's "current project" is a `project-list` concept, not a core one: core knows only about project _folders_. This service is how a title template, a status tile, or a session-scoped feature learns which named project those folders belong to.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "project-list": {
      "versions": { "^1.0.0": "consumeProjectList" }
    }
  }
}
```

## Contract

```ts
type ProjectList = {
  getCurrentProject(): Project | null;
  onDidChangeCurrentProject(callback: (project: Project | null) => void): Disposable;
};
```

| Member                                | Description                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `getCurrentProject()`                 | The project matching the window's current paths, or `null` when the folders match no entry. |
| `onDidChangeCurrentProject(callback)` | Fires when the resolved project changes, including to `null`. Returns a `Disposable`.       |

The service is the manager instance itself, so other members are visible on it. Only these two are the contract; treat the rest as internal.

There is no method for opening the list. A consumer that wants to offer that as an action dispatches the `project-list:toggle` command and uses the service purely as a presence signal — receiving it means the package is installed, so the affordance can be shown. This is what the tree view's empty-project view does.

## Minimal example

```js
const { CompositeDisposable, Disposable } = require("atom");

module.exports = {
  consumeProjectList(projectList) {
    const disposables = new CompositeDisposable();
    this.render(projectList.getCurrentProject());
    disposables.add(
      projectList.onDidChangeCurrentProject((project) => this.render(project)),
      new Disposable(() => this.render(null)),
    );
    return disposables;
  },
};
```

## Behavior

The current project is **resolved from the window's project folders**, not stored: `project-list` compares the open paths against its configured entries. Adding or removing a folder can therefore change the answer, and a window whose folders match nothing resolves to `null`.

`onDidChangeCurrentProject` fires only when the resolved project actually changes, not on every folder change, and the comparison is by identity of the entry rather than by object — so a re-read of the config that produces an equal entry does not fire.

It does **not** replay the current value on subscribe. Read `getCurrentProject()` yourself for the initial state, as the example does.

## Teardown

Return a `Disposable` that unsubscribes and resets whatever you rendered. The manager outlives your consumer, so leaving a subscription attached keeps your callback alive for the life of the window.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
