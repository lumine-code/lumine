"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  activeSession,
  moveDown,
  cancel,
  confirm,
  flush,
  settle,
} = require("./helpers/modal-helpers");

describe("modal preview", () => {
  let directory;

  const write = (name, contents) => {
    const full = path.join(directory, name);
    fs.writeFileSync(full, contents);
    return full;
  };

  const previewElement = () => activeSession().element.querySelector(".modals-preview");
  const previewMessage = () => previewElement().querySelector(".modals-preview-message");
  const previewContent = () => previewElement().querySelector(".modals-preview-content");

  // The preview is debounced and then does real file I/O, so a spec has to let
  // the timer fire and then wait for the read rather than guess at turns.
  const settlePreview = async () => {
    await settle();
    flush(500);
    const session = activeSession();
    if (session) await session.element.__preview.whenIdle();
    await settle();
  };

  beforeEach(() => {
    jasmine.attachToDOM(atom.workspace.getElement());
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "modal-preview-"));
  });

  afterEach(() => {
    if (atom.modals.isOpen()) atom.modals.cancel("api");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const openFileList = (files, overrides = {}) =>
    atom.modals.open({
      id: "spec.preview",
      source: files,
      preview: atom.modals.previewers.file((item) => item),
      ...overrides,
    });

  it("renders the focused file into a pooled read-only editor", () => {
    const first = write("one.js", "const one = 1;\n");
    write("two.js", "const two = 2;\n");

    waitsForPromise(async () => {
      openFileList([first, path.join(directory, "two.js")]);
      await settlePreview();

      const editor = previewContent().querySelector("atom-text-editor");
      expect(editor).not.toBeNull();
      expect(editor.getModel().getText()).toContain("const one = 1;");
      // Writing through the buffer must not make the editor writable: setText
      // on a read-only editor throws in dev and spec mode.
      expect(editor.getModel().isReadOnly()).toBe(true);
    });
  });

  it("reuses one editor across rows rather than creating one per preview", () => {
    const first = write("one.js", "one\n");
    const second = write("two.js", "two\n");

    waitsForPromise(async () => {
      openFileList([first, second]);
      await settlePreview();
      const before = previewContent().querySelector("atom-text-editor");

      moveDown();
      await settlePreview();
      const after = previewContent().querySelector("atom-text-editor");

      expect(after).toBe(before);
      expect(after.getModel().getText()).toContain("two");
    });
  });

  it("assigns a language mode from the path", () => {
    const file = write("sample.js", "const x = 1;\n");

    waitsForPromise(async () => {
      await atom.packages.activatePackage("language-javascript");
      openFileList([file]);
      await settlePreview();

      const editor = previewContent().querySelector("atom-text-editor").getModel();
      expect(editor.getGrammar().scopeName).toBe("source.js");
    });
  });

  it("says so rather than rendering a binary file as text", () => {
    const file = path.join(directory, "blob.bin");
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));

    waitsForPromise(async () => {
      openFileList([file]);
      await settlePreview();
      expect(previewMessage().textContent).toBe("Binary file");
    });
  });

  it("reports a missing file instead of throwing", () => {
    waitsForPromise(async () => {
      openFileList([path.join(directory, "gone.txt")]);
      await settlePreview();
      expect(previewMessage().textContent).toBe("File not found");
    });
  });

  it("windows a long file around the requested row instead of reading it all", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const file = write("long.txt", lines);

    waitsForPromise(async () => {
      atom.modals.open({
        id: "spec.preview-long",
        source: [file],
        preview: atom.modals.previewers.file(() => ({ path: file, row: 2500 })),
      });
      await settlePreview();

      const text = previewContent().querySelector("atom-text-editor").getModel().getText();
      expect(text).toContain("line 2500");
      expect(text).not.toContain("line 0\n");
      expect(text).toContain("…truncated");
    });
  });

  it("drops a preview whose row is no longer focused", () => {
    const first = write("one.js", "one\n");
    const second = write("two.js", "two\n");
    let resolveFirst;

    waitsForPromise(async () => {
      let calls = 0;
      atom.modals.open({
        id: "spec.preview-race",
        source: [first, second],
        preview: {
          debounce: 0,
          render: () => {
            calls++;
            // The first row's answer is held back so it lands after the user
            // has already moved on.
            if (calls === 1) return new Promise((resolve) => (resolveFirst = resolve));
            return { text: "second" };
          },
        },
      });

      // Deliberately not awaiting whenIdle here: the first render never
      // settles until this spec lets it.
      await settle();
      flush(500);
      await settle();

      moveDown();
      await settle();
      flush(500);
      await settle();

      resolveFirst({ text: "first" });
      await activeSession().element.__preview.whenIdle();
      await settle();

      const text = previewContent().querySelector("atom-text-editor").getModel().getText();
      expect(text).toBe("second");
    });
  });

  it("keeps a renderer that throws from taking the modal down", () => {
    waitsForPromise(async () => {
      spyOn(console, "error");
      atom.modals.open({
        id: "spec.preview-throws",
        source: ["a"],
        preview: () => {
          throw new Error("nope");
        },
      });
      await settlePreview();

      expect(previewMessage().textContent).toContain("nope");
      expect(atom.modals.isOpen()).toBe(true);
    });
  });

  it("marks the panel wide only while a previewing view is up", () => {
    const file = write("one.js", "one\n");

    waitsForPromise(async () => {
      openFileList([file]);
      await settlePreview();
      const panel = activeSession().element.closest("atom-panel");
      expect(panel.dataset.wide).toBe("");

      cancel();
      await settle();

      atom.modals.open({ id: "spec.plain", source: ["a"] });
      await settle();
      expect(activeSession().element.closest("atom-panel").dataset.wide).toBeUndefined();
    });
  });

  describe("previewers.paneItem", () => {
    it("restores the editors it disturbed when the modal is cancelled", () => {
      const file = write("target.js", "one\ntwo\nthree\nfour\n");

      waitsForPromise(async () => {
        atom.config.set("core.allowPendingPaneItems", true);
        const editor = await atom.workspace.open(file);
        editor.setCursorBufferPosition([0, 0]);

        atom.modals.open({
          id: "spec.preview-pane",
          source: [{ uri: file, initialLine: 3 }],
          preview: atom.modals.previewers.paneItem((item) => item),
        });
        await settlePreview();

        // Previewing moved the real editor, because that is what this
        // previewer is for.
        expect(editor.getCursorBufferPosition().row).toBe(3);

        cancel();
        await settle();
        expect(editor.getCursorBufferPosition().row).toBe(0);
      });
    });

    it("leaves the editor where the user confirmed it", () => {
      const file = write("target.js", "one\ntwo\nthree\nfour\n");

      waitsForPromise(async () => {
        atom.config.set("core.allowPendingPaneItems", true);
        const editor = await atom.workspace.open(file);
        editor.setCursorBufferPosition([0, 0]);

        atom.modals.open({
          id: "spec.preview-pane-confirm",
          source: [{ uri: file, initialLine: 3 }],
          preview: atom.modals.previewers.paneItem((item) => item),
          confirm: () => {},
        });
        await settlePreview();

        confirm();
        await settle();
        expect(editor.getCursorBufferPosition().row).toBe(3);
      });
    });

    it("falls back to a read-only preview when pending items are disabled", () => {
      const file = write("target.js", "one\ntwo\n");

      waitsForPromise(async () => {
        atom.config.set("core.allowPendingPaneItems", false);
        const opened = atom.workspace.getTextEditors().length;

        atom.modals.open({
          id: "spec.preview-pane-off",
          source: [{ uri: file }],
          preview: atom.modals.previewers.paneItem((item) => item),
        });
        await settlePreview();

        // No pane item was created; the pooled editor rendered instead.
        expect(atom.workspace.getTextEditors().length).toBe(opened);
        expect(previewContent().querySelector("atom-text-editor")).not.toBeNull();
      });
    });
  });
});
