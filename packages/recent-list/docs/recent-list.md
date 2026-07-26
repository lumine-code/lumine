# recent-list

Opens the recent-projects list, so a package can offer it as an action without depending on the command.

|             |                                              |
| ----------- | -------------------------------------------- |
| Version     | `1.0.0`                                      |
| Provided by | `provideRecentList()` returning `{ toggle }` |
| Consumed by | `consumeRecentList(recentList)`              |
| Owner       | `recent-list` (bundled)                      |

Deliberately narrow: it exposes the action, not the list. A consumer can put a "Reopen a project" button somewhere — the empty project view does exactly this — without reaching into how recent projects are stored.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "recent-list": {
      "versions": { "^1.0.0": "consumeRecentList" }
    }
  }
}
```

## Contract

```ts
type RecentList = {
  toggle(): void;
};
```

`toggle()` shows the recent-projects list, or hides it if it is already open. There is no way to read the entries, and none to open a specific one — dispatching the package's own command does the same thing, so use this only when you need the affordance to disappear when the package is absent.

## Minimal example

```js
const { Disposable } = require("atom");

module.exports = {
  consumeRecentList(recentList) {
    this.button.hidden = false;
    this.button.addEventListener("click", () => recentList.toggle());
    return new Disposable(() => (this.button.hidden = true));
  },
};
```

## Behavior

The point of consuming this rather than dispatching `recent-list:toggle` is that your consumer method is never called when the package is missing, so the button can be hidden by default and revealed only when the action exists. Dispatching a command for an absent package silently does nothing and leaves a dead control on screen.

`toggle()` is synchronous and returns nothing.

## Teardown

Return a `Disposable` that hides or removes whatever affordance you added. The service holds nothing on your behalf.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
