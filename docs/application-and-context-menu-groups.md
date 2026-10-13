# Application and context menu groups

Menu groups place related commands together and derive separators from the commands currently available. Packages keep their full command surface under `Packages > <Name>` and add selected headline commands to the appropriate core menus.

## Layout metadata

A submenu owner declares its layout on the parent item. A context-menu owner declares its layout on the descriptor for that surface's selector. Contributors classify their immediate child items without redefining the owner's policy.

| Field        | Declared on                                     | Meaning                                                                                              |
| ------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `groupOrder` | A submenu parent or context selector descriptor | An array of group names in display order.                                                            |
| `group`      | An item inside a grouped menu                   | The group that contains this item.                                                                   |
| `order`      | An item                                         | A finite number that places it within its group or an alphabetical list. Lower numbers appear first. |
| `sortBy`     | A submenu parent or context selector descriptor | Set to `"label"` for an alphabetical list of surfaces.                                               |

Groups appear in `groupOrder` order. Within each group, items with a finite `order` appear before items without one; equal or omitted orders sort by label, ignoring mnemonic `&` markers. Use spaced numbers such as `10`, `20` and `30` so another contribution can fit between existing items.

An unknown or omitted group joins `extensions`. Declare that slot where additional commands belong; for example, core's `File` places it before `close` and `quit`. If an owner omits the `extensions` slot, it is appended after the declared groups.

Empty groups disappear, and exactly one separator appears between the remaining groups. Hidden items and empty submenus do not leave empty groups behind. `groupOrder`, `sortBy`, `group` and `order` describe layout and are removed from the rendered menu.

A submenu without `groupOrder` or `sortBy` preserves its authored action sequence. `order` does not reorder such a sequence. Package-owned command menus can therefore retain their existing order and separators. An alphabetical parent such as `View > Open View` uses `sortBy: "label"`; a finite item `order` takes precedence over the label when supplied.

## Application-menu contributions

Declare contributions under `menu` in `menus/main.json`, or pass the same array to `lumine.menu.add()`. Shared parent items merge by `id`, which defaults to their normalized label. Keep the core parent names and classify only the rows your package contributes. Core retains the layout and position of its own paths, including its Settings and preference-file entries; a package cannot replace that policy by redeclaring the parent.

This is the `fuzzy-files` menu: the headline action joins the real `File` group `files`, while the package keeps both commands under `Packages`.

```json
{
  "menu": [
    {
      "label": "File",
      "submenu": [
        {
          "label": "Find Project File…",
          "command": "fuzzy-files:toggle",
          "group": "files",
          "order": 30
        }
      ]
    },
    {
      "label": "Packages",
      "submenu": [
        {
          "label": "Fuzzy Files",
          "submenu": [
            { "label": "Toggle", "command": "fuzzy-files:toggle" },
            { "label": "Clear Recent Files", "command": "fuzzy-files:clear-recent" }
          ]
        }
      ]
    }
  ]
}
```

Contributions to core menus use `group` and `order` instead of written separators. Choose a group in the immediate parent, rather than a group from another menu with a similar purpose. The platform definitions in `menus/win32.json`, `menus/linux.json` and `menus/darwin.json` contain the current policies.

| Core parent          | Groups in display order                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `File`               | `new`, `files`, `projects`, `save`, `properties`, `external`, `settings`, `preferences`, `extensions`, `close`, `quit`             |
| `Edit`               | `history`, `clipboard`, `editing`, `insert`, `format`, `refactor`, `diagnostics`, `annotations`, `mode`, `extensions`              |
| `View`               | `window`, `panels`, `font`, `appearance`, `extensions`, `developer`                                                                |
| `View > Toggle View` | `panels`, `docks`, `chrome`, `extensions`                                                                                          |
| `View > Editor`      | `grammar`, `appearance`, `structure`, `intelligence`, `editing`, `version-control`, `extensions`                                   |
| `View > Panes`       | `layout`, `items`, `focus`, `transfer`, `extensions`, `close`                                                                      |
| `View > Developer`   | `windows`, `testing`, `services`, `diagnostics`, `inspection`, `extensions`                                                        |
| `Selection`          | `cursors`, `units`, `ranges`, `document`, `structure`, `leaders`, `extensions`                                                     |
| `Search`             | `buffer`, `project`, `results`, `navigation`, `symbols`, `bookmarks`, `changes`, `matches`, `diagnostics`, `extensions`, `history` |
| `Help`               | `documentation`, `examples`, `updates`, `issues`, `extensions`, `about`                                                            |

