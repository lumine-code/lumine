# command-palette

Find and run available commands with fuzzy search.

The palette lists every command available for the focused element, so it always reflects the current context of the workspace.

## Features

- **Fuzzy search**: filter commands by name, description, and tags with fuzzy matching.
- **Recent commands**: recently used commands stay on top of the list while the query is empty.
- **Keybinding hints**: each command shows its current keybindings for the focused element.
- **Hidden commands**: inspect commands excluded from the palette on demand.
- **Query preservation**: optionally keep the previous search when reopening the palette.

## Commands

Commands available in `atom-workspace`:

- `command-palette:toggle`: open or close the command palette,
- `command-palette:show-hidden-commands`: open the palette listing only commands hidden from it,
- `command-palette:clear-recent`: forget the recently used commands.

Commands available in `.command-palette`, listed with their keybindings in the item-actions list (F12):

- `command-palette:toggle-hidden-commands`: include the commands hidden from the palette by their packages.

## Customization

The palette is rendered inside a modal panel with the `command-palette` class. Adjust its appearance by adding CSS to your `styles.css`:

```css
.command-palette {
  font-size: 14px;
  .list-group {
    max-height: 20em;
  }
  .recent {
    background: transparent;
  }
}
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
