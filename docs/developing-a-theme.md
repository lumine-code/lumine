# Developing a theme

A theme is a package that changes how Lumine looks. There are two kinds, and a package may provide either:

- **UI themes** style the interface — panels, tabs, the tree view, the status bar.
- **Syntax themes** style the code — the colors applied to your grammar's scopes.

## Anatomy of a theme

A theme is a package whose `package.json` declares its kind:

```json
{
  "name": "my-syntax",
  "version": "0.1.0",
  "theme": "syntax",
  "styleSheets": ["main"],
  "engines": { "lumine": "^1.0.0" }
}
```

Set `"theme"` to `"ui"` or `"syntax"`. A single-theme package loads the CSS files named by `styleSheets` from its `styles/` directory; with one `styles/main.css`, the field may be omitted because Lumine scans that directory. The CSS uses custom properties, as the bundled themes do.

## Use custom properties

The [theme variable contract](theme-variables.md) describes the public tokens, their roles and types, and which values a theme owns. The Styleguide reads the same contract from the editor and shows its active values.

Lumine's theming is built on **CSS custom properties**. Define your palette as properties and consume them throughout, so the theme is consistent and easy to adjust:

```css
:root {
  --text-color: #e6e6e6;
  --base-background-color: #1b1f23;
}
```

The bundled **`one-theme`** package is the reference implementation: a single package that ships light and dark variants for both UI and syntax (**one-day-ui** / **one-night-ui** and **one-day-syntax** / **one-night-syntax**). Reading it is the best way to see how a complete theme is structured.

Define the accent group — `--accent-indicator-color`, `--accent-indicator-text-color`, `--accent-background-color`, `--accent-foreground-color`, `--accent-link-color` — as you would any other palette entry. A user who sets **Accent Source** to `system` replaces the two fill colors with the operating system's accent and derives the text on them from it, so pick foregrounds that read against your own accent and let that setting handle the rest. `--accent-link-color`, which puts the accent on your background rather than under it, is always yours.

## Provide a family of themes

A package can expose several independently selectable themes through a `themes` array. This is useful when light and dark UI and syntax themes belong to one family:

```json
{
  "name": "my-theme-family",
  "version": "0.1.0",
  "themes": [
    {
      "name": "my-day-ui",
      "theme": "ui",
      "styles": ["styles/ui", "styles/day-ui"]
    },
    {
      "name": "my-day-syntax",
      "theme": "syntax",
      "styles": ["styles/syntax", "styles/day-syntax"]
    },
    {
      "name": "my-night-ui",
      "theme": "ui",
      "styles": ["styles/ui", "styles/night-ui"]
    },
    {
      "name": "my-night-syntax",
      "theme": "syntax",
      "styles": ["styles/syntax", "styles/night-syntax"]
    }
  ],
  "themePacks": [
    {
      "name": "My Theme",
      "light": ["my-day-ui", "my-day-syntax"],
      "dark": ["my-night-ui", "my-night-syntax"]
    }
  ],
  "engines": { "lumine": "^1.0.0" }
}
```

Each `themes` entry becomes its own virtual theme package. Its `name` is what users select, `theme` is either `ui` or `syntax`, and `styles` is a package-relative directory or an ordered list of directories. The containing package still owns shared JavaScript and configuration, but those are not copied into its virtual themes.

`themePacks` groups the complete UI and syntax stacks for light and dark appearance modes. Its `name` is user-facing, and each side is a non-empty ordered array of names declared by this package or another installed theme package.

The list is what keeps a family from duplicating itself. Put the rules in a shared directory and the colors in a per-variant one, and the light and dark members of a pair differ only in the `variables.css` they load last — a syntax theme's scope-to-color mapping is written once, not once per variant.

## Extend another theme's styles

A theme in a `themes` array can build on styles from another package with `extends`. The value is either one package-qualified glob:

```json
{
  "name": "my-day-ui",
  "theme": "ui",
  "extends": "one-theme::styles/ui/*",
  "styles": ["styles/ui-overrides", "styles/day-ui"]
}
```

or an ordered list:

```json
{
  "name": "my-day-ui",
  "theme": "ui",
  "extends": ["one-theme::styles/ui/*", "my-theme-foundation::styles/accessibility/**/*.css"],
  "styles": ["styles/ui-overrides", "styles/day-ui"]
}
```

The part before `::` is a package name. The part after it is a glob relative to that package. Scoped package names are valid because `::`, rather than `/`, separates the two parts.

Lumine builds the cascade in this order:

1. Process `extends` entries in their declared order.
2. Sort the `.css` files matched by each glob and load them.
3. Load the theme's own `styles` directories in their declared order.

Overlapping globs do not load the same file twice. There is no filename replacement: extended and local stylesheets both load, so ordinary CSS specificity and source order determine the result. Keep only real differences in the local override sheets. When the parent sets a declaration that the child does not want, reset it explicitly in the child.

Referencing a package through `extends` does not activate that package's JavaScript or add its theme class. Only include reusable styles in the matched path; package-specific settings should live outside it.

