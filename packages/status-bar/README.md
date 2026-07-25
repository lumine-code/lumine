# status-bar

Host the status bar at the bottom of the workspace and provide a service other packages add indicator tiles to.

## Features

- **Tile host**: lets other packages add custom tiles to the left or right side of the bar, ordered by priority.
- **Toggle**: show or hide the whole status bar with a command.
- **Full-width**: fit the bar to the window width or to the active editor.

## Commands

Commands available in `atom-workspace`:

- `status-bar:toggle`: show or hide the status bar at the bottom of the workspace.

## Services

- **status-bar** (`1.0.0`): provided to host indicator tiles at the bottom of the workspace, with a left and right side other packages can add to.

## Customization

Restyle the status bar by adding CSS to your `styles.css`. For example, to enlarge the text and add a top border:

```css
status-bar {
  font-size: 13px;
  border-top: 1px solid fade(#000, 20%);
}
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
