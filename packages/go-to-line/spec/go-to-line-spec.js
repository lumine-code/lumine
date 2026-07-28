"use babel";

import GoToLineView from "../lib/go-to-line-view";
const path = require("path");
const {
  activeSession,
  isModalOpen,
  confirm,
  cancel,
  settle,
} = require("../../../spec/helpers/modal-helpers");

describe("GoToLine", () => {
  let editor = null;
  let editorView = null;

  // The query editor is the modal's own mini editor; typing into it drives the
  // same didChangeQuery path a user would.
  const miniEditor = () => activeSession().queryEditor;

  const open = async () => {
    atom.commands.dispatch(editorView, "go-to-line:toggle");
    await settle();
  };

  const type = async (text) => {
    miniEditor().insertText(text);
    await settle();
  };

  const submit = async () => {
    confirm();
    await settle();
  };

  beforeEach(() => {
    waitsForPromise(() => {
      return atom.workspace.open(path.join(__dirname, "fixtures", "sample.js"));
    });

    runs(() => {
      const workspaceElement = atom.views.getView(atom.workspace);
      workspaceElement.style.height = "200px";
      workspaceElement.style.width = "1000px";
      jasmine.attachToDOM(workspaceElement);
      editor = atom.workspace.getActiveTextEditor();
      editorView = atom.views.getView(editor);
      GoToLineView.activate();
      editor.setCursorBufferPosition([1, 0]);
    });
  });

  afterEach(() => {
    GoToLineView.deactivate();
    if (atom.modals.isOpen()) atom.modals.cancel("api");
  });

  describe("when go-to-line:toggle is triggered", () => {
    it("opens the modal", () => {
      waitsForPromise(async () => {
        expect(isModalOpen()).toBe(false);
        await open();
        expect(isModalOpen()).toBe(true);
      });
    });

    it("closes the modal when triggered again", () => {
      waitsForPromise(async () => {
        await open();
        await open();
        expect(isModalOpen()).toBe(false);
      });
    });
  });

  describe("when entering a line number", () => {
    it("only allows 0-9, colon, and dash characters to be entered", () => {
      waitsForPromise(async () => {
        await open();
        expect(miniEditor().getText()).toBe("");
        await type("a");
        expect(miniEditor().getText()).toBe("");
        await type("path/file.txt:56");
        expect(miniEditor().getText()).toBe("");
        await type(":");
        expect(miniEditor().getText()).toBe(":");
        miniEditor().setText("");
        await type("4");
        expect(miniEditor().getText()).toBe("4");
        await type("-");
        expect(miniEditor().getText()).toBe("4-");
      });
    });
  });

  describe("when entering a range", () => {
    it("selects from the start position to the end position", () => {
      waitsForPromise(async () => {
        await open();
        await type("3:8-4:1");
        await submit();
        expect(editor.getSelectedBufferRange()).toEqual([
          [2, 7],
          [3, 0],
        ]);
        expect(editor.getLastSelection().isReversed()).toBe(false);
        expect(editor.getCursorBufferPosition()).toEqual([3, 0]);
      });
    });

    it("makes a reversed selection when the end is before the start", () => {
      waitsForPromise(async () => {
        await open();
        await type("4:1-3:8");
        await submit();
        expect(editor.getSelectedBufferRange()).toEqual([
          [2, 7],
          [3, 0],
        ]);
        expect(editor.getLastSelection().isReversed()).toBe(true);
        expect(editor.getCursorBufferPosition()).toEqual([2, 7]);
      });
    });

    it("does not select until the end of the range is typed", () => {
      waitsForPromise(async () => {
        await open();
        await type("3:8-");
        expect(editor.getSelectedBufferRange()).toEqual([
          [2, 7],
          [2, 7],
        ]);
        expect(editor.getCursorBufferPosition()).toEqual([2, 7]);
      });
    });
  });

  describe("when typing line numbers (auto-navigation)", () => {
    it("automatically scrolls to the desired line", () => {
      waitsForPromise(async () => {
        await open();
        await type("19");
        expect(editor.getCursorBufferPosition()).toEqual([18, 0]);
      });
    });
  });

  describe("when typing line and column numbers (auto-navigation)", () => {
    it("automatically scrolls to the desired line and column", () => {
      waitsForPromise(async () => {
        await open();
        await type("3:8");
        expect(editor.getCursorBufferPosition()).toEqual([2, 7]);
      });
    });
  });

  describe("when entering a line number and column number", () => {
    it("moves the cursor to the column number of the line specified", () => {
      waitsForPromise(async () => {
        await open();
        expect(miniEditor().getText()).toBe("");
        await type("3:14");
        await submit();
        expect(editor.getCursorBufferPosition()).toEqual([2, 13]);
      });
    });

    it("centers the selected line", () => {
      waitsForPromise(async () => {
        await open();
        await type("45:4");
        await submit();
        const rowsPerPage = editor.getRowsPerPage();
        const currentRow = editor.getCursorBufferPosition().row;
        expect(editor.getFirstVisibleScreenRow()).toBe(Math.ceil(currentRow - rowsPerPage / 2));
        expect(editor.getLastVisibleScreenRow()).toBe(currentRow + Math.floor(rowsPerPage / 2));
      });
    });
  });

  describe("when entering a line number greater than the number of rows in the buffer", () => {
    it("moves the cursor position to the first character of the last line", () => {
      waitsForPromise(async () => {
        await open();
        expect(isModalOpen()).toBe(true);
        expect(miniEditor().getText()).toBe("");
        await type("78");
        await submit();
        expect(isModalOpen()).toBe(false);
        expect(editor.getCursorBufferPosition()).toEqual([77, 0]);
      });
    });
  });

  describe("when entering a column number greater than the number in the specified line", () => {
    it("moves the cursor position to the last character of the specified line", () => {
      waitsForPromise(async () => {
        await open();
        expect(miniEditor().getText()).toBe("");
        await type("3:43");
        await submit();
        expect(isModalOpen()).toBe(false);
        expect(editor.getCursorBufferPosition()).toEqual([2, 39]);
      });
    });
  });

  describe("when core:confirm is triggered", () => {
    describe("when a line number has been entered", () => {
      it("moves the cursor to the first character of the line", () => {
        waitsForPromise(async () => {
          await open();
          await type("3");
          await submit();
          expect(editor.getCursorBufferPosition()).toEqual([2, 4]);
        });
      });
    });

    describe("when the line number entered is nested within folds", () => {
      it("unfolds all folds containing the given row", () => {
        waitsForPromise(async () => {
          expect(editor.indentationForBufferRow(9)).toEqual(3);
          editor.foldAll();
          expect(editor.screenRowForBufferRow(9)).toEqual(0);
          await open();
          await type("10");
          await submit();
          expect(editor.getCursorBufferPosition()).toEqual([9, 6]);
        });
      });
    });
  });

  describe("when no line number has been entered", () => {
    it("closes the view and does not update the cursor position", () => {
      waitsForPromise(async () => {
        await open();
        expect(isModalOpen()).toBe(true);
        await submit();
        expect(isModalOpen()).toBe(false);
        expect(editor.getCursorBufferPosition()).toEqual([1, 0]);
      });
    });
  });

  describe("when no line number has been entered, but a column number has been entered", () => {
    it("navigates to the column of the current line", () => {
      waitsForPromise(async () => {
        await open();
        await type("4:1");
        await submit();
        expect(isModalOpen()).toBe(false);
        expect(editor.getCursorBufferPosition()).toEqual([3, 0]);

        await open();
        await type(":19");
        await submit();
        expect(isModalOpen()).toBe(false);
        expect(editor.getCursorBufferPosition()).toEqual([3, 18]);
      });
    });
  });

  describe("when core:cancel is triggered", () => {
    it("closes the view and does not update the cursor position", () => {
      waitsForPromise(async () => {
        await open();
        expect(isModalOpen()).toBe(true);
        cancel();
        await settle();
        expect(isModalOpen()).toBe(false);
        expect(editor.getCursorBufferPosition()).toEqual([1, 0]);
      });
    });
  });
});
