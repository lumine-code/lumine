const { Readable } = require("stream");
const { Disposable } = require("@lumine-code/event-kit");
const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const Pane = require("../src/pane");

describe("external reloads in text editors", () => {
  let source, buffer, editors, panes;

  beforeEach(async () => {
    source = {
      text: "hello abc\nsecond line\n",
      exists: true,
      getPath: () => null,
      getEncoding: () => "utf8",
      existsSync() {
        return this.exists;
      },
      createReadStream() {
        return Readable.from([this.text]);
      },
      onDidChange: () => new Disposable(),
      onDidDelete(callback) {
        this.didDelete = callback;
        return new Disposable(() => {
          this.didDelete = null;
        });
      },
    };
    buffer = await TextBuffer.load(source);
    editors = [];
    panes = [];
  });

  afterEach(() => {
    for (const pane of panes) {
      for (const item of pane.getItems()) pane.unsubscribeFromItem(item);
    }
    for (const editor of editors) editor.destroy();
    if (!buffer.isDestroyed()) buffer.destroy();
  });

  function createEditor(params = {}) {
    const editor = new TextEditor({ buffer, initialColumn: 9, ...params });
    editors.push(editor);
    return editor;
  }

  async function reload(text) {
    source.text = text;
    await buffer.load({ internal: true });
  }

  it("identifies reload-driven cursor, selection, and marker changes without insertion hooks", async () => {
    const editor = createEditor();
    const cursorEvents = [];
    const selectionEvents = [];
    const markerEvents = [];
    const displayMarkerEvents = [];
    const renderedEvents = [];
    editor.onDidChangeCursorPosition((event) => cursorEvents.push(event));
    editor.onDidChangeSelectionRange((event) => selectionEvents.push(event));
    editor.getLastSelection().marker.bufferMarker.onDidChange((event) => markerEvents.push(event));
    editor.getLastSelection().marker.onDidChange((event) => displayMarkerEvents.push(event));
    editor.onDidChange((changes) => renderedEvents.push(...changes));
    const inserted = jasmine.createSpy("inserted");
    const autoscroll = jasmine.createSpy("autoscroll");
    editor.onWillInsertText(inserted);
    editor.onDidInsertText(inserted);
    editor.onDidRequestAutoscroll(autoscroll);

    await reload("hello abcd\nsecond line\n");

    expect(editor.getCursorBufferPosition()).toEqual([0, 10]);
    expect(buffer.getFileState()).toBe("unmodified");
    for (const events of [cursorEvents, selectionEvents, markerEvents, displayMarkerEvents]) {
      expect(events.length).toBe(1);
      expect(events[0].origin).toBe("reload");
      expect(events[0].textChanged).toBe(true);
    }
    expect(inserted).not.toHaveBeenCalled();
    expect(autoscroll).not.toHaveBeenCalled();
    expect(renderedEvents.length).toBeGreaterThan(0);
    expect(renderedEvents.every((event) => event.origin === "reload")).toBe(true);

    buffer.insert([0, 10], "e");
    expect(renderedEvents[renderedEvents.length - 1].origin).toBe("edit");
    expect(cursorEvents[cursorEvents.length - 1].origin).toBe("edit");
    expect(selectionEvents[selectionEvents.length - 1].textChanged).toBe(true);
    editor.setCursorBufferPosition([0, 8], { autoscroll: false });
    expect(cursorEvents[cursorEvents.length - 1].origin).toBe("edit");
    expect(selectionEvents[selectionEvents.length - 1].textChanged).toBe(false);
  });

  it("identifies history changes in cursor, selection, marker, and rendered events", () => {
    const editor = createEditor();
    editor.insertText("d");
    const cursorOrigins = [];
    const selectionOrigins = [];
    const markerOrigins = [];
    const displayMarkerOrigins = [];
    const renderedOrigins = [];
    editor.onDidChangeCursorPosition(({ origin }) => cursorOrigins.push(origin));
    editor.onDidChangeSelectionRange(({ origin }) => selectionOrigins.push(origin));
    editor
      .getLastSelection()
      .marker.bufferMarker.onDidChange(({ origin }) => markerOrigins.push(origin));
    editor.getLastSelection().marker.onDidChange(({ origin }) => displayMarkerOrigins.push(origin));
    editor.onDidChange((changes) => renderedOrigins.push(...changes.map(({ origin }) => origin)));

    editor.undo();
    editor.redo();

    for (const origins of [cursorOrigins, selectionOrigins, markerOrigins, displayMarkerOrigins])
      expect(origins).toEqual(["undo", "redo"]);
    expect(renderedOrigins).toContain("undo");
    expect(renderedOrigins).toContain("redo");
    expect(renderedOrigins.every((origin) => origin === "undo" || origin === "redo")).toBe(true);
  });

  it("preserves reload origins for both editors sharing a buffer", async () => {
    const first = createEditor();
    const second = createEditor();
    const origins = [];
    const firstRenderedOrigins = [];
    const secondRenderedOrigins = [];
    first.onDidChangeCursorPosition((event) => origins.push(event.origin));
    second.onDidChangeCursorPosition((event) => origins.push(event.origin));
    first.onDidChange((changes) =>
      firstRenderedOrigins.push(...changes.map((event) => event.origin)),
    );
    second.onDidChange((changes) =>
      secondRenderedOrigins.push(...changes.map((event) => event.origin)),
    );

    await reload("hello abcdef\nsecond line\n");

    expect(first.getCursorBufferPosition()).toEqual([0, 12]);
    expect(second.getCursorBufferPosition()).toEqual([0, 12]);
    expect(origins).toEqual(["reload", "reload"]);
    expect(firstRenderedOrigins).toEqual(["reload"]);
    expect(secondRenderedOrigins).toEqual(firstRenderedOrigins);
  });

  it("keeps a reentrant ordinary edit distinct from the reload that triggered it", async () => {
    const editor = createEditor();
    const origins = [];
    let edited = false;
    editor.onDidChangeCursorPosition((event) => {
      origins.push(event.origin);
      if (!edited && event.origin === "reload") {
        edited = true;
        buffer.insert([0, 0], "X");
      }
    });

    await reload("hello abcd\nsecond line\n");

    expect(buffer.getText()).toBe("Xhello abcd\nsecond line\n");
    expect(origins).toContain("reload");
    expect(origins).toContain("edit");
  });

  it("keeps a manually previewed tab pending across reloads and clears it on an edit", async () => {
    const editor = createEditor();
    const pane = new Pane({ activeItem: editor, items: [editor] });
    panes.push(pane);
    editor.terminatePendingState();
    pane.togglePendingItem();

    await reload("hello abcdef\nsecond line\n");

    expect(buffer.getFileState()).toBe("unmodified");
    expect(pane.getPendingItem()).toBe(editor);
    editor.insertText("!");
    expect(pane.getPendingItem()).toBeNull();
  });

  it("clears a re-pended dirty tab on the next edit even when its file state stays modified", () => {
    const editor = createEditor();
    const pane = new Pane({ activeItem: editor, items: [editor] });
    panes.push(pane);
    editor.insertText("!");
    expect(buffer.getFileState()).toBe("modified");
    pane.togglePendingItem();
    expect(pane.getPendingItem()).toBe(editor);

    editor.insertText("?");

    expect(buffer.getFileState()).toBe("modified");
    expect(pane.getPendingItem()).toBeNull();
  });

  for (const operation of ["undo", "redo"]) {
    it(`clears a re-pended tab when ${operation} changes its text`, () => {
      const editor = createEditor();
      const pane = new Pane({ activeItem: editor, items: [editor] });
      panes.push(pane);
      editor.insertText("!");
      if (operation === "redo") editor.undo();
      pane.togglePendingItem();
      expect(pane.getPendingItem()).toBe(editor);

      editor[operation]();

      expect(pane.getPendingItem()).toBeNull();
    });
  }

  it("clears a re-pended tab when a transaction mixes editing and history replay", () => {
    const editor = createEditor();
    const pane = new Pane({ activeItem: editor, items: [editor] });
    panes.push(pane);
    editor.insertText("!");
    pane.togglePendingItem();
    const origins = [];
    buffer.onDidChangeText(({ origin }) => origins.push(origin));

    buffer.transact(() => {
      buffer.append("x");
      buffer.undo();
      buffer.append("y");
    });

    expect(origins).toEqual(["mixed"]);
    expect(pane.getPendingItem()).toBeNull();
  });

  it("keeps a re-pended tab pending when its source is deleted externally", () => {
    const editor = createEditor();
    const pane = new Pane({ activeItem: editor, items: [editor] });
    panes.push(pane);
    editor.terminatePendingState();
    pane.togglePendingItem();

    source.exists = false;
    source.didDelete();

    expect(buffer.getFileState()).toBe("removed");
    expect(pane.getPendingItem()).toBe(editor);
  });

  it("keeps Linux PRIMARY at the user's selected text when edits move that selection", async () => {
    const editor = createEditor();
    const component = editor.getElement().component;
    spyOn(component, "getPlatform").and.returnValue("linux");
    const writeSelection = spyOn(TextEditor.clipboard, "writeSelectionText").and.returnValue(
      Promise.resolve(),
    );
    editor.setSelectedBufferRange(
      [
        [0, 6],
        [0, 9],
      ],
      { autoscroll: false },
    );
    await new Promise(setImmediate);
    expect(writeSelection).toHaveBeenCalledWith("abc");
    writeSelection.calls.reset();

    await reload("hello abcdef\nsecond line\n");
    buffer.insert([0, 7], "X");
    await new Promise(setImmediate);
    expect(writeSelection).not.toHaveBeenCalled();

    editor.setSelectedBufferRange(
      [
        [1, 0],
        [1, 6],
      ],
      { autoscroll: false },
    );
    await new Promise(setImmediate);
    expect(writeSelection).toHaveBeenCalledWith("second");
  });

  it("does not let an edit rewrite a deferred Linux PRIMARY selection gesture", async () => {
    const editor = createEditor();
    const component = editor.getElement().component;
    spyOn(component, "getPlatform").and.returnValue("linux");
    const writeSelection = spyOn(TextEditor.clipboard, "writeSelectionText").and.returnValue(
      Promise.resolve(),
    );

    editor.setSelectedBufferRange(
      [
        [0, 6],
        [0, 9],
      ],
      { autoscroll: false },
    );
    buffer.insert([0, 7], "X");
    await new Promise(setImmediate);

    expect(editor.getSelectedText()).toBe("aXbc");
    expect(writeSelection).toHaveBeenCalledOnceWith("abc");
  });
});
