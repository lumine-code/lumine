# Developing a package

A package adds features to Lumine. Because so much of the editor is itself made of packages, writing one gives you the same reach as the core.

## Anatomy of a package

A package is a directory with a `package.json` and some code:

```
my-package/
  package.json
  lib/
    my-package.js
  keymaps/
    main.json
  menus/
    main.json
  styles/
    main.css
  spec/
```

`keymaps/`, `menus/`, `styles/`, `snippets/` and `settings/` are each loaded by a directory scan, so the file name is free — the editor identifies every file it finds by its full path. A directory holding exactly one file names it `main`; a directory holding several keeps descriptive names for all of them, because alphabetical order there is load order.

Key `package.json` fields:

- **`name`** — the package's identity: its command prefix and config namespace, and what the editor loads it under. The directory it lives in need not match. See [Managing packages](https://lumine-code.github.io/docs.html#packages-and-themes/managing-packages).
- **`main`** — the entry module (for example `./lib/my-package`).
- **`version`** and **`engines`** — `"engines": { "lumine": "^1.0.0" }`; the `lumine` key is also what marks the manifest as a package.
- **`activate()`** — runs during eager package bootstrap; register commands, openers, hooks, and service facades here, and keep expensive work behind package-owned `ensure` functions.
- **`configSchema`** — declares the package's settings so they appear in the Settings view; add `scopeResolution` (`grammar` or `syntax`) to an individual entry when its consumer resolves contextually. Omit it for the usual `base` behavior; an explicit `base` remains valid when useful for overriding inherited schema metadata.
- **`providedServices`** / **`consumedServices`** — how packages offer and use functionality from one another.
- **`requiresRestartOnUpdate`** — set this to `true` only when a live renderer cannot safely replace the package's module identities, such as a package whose registered custom-element constructor closes over generation-specific model classes. The updater deactivates it, preserves the old module graph for rollback, swaps the files, and waits for the prompted restart before loading the new generation.

The entry module exports lifecycle methods — most importantly `activate()`, where you register commands, open UI, and subscribe to events, and `deactivate()`, where you dispose of them.

```js
module.exports = {
  activate() {
    this.sub = lumine.commands.add("lumine-workspace", {
      "my-package:hello": {
        description: "Show the greeting notification.",
        didDispatch: () => lumine.notifications.addSuccess("Hello!"),
      },
    });
  },
  deactivate() {
    this.sub.dispose();
  },
};
```

## CommonJS and native ESM

CommonJS and native ES modules can coexist in one package. Use `.cjs` for an explicit CommonJS file, `.mjs` for an explicit ES module, or `"type": "module"` in `package.json` to make `.js` files ESM. Set `main` to the entry file, including its extension. Babel removes JSX, TypeScript types and legacy syntax while preserving `import`, `export` and asynchronous `import()`.

Native relative imports include the full filename: `import View from "./view.jsx"` or `import helper from "./helper.js"`. JSON imports require an attribute: `import config from "./config.json" with { type: "json" }`. Native ESM does not provide CommonJS's `require`, `module`, `exports` or `__dirname`; use `import.meta.dirname`, `import.meta.filename` and `new URL("./asset.svg", import.meta.url)` for source-relative paths. Both `import { Disposable } from "lumine"` and `require("lumine")` expose the same editor API.

The package entry is loaded synchronously before bootstrap. Its ESM graph must therefore be synchronous too: keep top-level `await` in implementations loaded lazily with `await import("./implementation.js")`, where initialization can be awaited. A CommonJS consumer of an ESM default export reads `require("./view.mjs").default`; a native import uses `import View from "./view.mjs"`. TypeScript's explicit CommonJS `export = value` remains supported in CommonJS files.

Each loaded package has a module generation. A normal unload advances that generation, so the next load gets fresh JavaScript, JSX, TypeScript and JSON modules. Old callbacks retain the dependencies of their own generation. An unload with `preserveModuleCache: true` retains the same identities for updater rollback. Public source paths and source maps still refer to the real files; the loader's private generation filenames are not files on disk. Node retains retired ESM generations until the window closes, so `deactivate()` must dispose subscriptions, services, views and other resources independently of module-cache cleanup.

For lazy CommonJS dependencies inside an ESM implementation, use the generation-bound `import.meta.require` supplied by the editor. The fallback keeps the module usable in ordinary Node:

```js
import { createRequire } from "node:module";

const require = import.meta.require ?? createRequire(import.meta.url);
```

A lifecycle spec that unloads a package reacquires its constructors and services from the current package generation. A top-level native import, `import.meta.require` or a CommonJS spec's local `require` deliberately stays with the spec's original generation. Use the current `Package.mainModule` or a fresh `createRequire(import.meta.url)` in ESM and `createRequire(__filename)` in CommonJS when the spec needs the replacement generation. Task handlers can also export their function as a native ESM default; asynchronous imports inside a handler complete through its existing `this.async()` callback.

