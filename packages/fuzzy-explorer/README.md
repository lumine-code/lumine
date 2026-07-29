# fuzzy-explorer

Fuzzy search files across user-defined directories.

## Features

- **Fast fuzzy search**: Uses algorithm with smart scoring.
- **Manual refresh**: Cache updates only when triggered by user.
- **External opening**: Open files with external applications through the `open-external` service.

## Commands

Commands available in `atom-workspace`:

- `fuzzy-explorer:toggle`: toggle the fuzzy explorer panel,
- `fuzzy-explorer:refresh`: refresh the file cache,
- `fuzzy-explorer:edit`: open the configuration file.

Commands available in `.fuzzy-explorer`, all listed with their keybindings in the item-actions list (F12):

- `fuzzy-explorer:open`: open the selected file,
- `fuzzy-explorer:open-external`: open the file in the default external program,
- `fuzzy-explorer:show-in-folder`: show the file in the system file manager,
- `fuzzy-explorer:split-left/right/up/down`: open the file in a split pane,
- `fuzzy-explorer:refresh-index`: rebuild the file index,
- `fuzzy-explorer:copy-relative-path`: copy the path relative to the active editor,
- `fuzzy-explorer:copy-absolute-path`: copy the absolute path,
- `fuzzy-explorer:copy-file-name`: copy the file name,
- `fuzzy-explorer:insert-relative-path`: insert the path relative to the active editor,
- `fuzzy-explorer:insert-absolute-path`: insert the absolute path,
- `fuzzy-explorer:insert-file-name`: insert the file name,
- `fuzzy-explorer:use-default-separator`: use the platform path separator,
- `fuzzy-explorer:use-forward-slashes`: use forward slashes in inserted and copied paths,
- `fuzzy-explorer:use-backslashes`: use backslashes in inserted and copied paths,
- `fuzzy-explorer:query-selected-path`: continue the query from the selected path,
- `fuzzy-explorer:query-selection`: use the editor selection as the query,
- `fuzzy-explorer:claude-chat`: attach the file to the Claude chat.

## Configuration

Create a config file at the Lumine config path, `explorer.json`, with an array of glob patterns:

```jsonc
["C:/Projects/**", "D:/Work/src/*.ts", "E:/Documents/**/*.md"]
```

## Services

- **open-external** (`^1.0.0`): consumed to open files with the configured external application.
- **claude-chat** (`^1.0.0`): consumed to attach the selected file to a claude-chat session.

## Customization

Resize the results panel by adding CSS to your `styles.css`:

```css
.fuzzy-explorer {
  font-size: 14px;
  .list-group {
    max-height: 20em;
  }
}
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
