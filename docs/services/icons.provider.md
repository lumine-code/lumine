# icons.provider

Answers what icon a thing should have. The thing may be a file path, a semantic name, a symbol kind, or a pane item, and the answer may be glyph classes, an image, inline SVG, or a letter.

|             |                                         |
| ----------- | --------------------------------------- |
| Version     | `1.0.0`                                 |
| Provided by | `provideIcons()` returning one provider |
| Consumed by | core, in `src/icon-registry.js`         |
| Owner       | the editor itself                       |

This is core's own icon extension point, consumed by `IconRegistry` and used by every view that shows an icon. It replaces the package-to-package `icons.class` and `icons.element` services, which answered only for file paths, only with CSS classes, and could not compose: whoever won the element service took every icon, so two icon packages could not divide the work between them.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "icons.provider": {
      "versions": { "1.0.0": "provideIcons" }
    }
  }
}
```

Core consumes this directly on the service hub, so there is no consumer package to install.

## Contract

```ts
type IconsProvider = {
  iconFor(target: Target): Descriptor | string | string[] | null;
  priority?: number;
  id?: string;
  handles?: Array<"path" | "name" | "kind">;
  usesContext?: boolean;
  async?: boolean;
  onDidChange?(callback: (scope?: Scope) => void): Disposable;
};

type Descriptor =
  | { render: "classes"; classes: string[]; color?: string; title?: string }
  | { render: "image"; source: string; title?: string }
  | {
      render: "svg";
      svg: string;
      viewBox?: string;
      color?: string;
      title?: string;
    }
  | { render: "letter"; letter: string; color?: string; title?: string }
  | { render: "none" };

// Every key is optional; each names part of the cache to drop. No key at all,
// or no scope, means everything.
type Scope = {
  types?: Array<"path" | "name" | "kind">;
  paths?: string[];
  names?: string[];
  kinds?: string[];
};

type Target = {
  type: "path" | "name" | "kind" | "none";
  path: string | null;
  name: string | null;
  kind: string | null;
  item: object | null;
  context: string | null;
  hints: {
    directory?: boolean;
    symlink?: boolean;
    submodule?: boolean;
    repositoryRoot?: boolean;
    expanded?: boolean;
    virtual?: boolean;
  };
};
```

`iconFor` is the only required member. Registering without it, or with a `priority` that is not a finite number, throws a `TypeError`.

| Member                  | Description                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `iconFor(target)`       | Return a descriptor, a class string or array, or **`null` to defer to the next provider**.                                            |
| `priority`              | Higher is consulted first. Must be finite. Core's own providers sit at `-100` and `-90`, so any default-`0` provider outranks them.   |
| `id`                    | Names the provider in error messages. Defaults to a generated one.                                                                    |
| `handles`               | Restricts you to certain target types, so you are not called for the rest.                                                            |
| `usesContext`           | Declare `true` if your answer depends on `target.context`. See below — reading it is not enough.                                      |
| `async`                 | Declare `true` if answers resolve later. **Meaningless without `onDidChange`** — core warns and later answers never reach the screen. |
| `onDidChange(callback)` | Invoke the callback when previous answers have changed. Pass a `Scope` to drop only part of the cache; pass nothing to drop it all.   |

Build the return value with the `Icon` factories rather than by hand — `require("atom")` exports them:

```js
const { Icon } = require("atom");
```

`Icon.classes(names)`, `Icon.image(url)`, `Icon.svg(markup)`, `Icon.letter(char)`, and `Icon.none()`. A bare string or array of strings is coerced to `Icon.classes`.

**`null` and `Icon.none()` are different.** `null` means "not mine, ask the next provider"; `Icon.none()` means "the answer is: no icon", and stops the chain.

## Minimal example

```js
const { Emitter, Icon } = require("atom");

module.exports = {
  provideIcons() {
    const emitter = new Emitter();
    return {
      id: "my-icons",
      priority: 10,
      handles: ["path"],
      iconFor(target) {
        if (target.hints.directory) return null;
        if (!target.path?.endsWith(".rs")) return null;
        return ["my-icon", "my-icon-rust"];
      },
      onDidChange: (callback) => emitter.on("did-change", callback),
    };
  },
};
```

## Behavior

Providers are consulted highest `priority` first, and equal priorities keep registration order. The first non-`null` answer wins, so declining is the hot path — check the target and return `null` cheaply.

**A provider that throws costs only its own icon.** Core catches it, logs once per provider id, and moves to the next one, so one broken provider cannot blank every icon in the window.

Answers are cached per target, with paths in a bounded LRU and names and kinds in plain maps. Core invalidates on exactly four things: the `core.customFileTypes` setting, a grammar being added or updated, a project file being renamed or deleted, and the active theme changing — that last one so a set with a light and a dark palette does not have to watch for it. Anything else that changes your answers is yours to report through `onDidChange`.

`target.hints` carries what the _caller_ knows and the path alone does not say — that an entry is a directory, a symlink, a submodule, a repository root, expanded, or virtual. Prefer them to the filesystem: an answer is cached per distinct target, but a tree still asks about every row it draws. Core's own path provider stats only when the `directory` hint is absent, which is what a hint is for. Note that no consumer sets `expanded` today, so an open-versus-closed folder icon has nothing to branch on yet.

`target.context` names the call site — `"tree-view"`, `"tabs"`, `"search-panel"` and so on. To answer differently per call site you must declare `usesContext: true`; reading `target.context` without declaring it will not work, because the cache key omits the context until some provider opts in, so whichever call site asked first wins for every other. Declaring it multiplies cache entries by call site, so leave it alone unless you need it.

Resetting the window clears every package-supplied provider and re-subscribes, so a provider is re-registered rather than surviving in name only.

**Ship ink, not geometry.** The editor owns every icon's box — a `--component-icon-size` square, `line-height` equal to its height, `vertical-align: text-bottom` — declared once in the base stylesheet and advertised as `--icon-contract: box` on the document root. A provider that inserts its own glyph rules should emit only ink: `font-family`, `content`, color, a `font-size` (ideally as a ratio of `--component-icon-size` so a resized icon column scales the glyph), and at most a small `translate` nudge. Probe the token to keep one package working on editors from before the contract, where self-contained geometry is still needed:

```js
const contract =
  getComputedStyle(document.documentElement).getPropertyValue("--icon-contract").trim() === "box";
```

## Teardown

Core returns a `Disposable` that removes the provider, disposes your `onDidChange` subscription, and clears every cache — not just the answers that came from you, since removing a link changes what the chain returns for targets you never answered. Every icon on screen is then repainted. A provider needs no `dispose` of its own; anything else it allocated — a stylesheet, a worker — it removes on deactivate.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
