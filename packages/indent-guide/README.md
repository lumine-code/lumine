# indent-guide

Indentation guides with active scope highlighting.

Guides are drawn as continuous vertical lines across each indentation level, including empty lines, and the guides enclosing the cursor position are highlighted.

## Features

- **Continuous guides**: vertical lines span whole indentation blocks, including empty lines.
- **Active scope highlight**: guides enclosing the cursor position are emphasized.
- **Cursor awareness**: the active guide can follow the cursor column or stick to the deepest guide on the line.
- **Fold aware**: guides collapse together with folded regions.

## Commands

Commands available in `atom-workspace`:

- `indent-guide:toggle-cursor-aware-active`: switch between cursor-column and deepest-guide highlighting.

## Customization

Guides are rendered as `indent-guide` elements layered over the editor. Bundled syntax themes set their base, stack, and active colors through package-specific custom properties, with neutral package fallbacks for other themes. Adjust them in your `styles.css`:

```css
atom-text-editor {
  --indent-guide-color: rgba(158, 158, 158, 0.15);
  --indent-guide-stack-color: rgba(158, 158, 158, 0.3);
  --indent-guide-active-color: var(--text-color-info);
}
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
