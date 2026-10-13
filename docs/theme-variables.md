# Theme variables

The public CSS variable contract supplies colors, dimensions and typography shared by the editor, themes and packages.

Use `var(--text-color)` in package stylesheets and define theme values on `:root`. Core supplies defaults for every theme variable, so a theme can override the inputs it needs and inherit the rest. The Styleguide displays the complete contract, including resolved values and metadata, directly from `lumine.themes.getVariables()`.

## Roles and ownership

| Role | Purpose | Who supplies the value |
| --- | --- | --- |
| `semantic` | Shared meanings such as foreground, diagnostic severity, accent or interface spacing. | Core supplies a default; the active UI or syntax theme may override it. |
| `component` | A specific surface or state such as a tooltip background, selected button foreground or data-grid row height. | Core supplies a default, often derived from semantic variables; a theme may override it directly. |
| `runtime` | The configured editor font family, font size and measured line height. | The editor supplies the value on `lumine-workspace`. |

Each definition identifies its owner as `ui`, `syntax` or `editor`. UI variables describe the interface, syntax variables describe the editing surface and language entities, and editor variables reflect runtime configuration. An owner identifies the meaning of a token; some UI values intentionally derive from syntax colors, such as editor-adjacent tabs and scrollbars.

Theme variables have scope `:root`; runtime typography has scope `lumine-workspace`. Syntax-theme metadata does not rewrite CSS selectors: define its palette on `:root` and scope highlighting rules explicitly under `lumine-text-editor`.

## Types

| Type | Value |
| --- | --- |
| `color` | A CSS color, including an alias or a valid relative-color expression. |
| `length` | A CSS length such as `13px`, `1em` or `calc(1em * 2)`. |
| `number` | A unitless value, such as prose line height or backdrop opacity. |
| `font-family` | A CSS font-family list. |
| `line-height` | A CSS line-height value: `normal`, a unitless ratio, a percentage or a length. |
| `boolean` | The exact token `true` or `false`, used by custom-control style queries. |

Color consumers may feed values into `color-mix()` and relative-color functions. Supply colors that resolve to valid CSS colors rather than arbitrary property values. `--use-custom-controls` is a behavior switch: `true` enables the shared custom-control rules and `false` leaves native controls available.

## Inputs and component overrides

The `default` field is the CSS expression core supplies. A default referring to other variables is a derived value, and overriding that component variable replaces the derivation for that surface. A runtime definition has `default: null` because its value comes from editor configuration.

For example, set the general foreground and spacing, then give tooltips their own background and foreground:

```css
:root {
  --text-color: #d8dee9;
  --ui-spacing: 8px;
  --tooltip-background-color: #263238;
  --tooltip-text-color: #ffffff;
}
```

Derived values are computed where they are declared. Changing a semantic input on `:root` updates the core defaults that depend on it. Changing that input only on a descendant does not recompute a derived value inherited from `:root`; override the relevant component tokens in that scope as well when restyling a local surface.

Floating documentation surfaces share `--overlay-documentation-background-color`: the hover and signature help panels, their arrows and toolbar, and the documentation below autocomplete suggestions. Its default derives from `--overlay-background-color` with HSL lightness reduced by four points. The suggestion list itself uses `--overlay-background-color`; documentation in a dock uses `--tool-panel-background-color`. Override the documentation token on `:root` to change all floating documentation surfaces together.

Git diff surfaces use `--syntax-color-added`, `--syntax-color-modified` and `--syntax-color-removed` for unstaged changes, and `--syntax-color-added-staged`, `--syntax-color-modified-staged` and `--syntax-color-removed-staged` for staged changes. The staged defaults mix 40% of the corresponding change color with 60% of `--syntax-text-color`, preserving contrast rather than fading toward the background. One Night and One Day supply muted staged colors with at least 4.5:1 contrast against both normal and selected gutter backgrounds. The `git-diff` package uses these tokens for line-number and icon decorations and for scrollbar and minimap markers.

Keep foregrounds paired with their intended backgrounds. The accent exposes separate indicator and filled-surface pairs: `--accent-indicator-color` with `--accent-indicator-text-color`, and `--accent-background-color` with `--accent-foreground-color`. `--accent-link-color` is accent text on the surrounding interface. A system accent overrides the indicator and filled-surface pairs while leaving the theme's link color in place; user styles take precedence over both.

## Interface sizing and editor typography

`--ui-font-size` and `--ui-font-family` define interface typography. `--ui-unit` is an `em`-based sizing unit that follows the font size of the consuming surface. `--ui-spacing` is general spacing; `--ui-panel-padding` supplies larger panel insets. `--ui-control-height` describes control geometry and `--ui-row-height` describes list rows. `--ui-input-font-size` and `--ui-tab-height` provide the shared input and tab sizes.

Use `--prose-font-size` and the unitless `--prose-line-height` for documentation and other paragraphs. Use `--editor-font-family`, `--editor-font-size` and `--editor-line-height` for content that should follow the user's code-editor settings. Runtime editor typography is supplied by the editor and should be consumed rather than replaced by a theme.

## Inspecting the contract

`lumine.themes.getVariables()` returns definitions with `name`, `type`, `role`, `owner`, `scope`, `default`, `group` and `description`. Names omit the leading `--`; add it when constructing a CSS custom property. The definitions describe the API, while `getComputedStyle()` reads the active cascade.

```js
const colors = lumine.themes.getVariables().filter(({ type }) => type === "color");
const style = getComputedStyle(document.documentElement);
for (const { name } of colors) {
  console.log(`--${name}`, style.getPropertyValue(`--${name}`).trim());
}
```

Read runtime typography from an element inside `lumine-workspace`. When a renderer needs a used color or length, assign `var(--name)` to the appropriate property of a probe element and read its computed `color`, `width` or `fontFamily`; unitless numbers and booleans should be read as custom-property values. Resolve `line-height` through a probe's `lineHeight` property using the editor font size; `normal` remains `normal` in computed CSS and should be displayed as such.

Cached colors or measurements should be refreshed from `lumine.themes.onDidChangeVariables(callback)`. This event coalesces stylesheet changes and covers theme switches, system accents, user styles and editor typography updates. Dispose the returned subscription when the consumer is destroyed.

```js
const subscription = lumine.themes.onDidChangeVariables(() => refreshCachedColors());
// When the consumer is destroyed:
subscription.dispose();
```