If the chain contains more than one `variables.css`, Lumine applies them in the same order. Put the derived theme's palette in its final `styles` directory so its custom properties win. Development live reload also watches the extended glob roots.

## An editor is an input because it says so

Some editors are documents and some are form controls: the select-list query, a search field, a multi-line expression box. A form control marks itself with the `input` attribute, which `mini` implies, so one selector reaches both:

```css
lumine-text-editor[input] {
}
lumine-text-editor[input].is-focused {
}
```

The editor draws the resting box — border, radius, and the single-line background — alongside the other input controls, so a marked editor and an `.input-text` match without either side tuning the other. A theme owns the colours and the focus ring, exactly as it does for those controls.

What a theme must never do is infer the role from position. `lumine-panel-container lumine-text-editor` looks like "editors in the UI", but it matches every dock and no centre pane, so the same field is styled differently depending on where its panel happens to be docked, while a read-only diff viewer picks up an input ring for no reason but its location. The bundled themes are checked mechanically (`npm run check:editors` in the editor repository fails on any such selector).

A package marks its own editor and needs no CSS for the box:

```js
const editor = lumine.workspace.buildTextEditor({ softWrapped: true });
editor.element.setAttribute("input", "");
```

Size stays the widget's business — a field that should grow with its content and one that should scroll after ten lines are both legitimate, so the editor ships neither.

## Style the active line number

The standard line-number gutter marks the primary cursor's buffer row with `.active-line-number`. The class follows the selection head, including reversed and nonempty selections, and stays on the numbered row when the cursor moves through a soft-wrapped continuation. It is a passive state: core adds no color, and custom gutters receive no such class.

```css
lumine-text-editor:not([mini], [input]) {
  .gutter[gutter-name="line-number"] .line-number.active-line-number {
    color: var(--syntax-gutter-text-color-selected);
  }
}
```

The editor also exposes `.is-focused`, so a theme can style focused and unfocused selections by changing `--syntax-selection-color` on the editor element. Keep mini editors and `[input]` fields separate: their selection colors belong to the UI theme.

## A bar tile is the element the bar marks

The status and title bars mark the element they host with `.status-bar-item` or `.title-bar-item`. Theme padding, rounding, color and hover feedback on those classes; do not infer a tile from descendants or style the unrelated `.inline-block` utility as one.

The bars own layout while the theme owns appearance. Their complete tile contracts live in the [`status-bar`](https://github.com/lumine-code/status-bar/blob/master/docs/status-bar.md) and [`title-bar`](https://github.com/lumine-code/title-bar/blob/master/docs/title-bar.md) documentation.

## Icon geometry belongs to the editor

Every icon in the interface — tree-view rows, tabs, lists, the status bar — renders in one frame, defined once by the editor's base stylesheet: a square of `--ui-icon-size` whose `line-height` equals its height, aligned `vertical-align: text-bottom`. The box centers itself in any line, and each font's ink centers inside the box, so the same glyph sits at the same height in every surface without per-surface tuning.

A theme styles icons by **color and margin only**. Row metrics stay yours — set `line-height` on the row, the tab, the list item — and the icons follow. What a theme must never do is re-declare box geometry (`line-height`, `vertical-align`, `width`, `height`, `font-size`, `top`, `translate`) on an `.icon` `::before`: that pulls one surface out of the shared frame and re-splits icon alignment per surface. The bundled themes are checked mechanically (`npm run check:icons` in the editor repository fails on any such declaration).

To scale icons on one surface, scope the variable instead of restyling the pseudo-element — the box, the editor's octicons, and icon-package glyphs all follow it:

```css
.tab-bar {
  --ui-icon-size: 14px;
}
```

A theme may repaint the window without the active themes changing — offering a variant as a setting, for example, and keying its stylesheets off an attribute on the document root. Switching themes cross-fades the window and tells packages that cache resolved colors to re-read them; a bare `setAttribute` does neither, so the new palette snaps in and anything painting to a canvas (the terminal, the minimap) keeps the old colors until something unrelated makes it redraw.

Apply those changes through `lumine.themes.updateAppearance` instead, and they behave like a theme switch:

```js
lumine.config.onDidChange("my-theme.variant", ({ newValue }) => {
  lumine.themes.updateAppearance(() => {
    document.documentElement.setAttribute("ui-variant", newValue.toLowerCase());
  });
});
```

Only for changes that alter the palette. Settings that rearrange the window rather than recolor it are plain attribute writes.

## Developing live

Themes reload as you edit, especially with the bundled `dev-live-reload` package active in a development window. A stylesheet edit reloads just your theme, `variables.css` included: custom properties cascade at runtime, so everything reading them restyles. Link and run your theme the same way as any package:

```sh
lumine --link . --dev
lumine --dev .
```

For small visual changes you do not need a whole theme — a few rules in your `styles.css` may be enough. See [Customization](https://lumine-code.github.io/docs.html#customization/personalizing-lumine).
