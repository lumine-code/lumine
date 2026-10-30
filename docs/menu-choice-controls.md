# Menu choice controls

Context menus, the HTML application menu and select-box dropdowns show persistent choice state with outlined controls, including when a choice is off. A square represents an independent checkbox, a circle represents an exclusive radio choice, and a dash represents a mixed checkbox. The owning row remains the only interactive target. Searchable SelectList pickers keep their existing checkmark and italic current-value presentation.

## Command state

Declare persistent state beside its command handler so every menu alias reads the same scoped state. A `checked` Boolean or synchronous function makes the command a checkbox; add `type: "radio"` for an exclusive choice. State functions receive `{target, currentTarget, detail, context}`, with `this` set to the matching registration node, and must be pure and synchronous. They must not load a lazy runtime, perform I/O or dispatch commands. A checkbox may return `"mixed"`; radio choices return only Booleans.

```js
lumine.commands.add("lumine-workspace", {
  "example:toggle-markers": {
    checked: () => lumine.config.get("example.showMarkers"),
    didDispatch() {
      lumine.config.set("example.showMarkers", !lumine.config.get("example.showMarkers"));
    },
  },
});
```

The nearest scoped registration owns the state. At the same node, inline handlers precede selector handlers; selector specificity and reverse registration order match command dispatch. A matching ordinary handler shadows an ancestor's state. Unavailable choices retain their state and are rendered disabled. A throwing or asynchronous command predicate reports its error once and presents an unchecked choice.

Configuration changes and settled command dispatch refresh live menu state. For changes from another source, call `lumine.commands.invalidateAvailability({target})`, or omit `target` for a shared state change. State is read afresh by `lumine.commands.getCommandState(commandName, {target, detail})` and by command presentations.

## Menu-owned choices

A menu row may instead declare `type: "checkbox"` or `type: "radio"` and `checked`. Omitted state on a typed row defaults to false. A row's explicit state overrides its command state; a synchronous `checked({target, detail})` callback is resolved against the row's saved dispatch target. Context-menu `created` callbacks may still assign the row's type and Boolean state at deployment. A group of radio items must share a single domain value; command handlers own exclusivity and persistence.

```js
lumine.menu.add([
  {
    label: "Packages",
    submenu: [
      {
        label: "Example",
        submenu: [{ label: "Markers", command: "example:toggle-markers" }],
      },
    ],
  },
]);
```

HTML menus use `menuitemcheckbox` or `menuitemradio` and `aria-checked`. Indicators are hidden from assistive technology; they contain no nested form input or extra tab stop. Hover and keyboard navigation highlight a row independently of its stored state. Only choice rows reserve space for an indicator. Ordinary actions keep their original left padding; grouping, authored order and separators distinguish actions from related choices. Showing, hiding or focusing a view remains an ordinary action rather than acquiring a checkbox solely because visibility is Boolean.

## Dropdowns and themes

A select-box retains its combobox/listbox semantics. Each option shows an outlined radio indicator for its stored value while the navigation highlight moves independently. Escape cancels navigation without committing a value. Disabled values keep their visible stored state.

The core `.choice-control` primitive owns indicator geometry. Its `data-checked` attribute is `true`, `false` or `mixed`; `.choice-control-radio` selects the circular shape. `aria-hidden="true"` is required on the indicator, and semantics belong on its owner. `data-disabled="true"` dims an unavailable indicator. The public `choice-control-*` theme variables control size, outline, fill, mark and disabled opacity; their defaults are defined in `src/theme-variables.js`. Forced-colors mode uses system colors and preserves the mark shape.

Form checkboxes and radio buttons share their mark geometry with popup indicators. Checkbox corners follow `ui-border-radius` by default. Popup outlines remain visible when unchecked. Themes with a separate checkbox palette can set `choice-control-checkbox-background-color`, `choice-control-checkbox-border-color` and `choice-control-checkbox-mark-color` without changing radio colors. These optional properties default to CSS `initial`, so an unset checkbox palette falls back to the shared state colors. Settings View inherits the theme's normal input palette; its explicit scope-resolution colors remain local to that setting state.

The native macOS application menu uses system rendering. Choice state is resolved in the renderer before serialization; callbacks and DOM targets never cross IPC. Its native checkbox state is Boolean, so a mixed checkbox uses an explicit “(Mixed)” label and remains unchecked rather than falsely claiming a complete selection. Invalid menu-owned callbacks are reported once and fall back to an unchecked choice without preventing the rest of the menu from opening.
