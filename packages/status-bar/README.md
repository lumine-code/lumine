# status-bar

Host the status bar at the bottom of the workspace and provide a service other packages add indicator tiles to.

## Features

- **Tile host**: lets other packages add custom tiles to the left or right side of the bar, ordered by priority.
- **Toggle**: show or hide the whole status bar with a command.
- **Full-width**: fit the bar to the window width or to the active editor.

## Commands

Commands available in `atom-workspace`:

- `status-bar:toggle`: show or hide the status bar at the bottom of the workspace.

## Usage

Packages add tiles through the `status-bar` service:

```js
const tile = statusBar.addLeftTile({ item: element, priority: 420 });
tile.destroy();
```

Always keep the returned tile and `destroy()` it on teardown. Removing only the element leaves the tile in the bar's ordered collection, and the next insertion positioned against that detached item fails.

### Tile priorities

**A lower priority sits closer to its panel's outer edge.** On the left panel that means further left; on the right panel it means further right. Tiles with equal priorities fall back to activation order, which is not stable, so every tile should carry its own number.

Priorities are grouped into bands of 100, numbered from the outer edge inwards, with a step of 10 inside each band so tiles can be inserted later without renumbering. A package that owns several adjacent tiles steps by one from its own slot instead, keeping the band's remaining tens free.

Left panel, from the left edge inwards:

| Priority | Band             | Tiles                                                         |
| -------- | ---------------- | ------------------------------------------------------------- |
| 110      | Diagnostics      | linter                                                        |
| 210, 220 | Repository       | git-switcher repository, git-switcher branch                  |
| 310, 320 | File identity    | editor-status path, grammar-selector (when shown on the left) |
| 410–450  | Language tooling | jove-repl, latex-tools, typst-tools, tasklist-tools, prettier |
| 510, 520 | View info        | editor-status cursor position, image-editor size              |

Right panel, from the right edge inwards:

| Priority | Band           | Tiles                                                                   |
| -------- | -------------- | ----------------------------------------------------------------------- |
| 110      | Application    | settings-view                                                           |
| 210–243  | Editor modes   | cursor-leader, column-selection, overtype-mode, invert-colors (240–243) |
| 310, 320 | Source control | git-panel, github-panel                                                 |
| 410–430  | File identity  | grammar-selector, encoding-selector, line-ending-selector               |
| 510–530  | Observers      | latex-tools, typst-tools, prettier observed-file counters               |
| 610      | Activity       | busy-signal                                                             |
| 710, 720 | Warnings       | deprecation-cop, incompatible-packages                                  |

## Customization

Restyle the status bar by adding CSS to your `styles.css`. For example, to enlarge the text and add a top border:

```css
status-bar {
  font-size: 13px;
  border-top: 1px solid fade(#000, 20%);
}
```

## Services

- **status-bar** (`1.0.0`): provided to host indicator tiles at the bottom of the workspace, with a left and right side other packages can add to.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