## Bootstrap and lazy work

`activate(state, {signal, cause})` is synchronous. Register public commands, openers, hooks, and services before it returns; command handlers and openers can call package-owned `ensure` functions to load heavy modules on first use. A service consumer is passive and never activates its provider, so a provider should publish a lightweight facade whose methods can load the expensive implementation asynchronously.

Use native `import()` in those asynchronous methods when a dependency exposes an ESM build, uses top-level `await` or must initialize on first use. Await it before using its exports, and share an initialization promise where callers can overlap. The editor's Node-loaded package modules use Node resolution and conditional `import` exports; code embedded in an isolated browser frame uses the frame's browser loader instead and needs browser URLs or its own bundled assets.

Window hooks are available through `lumine.hooks`. Core emits one-shot events such as `core:pane-item-used`, `core:text-editor-used`, and `core:grammar-used`; packages subscribe in `activate()` and dispose subscriptions in `deactivate()`.

## Opening a text editor

Build and populate a detached editor, then open it in the workspace:

```js
const editor = lumine.workspace.buildTextEditor();
editor.setText("Generated text\n");
await lumine.workspace.open(editor);
```

A non-mini text editor without an explicit `autoHeight` setting adopts the pane's height when it becomes a pane item, so long content scrolls normally. This also applies to custom openers, direct `pane.addItem()` calls, docks and restored editors. Detached editors and editors embedded inside another view keep their content-based height. Pass `autoHeight: true` or `false` when the view deliberately owns that choice; core preserves explicit settings.

Custom center items optionally implement `copy({ signal })` to support another view. Copying silently skips when that method is absent or the optional `canCopy()` returns false. Resource uniqueness independently uses `getSingletonKey()`. The workspace provides the shared focus, move and copy commands; see [Pane items](pane-items.md) for identity, document ownership and lifecycle requirements.

## Revealing positions

The text editor's `scrollToBufferPosition`, `scrollToScreenPosition`, `scrollToScreenRange`, and `scrollToCursorPosition` methods accept one `mode` option:

| Mode                           | Behavior                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `"nearest"`                    | Default. Reveal the position or range with the smallest necessary scroll.      |
| `"zone"`                       | Use the live `editor.scrollZone` setting for this editor's root grammar scope. |
| `"center"`                     | Center the position or range.                                                  |
| A number                       | Pin the position or range to that vertical percentage, from `0` to `100`.      |
| An array of one or two numbers | Use explicit landing percentages, preserving their order.                      |

