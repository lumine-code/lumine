# fuzzy-workspace

Quickly find and focus any open item across the workspace.

## Features

- **Fast fuzzy search**: ranks open items by match quality with a smart scoring algorithm.
- **Full workspace coverage**: lists every open pane item in the workspace center and the left, right, and bottom docks.
- **Focus on confirm**: reveals an item's dock if hidden, activates its pane, and focuses it.
- **Item actions**: closes an item or copies its path without leaving the keyboard.
- **Icons**: shows an icon per item, derived from the item icon name or its file path.

## Commands

Commands available in `atom-workspace`:

- `fuzzy-workspace:toggle`: toggle the fuzzy workspace panel.

Commands available in `.fuzzy-workspace`, all listed with their keybindings in the item-actions list (F12):

- `fuzzy-workspace:focus-selected-item`: focus the selected item, revealing its dock and pane,
- `fuzzy-workspace:close-selected-item`: close the selected item without leaving the list,
- `fuzzy-workspace:copy-selected-path`: copy the path of the selected item,
- `fuzzy-workspace:query-selection`: use the editor selection as the query.

## Customization

Resize the results panel by adding CSS to your `styles.css`:

```css
.fuzzy-workspace {
  font-size: 14px;
  .list-group {
    max-height: 20em;
  }
}
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
