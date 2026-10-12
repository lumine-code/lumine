// Atomic DOM moves retain editor observers, so notify them synchronously once
// the new pane geometry is complete instead of waiting for ResizeObserver.
function refreshPaneLayout(element) {
  for (const editor of element.querySelectorAll("lumine-text-editor")) {
    if (editor.component?.attached) editor.component.didResize();
  }
}

module.exports = { refreshPaneLayout };