Use `mode: "zone"` for a navigation destination, and keep the nearest default for editing or extending selections. Read [Customization](https://lumine-code.github.io/docs.html#customization/personalizing-lumine) for shared scrolling settings. `getScrollZone()` reads the shared setting in the target editor's root scope; packages need no copy of that setting. `scrollToZone()` reveals the last cursor with this mode, and the `editor:scroll-to-zone` command exposes the same action.

```js
// Navigate and reveal the destination in the shared zone.
editor.setCursorBufferPosition([line, column], { mode: "zone" });
editor.setSelectedBufferRange(range, { mode: "zone" });

// Reveal a position without moving the cursor or changing selections.
editor.scrollToBufferPosition([line, column], { mode: "zone" });
editor.scrollToCursorPosition({ mode: "center" });
editor.scrollToScreenRange(screenRange, { mode: [70, 20], reversed: false });

// Keep exact viewport restoration separate from revealing a destination.
editor.setCursorBufferPosition(savedPosition, { autoscroll: false });
```

Cursor and selection setters forward `mode` when their normal autoscroll runs; `autoscroll: false` suppresses it. Range reveals retain the `reversed` and `clip` options, and modes affect vertical placement while horizontal scrolling still reveals the range. The API uses `mode` only; `center` and `zone` options are rejected. `workspace.open(uri, { initialLine, initialColumn })` reveals the initial location in the shared zone, while opening without an initial location preserves the existing viewport.

## Observing text changes

Buffer changes carry `origin`: `edit` for editor and API mutations, `reload` for text loaded from the backing file, and `mixed` when a transaction combines both. All origins reach text consumers, so syntax, language servers and decorations follow external edits. Automatic editing assistance should inspect this origin before opening UI or modifying text. `textChanged` on a cursor or selection event means that text moved the marker; its `origin` tells you whether that came from a reload.

`onDidStopChanging` exposes the combined `changes` plus immutable `transactions` in application order. Each transaction has its own `origin` and `changes`, with ranges in that transaction's coordinates. Use the last transaction for an action that depends on the latest insertion: typing immediately after a reload can share the same idle interval. Use `onWillReload` to cancel pending suggestions or signatures and end snippet expansions before the patch moves their markers. See [Buffer change origins](file-watching.md#buffer-change-origins) for the contract.

## Writing views in JSX

Give a file the `.jsx` extension and Lumine compiles it through Babel on load — no build step and no configuration. Name the factory the file's tags compile to in a `/** @jsx … */` pragma at the top; for a Lumine view that is `etch.dom`, the virtual-DOM helper the editor's own views are written with, so a view is a plain object with `render` and `update` methods:

```jsx
/** @jsx etch.dom */

const etch = require("@lumine-code/etch");

module.exports = class GreetingView {
  constructor(name) {
    this.name = name;
    etch.initialize(this);
  }

  render() {
    return <div className="greeting">Hello, {this.name}</div>;
  }

  update() {}
};
```

Require the file the way you would any other — `require("./greeting-view")` resolves `.jsx` without the extension — and remember to require `etch` itself, since the compiled JSX calls into it.

The pragma is required. Compiling a file that omits one falls back to `etch.dom`, but Lumine's lint configuration fails any JSX file without a pragma, and every package in the ecosystem carries one: what a tag compiles to should be readable in the file rather than inherited from a build option in another repository. It is also what makes a package that mixes two factories work with no configuration at all — write `/** @jsx myLibrary.createElement */` to compile with something other than etch.

Use `<>…</>` to group siblings without wrapping them in an element. A fragment compiles to its own factory, so a file that uses one declares that too:

```jsx
/** @jsx etch.dom */
/** @jsxFrag etch.Fragment */
```

A component still has to render a single root element, so a fragment belongs inside one rather than at the top of `render`.

The same pragmas and the same defaults apply to `.tsx`, which the editor compiles through Babel too. A `.js` file that opens with `"use babel"` or `/** @babel */` also uses Babel.

## Writing TypeScript

Lumine automatically transpiles `.ts` and `.tsx` files through Babel when they load, with no build step or compiler dependency in your package. Babel removes type syntax and converts imports and exports to CommonJS; `.tsx` also uses the JSX factories described above.

Babel processes each file independently and does not check types or read your `tsconfig.json`. For type checking, add `typescript` to your package's `devDependencies`, configure a `tsconfig.json`, and run `npx tsc --noEmit` during development or in CI.

If your package needs TypeScript compiler options or behavior beyond the editor's transpilation, use your own build step and point `package.json`'s `main` at the generated JavaScript.

## Putting something in a bar

The status bar and title bar host one element per control. Hand the bar a plain custom element, bind its click and tooltip there, and use a tile group when several controls belong together.

The bar adds `.status-bar-item` or `.title-bar-item`; packages must not add those classes themselves. Tile priorities, grouping and styling contracts live in the [`status-bar`](https://github.com/lumine-code/status-bar/blob/master/docs/status-bar.md) and [`title-bar`](https://github.com/lumine-code/title-bar/blob/master/docs/title-bar.md) documentation, also available under Settings → the package → Documentation.

## Developing against a live editor

Symlink your working copy into Lumine and load it in development mode:

```sh
lumine --link . --dev     # link into ~/.lumine/packages-dev
lumine --dev .            # open a dev-mode window that loads dev packages
```

Dev-mode windows load packages from `~/.lumine/packages-dev`, enable developer tooling, and let you reload quickly with `window:reload`. A package there shadows an installed or bundled package of the same name, so your checkout is the one that runs. When you are done, `lumine --unlink .` removes the link.

## The API

Everything you can do is reachable through the global `lumine` object. Its classes and methods are documented in the [Lumine API reference](https://lumine-code.github.io/api/), generated from Lumine's own source. Install the optional [`autocomplete-lumine`](https://github.com/lumine-code/autocomplete-lumine) package to complete this API as you type.

### Configuration in one window

Use `lumine.config.set(key, value, { local: true })` for a temporary setting in the current window and `lumine.config.unset(key, { local: true })` to remove it. Both accept the usual `scopeSelector` option. Local values are validated against the same schema as saved values, and `get()`, `getAll()`, `observe()`, and `onDidChange()` include them automatically through normal configuration resolution.

Local values replace the corresponding entries in the user source, so project settings and more specific selectors keep their existing priority. They survive config-file synchronization but disappear on window reload or close. A normal `set()` removes the local override for the key and selector it writes; ordinary commands therefore continue to make global changes unless they explicitly choose `local: true`.

Set `allowLocal: false` on a schema entry when its consumer cannot apply settings within an individual renderer, such as a setting read only by the main application process. A local write to such an entry returns `false`, and a bulk local write containing it is rejected without partial changes. Local writes may only target the user source; requesting a different `source` with `local: true` throws `TypeError`. See [Customization](https://lumine-code.github.io/docs.html#customization/personalizing-lumine) for the Settings controls and the [Config API](https://lumine-code.github.io/api/#class-config) for the full contract.

## Next

- [Writing specs](writing-specs.md) — test your package.
- [Handling URIs](handling-uris.md) — respond to `lumine://` links.
- [Watching files and directories](file-watching.md) — keep disk-backed state current and handle recovery.
- [Publishing a package](publishing-a-package.md) — share it with others.
