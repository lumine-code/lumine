# language-python

Python language support.

## Features

- **Grammars**: provides both Tree-sitter and TextMate grammars.
- **Syntax highlighting**: full grammar coverage for Python files, consoles, tracebacks, and regular expressions.
- **IPython support**: dedicated Tree-sitter and TextMate grammars for `.ipy` files that parse IPython-only statements — magics (`%m`, `%%m`), shell escapes (`!cmd`), and help requests (`?obj`, `obj?`) — without syntax errors.
- **Snippets**: shortcuts for common Python constructs.

## Services

- **[hyperlink.injection](https://lumine-code.github.io/docs.html#services/hyperlink.injection)** (`^1.0.0`): consumed to highlight URLs inside Python files as clickable links.
- **[todo.injection](https://lumine-code.github.io/docs.html#services/todo.injection)** (`^1.0.0`): consumed to highlight `TODO`-style markers inside comments.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