The `settings` and `preferences` slots keep Settings and the Config, Init Script, Keymap, Snippets and Stylesheet actions together before closing actions on Windows and Linux. macOS keeps those core entries under `Lumine`. Register a package's own configuration commands in its `Packages` submenu.

A package command exposed in the application menu registers once on `lumine-workspace` and resolves the editor or pane item from the dispatch target, falling back to the active item. A menu alias uses the same command as the package submenu. Group metadata changes placement without changing dispatch or keymap scope.

## Context-menu policies and contributions

A context-menu selector accepts either an item array or an object with `items`, `groupOrder` and optional `sortBy`. Use the object form to declare the layout of a surface you own. A package contributing to the editor's existing layout can keep the array form and classify its rows.

The following excerpt shows the object form with real core editor commands and groups:

```json
{
  "context-menu": {
    "lumine-text-editor": {
      "groupOrder": ["history", "clipboard", "extensions"],
      "items": [
        { "label": "Undo", "command": "core:undo", "group": "history", "order": 10 },
        { "label": "Redo", "command": "core:redo", "group": "history", "order": 20 },
        { "label": "Cut", "command": "core:cut", "group": "clipboard", "order": 10 },
        { "label": "Copy", "command": "core:copy", "group": "clipboard", "order": 20 },
        { "label": "Paste", "command": "core:paste", "group": "clipboard", "order": 30 }
      ]
    }
  }
}
```

Core's complete editor policy declares `history`, `clipboard`, `selection`, `editing`, `insert`, `format`, `refactor`, `navigation`, `annotations`, `diagnostics`, `views`, `layout`, `extensions` and `close`, in that order. An editor contribution selects one of those groups; it does not replace the core selector descriptor. Use `:not([mini])` when the action should not appear in find fields or other mini editors.

Policy selection follows the clicked element and its ancestors. The nearest element with a matching policy supplies the layout; if several policies match that element, the most specific selector wins, with the latest registration breaking a tie. A `data-context-menu-boundary` stops inheritance of both menu items and policies, so an embedded surface can own its menu independently of its host.

Grouped definitions and classified contributions need no separator fences. Existing array definitions remain supported, including their fences and `before`, `after`, `beforeGroupContaining` and `afterGroupContaining` references. Unclassified rows retain their authored separator blocks and relative-position rules in the selected policy's `extensions` slot. Relative-position rules also remain available within a named group. Keep existing fences when adding metadata to a legacy contribution; unrelated selectors and embedded surfaces need no conversion.

Declare nested groups on the submenu item that owns them. A submenu does not inherit its parent's `groupOrder`. Its children retain their authored sequence unless that submenu declares its own layout.

## Contextual keyboard shortcuts

Shortcut labels resolve from the menu's invoked element by default. A status or title control whose action applies to an editor can provide `keyBindingTarget` on a runtime row. It accepts an element or a function receiving the invoking element; return the owning editor element, or `null` when its scoped shortcut does not apply. This affects the displayed shortcut only: command dispatch still uses the original menu target and its `commandDetail`.

Rows with `commandDetail` do not automatically borrow the command's shortcut, because keyboard dispatch supplies no such parameters. If a contextual wrapper performs exactly the same operation as a public keyboard command, name that command in `keyBindingCommand`. A combined or behavior-changing variant needs its own command and binding; it must not advertise a standalone action's shortcut. Labels are resolved from current user keymaps each time the menu opens, and lookup-only targets and callbacks are removed from the prepared context-menu template.

```javascript
{
  label: "Sticky Mode",
  command: "column-selection:sticky",
  keyBindingTarget: (target) =>
    lumine.workspace.resolveCommandContext(target).embeddedEditor?.getElement() ?? null
}
```

## Visibility and lifecycle

Register runtime contributions during synchronous package activation and dispose their registrations during deactivation. `lumine.menu.add()` and `lumine.contextMenu.add()` return disposables; menu files are managed by the package lifecycle. Runtime context items can retain `shouldDisplay` and `created` callbacks, so event-specific visibility, labels and command details are resolved for each deployment before layout.

The native application menu and HTML application-menu bars receive the same prepared layout. Context menus use the same group and separator rules after their selector and event filtering. Disabling, unloading or reactivating a package therefore recalculates groups from the remaining contributions, removes empty groups and restores commands to their declared positions. Core-owned submenu paths stay registered even while their rendered contents are empty.
