const TextEditor = require("../src/text-editor");
const TextEditorComponent = require("../src/text-editor-component");
const { getCurrentWebContents } = require("@electron/remote");

// Exercises the browser default actions around the editor's hidden input with
// trusted input events, which `webContents.sendInputEvent` can generate even
// when the window is unfocused. This guards the removal of the historical
// space-character workarounds (see didTextInput): a cancelled space must not
// page-scroll anything, and typing must never move the editor's own
// containers, whose scrolling is synthetic and transform-based.
describe("TextEditorComponent hidden input", () => {
  it("inserts a trusted space without scrolling any editor container or changing the input value", async () => {
    const editor = new TextEditor({ autoHeight: false });
    editor.setText(Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"));

    const component = new TextEditorComponent({
      model: editor,
      updatedSynchronously: true,
    });
    const element = component.element;
    element.style.height = "200px";
    element.style.width = "400px";
    element.style.font = "14px monospace";
    jasmine.attachToDOM(element);

    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    for (let i = 0; i < 10; i++) await frame();
    component.updateSync();

    const hiddenInput = component.refs.cursorsAndInput.refs.hiddenInput;
    hiddenInput.focus();
    for (let i = 0; i < 5; i++) await frame();

    // Scroll far away from the cursor so the hidden input sits well outside
    // the visible area: the historical failure mode was the browser
    // force-scrolling the scroll container to reveal it on input.
    editor.setCursorBufferPosition([0, 0]);
    component.updateSync();
    component.setScrollTop(2000);
    component.updateSync();

    const scrolled = [];
    for (const target of [
      component.refs.scrollContainer,
      component.refs.content,
      component.refs.lineTiles,
    ]) {
      target.addEventListener("scroll", () => scrolled.push(target.className));
    }

    getCurrentWebContents().sendInputEvent({ type: "char", keyCode: " " });
    await new Promise((resolve) => {
      const subscription = editor.getBuffer().onDidChange(() => {
        subscription.dispose();
        resolve();
      });
    });
    for (let i = 0; i < 10; i++) await frame();

    expect(editor.lineTextForBufferRow(0)).toBe(" line 0");
    expect(hiddenInput.value).toBe("");
    // The editor's own synthetic autoscroll moves the view back to the cursor
    // via transforms; the native scroll positions of its containers must not
    // move at all.
    expect(scrolled).toEqual([]);
    expect(component.refs.scrollContainer.scrollTop).toBe(0);
    expect(component.refs.scrollContainer.scrollLeft).toBe(0);

    editor.destroy();
  });

  // The scroll shear this guards against is triggered by the browser's own focus
  // handling, which does nothing unless the document owns the focus.
  jasmine.itWithDocumentFocus(
    "resets a browser-forced scroll offset when the hidden input regains focus",
    async () => {
      const editor = new TextEditor({ autoHeight: false });
      editor.setText(Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"));

      const component = new TextEditorComponent({
        model: editor,
        updatedSynchronously: true,
      });
      const element = component.element;
      element.style.height = "200px";
      element.style.width = "400px";
      element.style.font = "14px monospace";
      jasmine.attachToDOM(element);

      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      for (let i = 0; i < 10; i++) await frame();
      component.updateSync();

      const hiddenInput = component.refs.cursorsAndInput.refs.hiddenInput;
      const { scrollContainer } = component.refs;

      // Park the hidden input far below the viewport: it tracks the last
      // cursor's content-coordinate position, so move the cursor to the bottom
      // and then synthetically scroll back to the top.
      editor.setCursorBufferPosition([399, 0]);
      component.updateSync();
      component.setScrollTop(0);
      component.updateSync();
      const containerRect = scrollContainer.getBoundingClientRect();
      expect(hiddenInput.getBoundingClientRect().top).toBeGreaterThan(containerRect.bottom);

      // Browser-initiated focus (window refocus, IME, execCommand) bypasses the
      // preventScroll option our own focus() calls pass, and natively scrolls
      // the overflow:hidden scroll container to reveal the off-screen input,
      // shearing the transform-scrolled lines ("half screen" bug).
      hiddenInput.focus();
      for (let i = 0; i < 5; i++) await frame();

      expect(scrollContainer.scrollTop).toBe(0);
      expect(scrollContainer.scrollLeft).toBe(0);

      editor.destroy();
    },
  );
});
