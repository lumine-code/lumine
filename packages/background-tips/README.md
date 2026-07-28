# background-tips

Displays tips about Lumine in the background when no editors are open.

## Features

- **Idle tips**: shows helpful tips whenever the workspace has no open editors.
- **Liquid templates**: every tip is a Liquid template, so it can branch on what the keymap actually binds.
- **Live keystrokes**: a keystroke is resolved when the tip is shown, so it follows the platform and any keymap the user has changed.
- **Package contributions**: lets any package add its own tips through a `backgroundTips` array.

## Usage

Packages contribute tips by adding a `backgroundTips` array to their `package.json`. Each entry is a [Liquid](https://liquidjs.com) template, rendered every time the tip comes up. A string with no template tags in it is shown as-is.

```json
"backgroundTips": [
  "You can open any file quickly using {{ 'fuzzy-files:toggle' | keystroke }}"
]
```

There are two ways to reach a keystroke, and the difference is what happens when the command is unbound:

- `{{ "command" | keystroke }}` states that the tip needs that keystroke. It renders the current one, and the whole tip is skipped when nothing is bound to the command.
- `keys["command"]` only looks the keystroke up. It yields nothing when the command is unbound, which makes it the one to test in a condition when the tip should still be shown:

```json
"backgroundTips": [
  "{% if keys['minimap:toggle'] %}You can hide the minimap with {{ 'minimap:toggle' | keystroke }}{% else %}The minimap draws git changes and lint messages over a bird's-eye view of the file.{% endif %}"
]
```

The `keystroke` filter takes an optional selector for a command bound in more than one scope. It is matched exactly against the selector the keymap declares:

```
{{ 'tree-view:copy' | keystroke: '.tree-view' }}
```

Without one, the binding whose selector names the current platform wins, and otherwise the first one declared.

`platform` holds the current `process.platform`, for a tip that only applies to one operating system:

```
{% if platform == 'win32' %}...{% endif %}
```

A tip that renders to nothing is skipped, as is one whose template does not parse.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
