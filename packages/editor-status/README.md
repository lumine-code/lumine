# editor-status

Show the active file path, cursor position, and selection range in the status bar.

## Features

- **File info**: shows the active editor's path or title with a modified indicator, and copies the path to the clipboard on click.
- **Editor position**: shows the cursor line and column, the selection range when text is selected, and the cursor count when there is more than one.
- **Liquid templates**: formats the position tile from a preset or a custom Liquid template with conditional sections.
- **Go to line**: clicking the position tile toggles the go-to-line dialog.

## Configuration

The position tile is rendered from a [Liquid](https://liquidjs.com) template. Pick a preset in the Settings view, or set `Template` to `Custom` and edit the `Custom Template` field. The template receives these variables:

- `start.row`, `start.col` — where the selection begins (its anchor), or the cursor when nothing is selected.
- `end.row`, `end.col` — where the cursor is (the selection head); equals `start` when nothing is selected.
- `lines`, `chars` — the selected line and character counts (`0` when nothing is selected).
- `n` — the number of cursors.

`start` and `end` follow the selection's direction, so a selection made from the bottom up reports its anchor as `start` and the cursor as `end`. Conditional tags let a single template cover every case. The default template is:

```liquid
{{ start.row }}:{{ start.col }}{% if chars %}-{{ end.row }}:{{ end.col }}{% endif %}{% if n > 1 %} #{{ n }}{% endif %}
```

which renders `1:1` for a cursor, `1:1-2:31` for a selection, and appends ` #3` when three cursors are active. If the template renders empty, the tile is hidden.

## Customization

Restyle the tiles by adding CSS to your `styles.css`. For example, to color the position tile and space it out:

```css
status-bar .editor-position {
  color: var(--text-color-info);
  margin-left: 1em;
}
```

## Services

- **status-bar** (`^1.0.0`): consumed to add the file-info and editor-position tiles to the left side of the status bar.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
