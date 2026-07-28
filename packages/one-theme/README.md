# one-theme

The One day and night UI and syntax themes.

## Features

- **Four themes**: provides `one-day-ui`, `one-day-syntax`, `one-night-ui`, and `one-night-syntax` as independently selectable themes.
- **CSS custom properties**: each theme defines its palette as CSS custom properties in a `variables.css`, the source of truth for the theme variable contract.
- **Less compatibility**: community packages that import `ui-variables`/`syntax-variables` keep working — Lumine generates the Less shim from the palettes automatically.
- **Mix and match**: any theme can be paired with a community counterpart, e.g. `one-night-ui` with a third-party syntax theme.
- **Reusable foundation**: other bundled themes can load the shared UI or syntax styles first and keep only their overrides locally.

## Theme pack

The package declares its four themes as the **One** pack. Use
`theme-selector:toggle` to preview and select it.

## Derived themes

A multi-theme entry can load a package-relative style directory before its own styles:

```json
{
  "name": "example-day-ui",
  "theme": "ui",
  "extends": ["one-theme::styles/ui/*"],
  "styles": ["styles/ui-overrides", "styles/day-ui"]
}
```

`extends` accepts one `package-name::glob` string or an ordered list of them. Matches from each glob are sorted, then loaded in list order, followed by the entry's `styles` directories. This is ordinary CSS cascade order: the derived theme keeps only the declarations it needs to override. Extending styles does not activate the referenced package's JavaScript or add its theme class.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
