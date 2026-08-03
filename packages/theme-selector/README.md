# theme-selector

Preview and select registered light/dark theme packs.

## Features

- **Live preview**: applies each theme pack while navigating the selector.
- **Safe cancellation**: restores the previously configured theme pack.
- **Paired themes**: changes the configured light and dark theme stacks together.
- **Appearance modes**: switches between light, dark, and system-controlled modes, and keeps the choice whether the selector is confirmed or cancelled.

## Commands

Commands available in `atom-workspace`:

- `theme-selector:toggle`: opens or closes the theme selector,
- `theme-selector:use-system-mode`: follows the system appearance,
- `theme-selector:use-light-mode`: uses light mode,
- `theme-selector:use-dark-mode`: uses dark mode.

## Usage

Open the selector and navigate through the registered packs to preview them.
Confirm a pack to keep it, or cancel to restore the previous one. The
appearance mode is saved as soon as it is chosen, so cancelling never undoes
it.

Theme packages can declare one or more packs in `package.json`:

```json
{
  "themePacks": [
    {
      "name": "Example",
      "light": ["example-day-ui", "example-day-syntax"],
      "dark": ["example-night-ui", "example-night-syntax"]
    }
  ]
}
```

Packages that create packs dynamically can use
`atom.themes.registerThemePack()` and dispose the returned registration when
the pack is no longer available.

## Customization

The selector uses the shared select-list styles and adds the
`.theme-selector` class for focused overrides:

```css
.theme-selector .theme-pack {
  padding-block: 0.5em;
  border-radius: 4px;
}
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
