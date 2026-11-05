# Soft wrap

Soft wrap changes how a document is displayed without inserting line endings into its contents. Its width is measured in screen columns, accounting for tabs and wider characters. Word boundaries can place a break before the configured column.

## Width settings

`editor.softWrap` enables wrapping to the text viewport. `editor.softWrapMinColumn` and `editor.softWrapMaxColumn` constrain that width; both default to `0`, meaning no constraint. These settings can be configured globally or for a grammar.

| Behavior                              | Minimum column | Maximum column |
| ------------------------------------- | -------------: | -------------: |
| Fit the viewport                      |              0 |              0 |
| Fit the viewport, at most 80 columns  |              0 |             80 |
| Fit the viewport, at least 20 columns |             20 |              0 |
| Fit the viewport within 20–80 columns |             20 |             80 |
| Always wrap at 80 columns             |             80 |             80 |

The minimum is applied first and a positive maximum is applied last. If the minimum exceeds a positive maximum, the maximum takes precedence. A width exceeding the viewport allows horizontal scrolling when the actual text overflows. Disabling soft wrap preserves both constraints; toggling it back on restores their effect.

`editor.preferredLineLength` is a separate formatting preference used by paragraph reflow and the default wrap guide. It does not constrain soft wrap. `editor.softWrapHangingIndent` adds indentation to continuation rows, and `editor.softWrapDebounceInterval` controls reflow during continuous layout resizing.

The editor owns the preferred line length, defaulting to 80 columns. Users can configure it globally or for a grammar, and language packages can supply grammar-specific defaults. Packages read the effective value with `TextEditor.getPreferredLineLength()` and observe `onDidChangePreferredLineLength(callback)`, which receives the new column. Paragraph reflow and the wrap guide share this value without package-specific width settings. Following the soft wrap column changes only the guide's displayed position.

## Model integration

`TextEditor.getSoftWrapColumn()` reports the effective wrapping column. `getSoftWrapMinColumn()` and `getSoftWrapMaxColumn()` report the configured constraints. Editors accept `softWrapMinColumn` and `softWrapMaxColumn` in their construction and `update()` parameters; copies and session restoration preserve them.

`TextEditor.onDidChangeSoftWrapColumn(callback)` reports a changed effective column, including changes from viewport resizing, configuration and document-size policy. The callback receives the new column. Packages positioning a wrap guide or minimap should consume this model value instead of deriving another wrapping policy from configuration. `isSoftWrapped()` and `onDidChangeSoftWrapped()` describe the enabled state separately.

## Layout cost and large documents

Resolving the two constraints takes constant time. Resizing within a constraint does not rebuild the display projection when the resulting column stays unchanged. A changed column uses the existing wrapping algorithm and resize debounce.

`editor.unwrappedLineLengthLimit` is the independent safety wrapping limit for ordinary views with soft wrap disabled; it defaults to 500 columns. Large documents instead use the bounded unwrapped projection unless wrapping is explicitly enabled for that document. Mini editors and automatically sized views retain their sizing policies. See [Large document editing](large-document-editing.md).
