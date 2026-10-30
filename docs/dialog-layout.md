# Dialog layout

Use InputDialog for a single text value and the shared dialog form classes for forms with several fields. Both use mini editors and the active theme's controls, colors and spacing. SelectList retains its own list geometry.

## Single value

Create the prompt with `lumine.workspace.addInputDialog()`. Supply `headerElement` for a label above the mini editor, `infoMessage` for instructions and `contentElement` for a preview or explicit buttons. Report validation through `setStatus()` and pending work through `setLoadingState()`. The host owns focus, cancellation, modal flow and teardown; destroy the host when the prompt is no longer needed.

Plain InputDialog models carry `dialog-form`, and their modal hosts carry `dialog-panel`. Forms and select lists inherit the same modal width from the active theme. Forms use the full `--ui-panel-padding` around their fields, rather than the denser padding used by pickers. Do not introduce separate sizes for individual forms.

## Several fields

Place a `dialog-form` inside a modal created with `className: "dialog-panel"`. The same form classes also work inside a pane-local overlay or a modeless floating dialog; those hosts retain their own positioning and dismissal rules.

| Class                | Purpose                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| `dialog-header`      | Title or short prompt above the fields.                                              |
| `dialog-title`       | Heading inside the header.                                                           |
| `dialog-body`        | Scrollable column containing the form's fields.                                      |
| `dialog-field`       | A label and its control, with a smaller gap between them.                            |
| `dialog-label`       | Visible field label.                                                                 |
| `dialog-description` | Quiet instructions or explanatory text.                                              |
| `dialog-status`      | Validation, errors or progress; hidden when empty.                                   |
| `dialog-footer`      | Status and actions at the end of the form.                                           |
| `dialog-actions`     | Buttons aligned to the end, with Cancel before the primary action on every platform. |

Use `lumine.workspace.buildTextEditor({ mini: true })` for free text, register it with `lumine.textEditors.add(editor, { role: "input" })`, and dispose both the registration and editor when the form closes. Keep native checkboxes, ranges and other controls where they express a specialized value. Assign accessible labels to mini editors and register confirm and cancel on the form's own element. A modal form needs `role="dialog"`, an accessible name and a focus policy; `addModalPanel({ autoFocus: firstField })` supplies the standard focus trap.

```html
<form class="dialog-form" role="dialog" aria-label="Create item">
  <header class="dialog-header">
    <h1 class="dialog-title">Create item</h1>
  </header>
  <div class="dialog-body">
    <div class="dialog-field">
      <span class="dialog-label">Name</span>
      <!-- Append the owned mini editor element here. -->
    </div>
  </div>
  <div class="dialog-status text-error" role="alert"></div>
  <footer class="dialog-actions">
    <button class="btn" type="button">Cancel</button>
    <button class="btn btn-primary" type="submit">Create</button>
  </footer>
</form>
```

The shared CSS owns form padding, field gaps, heading size and action spacing. Keep package styles for content-specific previews and specialized controls. A long body scrolls within the available window height, and actions wrap when the window becomes narrow. The modal theme continues to own width, surface, border, shadow and backdrop. Core preserves native Enter activation on buttons inside `dialog-form`, so a focused Cancel button cancels instead of submitting the primary action.
