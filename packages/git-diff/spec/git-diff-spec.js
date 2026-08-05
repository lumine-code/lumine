const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const { stopAllWatchers } = require(
  path.join(atom.getLoadSettings().resourcePath, "src", "path-watcher"),
);

describe("GitDiff package", () => {
  let editor, editorElement, projectPath, screenUpdates;

  beforeEach(() => {
    screenUpdates = 0;
    spyOn(window, "requestAnimationFrame").andCallFake((fn) => {
      fn();
      screenUpdates++;
    });
    spyOn(window, "cancelAnimationFrame").andCallFake((_i) => null);

    projectPath = temp.mkdirSync("git-diff-spec-");
    const otherPath = temp.mkdirSync("some-other-path-");

    fs.copySync(path.join(__dirname, "fixtures", "working-dir"), projectPath);
    fs.moveSync(path.join(projectPath, "git.git"), path.join(projectPath, ".git"));
    atom.project.setPaths([otherPath, projectPath]);

    jasmine.attachToDOM(atom.workspace.getElement());

    waitsForPromise(async () => {
      await atom.workspace.open(path.join(projectPath, "sample.js"));
      await atom.packages.activatePackage("git-diff");
    });

    runs(() => {
      editor = atom.workspace.getActiveTextEditor();
      editorElement = atom.views.getView(editor);
    });
  });

  afterEach(() => {
    waitsForPromise(async () => {
      // Deleting a still-watched directory is refused on Windows, and watched
      // roots vanishing beneath the file-watcher worker has crashed it on
      // macOS. Wait for the arms to settle (an arming watch cannot be
      // stopped), release every native watcher, and only then delete the
      // temp roots.
      await Promise.allSettled(
        atom.project.getPaths().map((projectPath) => atom.project.getWatcherPromise(projectPath)),
      );
      await stopAllWatchers();
      temp.cleanup();
    });
  });

  describe("when the editor has no changes", () => {
    it("doesn't mark the editor", () => {
      waitsFor(() => screenUpdates > 0);
      runs(() => expect(editor.getMarkers().length).toBe(0));
    });
  });

  describe("when a repository event changes none of the diff inputs", () => {
    it("skips recomputing the line diffs", () => {
      let repository, afterFirstEdit;

      waitsFor(() => screenUpdates > 0);
      waitsForPromise(async () => {
        repository = await atom.repositories.resolveForPath(path.join(projectPath, "sample.js"));
      });
      runs(() => {
        expect(repository).toBeTruthy();
        spyOn(repository, "getLineDiffsAsync").andCallThrough();

        editor.insertText("a");
        advanceClock(editor.getBuffer().stoppedChangingDelay);
      });

      // The buffer edit forces a compute that also applies (markers appear).
      waitsFor(() => editor.getMarkers().length > 0);
      runs(() => {
        afterFirstEdit = repository.getLineDiffsAsync.callCount;

        // An index-only event — staging, unstaging — reuses the same head oid
        // and buffer, so no worker round trip happens.
        repository.emitter.emit("did-change-status-snapshot", repository.getStatusSnapshot());
        expect(repository.getLineDiffsAsync.callCount).toBe(afterFirstEdit);

        // Another buffer change still recomputes...
        editor.insertText("b");
        advanceClock(editor.getBuffer().stoppedChangingDelay);
      });

      waitsFor(() => repository.getLineDiffsAsync.callCount > afterFirstEdit);
      runs(() => {
        // ...and once it lands, an input-free repository event skips again.
        const afterSecondEdit = repository.getLineDiffsAsync.callCount;
        repository.emitter.emit("did-change-status-snapshot", repository.getStatusSnapshot());
        expect(repository.getLineDiffsAsync.callCount).toBe(afterSecondEdit);
      });
    });
  });

  describe("when the editor has modified lines", () => {
    it("highlights the modified lines", () => {
      expect(editorElement.querySelectorAll(".git-line-modified").length).toBe(0);
      editor.insertText("a");
      advanceClock(editor.getBuffer().stoppedChangingDelay);

      waitsFor(() => editor.getMarkers().length > 0);
      runs(() => {
        expect(editorElement.querySelectorAll(".git-line-modified").length).toBe(1);
        expect(editorElement.querySelector(".git-line-modified")).toHaveData("buffer-row", 0);
      });
    });
  });

  describe("when the editor has added lines", () => {
    it("highlights the added lines", () => {
      expect(editorElement.querySelectorAll(".git-line-added").length).toBe(0);
      editor.moveToEndOfLine();
      editor.insertNewline();
      editor.insertText("a");
      advanceClock(editor.getBuffer().stoppedChangingDelay);
      waitsFor(() => editor.getMarkers().length > 0);
      runs(() => {
        expect(editorElement.querySelectorAll(".git-line-added").length).toBe(1);
        expect(editorElement.querySelector(".git-line-added")).toHaveData("buffer-row", 1);
      });
    });
  });

  describe("when the editor has removed lines", () => {
    it("highlights the line preceeding the deleted lines", () => {
      expect(editorElement.querySelectorAll(".git-line-added").length).toBe(0);
      editor.setCursorBufferPosition([5]);
      editor.deleteLine();
      advanceClock(editor.getBuffer().stoppedChangingDelay);
      waitsFor(() => editor.getMarkers().length > 0);
      runs(() => {
        expect(editorElement.querySelectorAll(".git-line-removed").length).toBe(1);
        expect(editorElement.querySelector(".git-line-removed")).toHaveData("buffer-row", 4);
      });
    });
  });

  describe("when the editor has removed the first line", () => {
    it("highlights the line preceeding the deleted lines", () => {
      expect(editorElement.querySelectorAll(".git-line-added").length).toBe(0);
      editor.setCursorBufferPosition([0, 0]);
      editor.deleteLine();
      advanceClock(editor.getBuffer().stoppedChangingDelay);
      waitsFor(() => editor.getMarkers().length > 0);
      runs(() => {
        expect(editorElement.querySelectorAll(".git-previous-line-removed").length).toBe(1);
        expect(editorElement.querySelector(".git-previous-line-removed")).toHaveData(
          "buffer-row",
          0,
        );
      });
    });
  });

  describe("when a modified line is restored to the HEAD version contents", () => {
    it("removes the diff highlight", () => {
      expect(editorElement.querySelectorAll(".git-line-modified").length).toBe(0);
      editor.insertText("a");
      advanceClock(editor.getBuffer().stoppedChangingDelay);
      waitsFor(() => editorElement.querySelectorAll(".git-line-modified").length > 0);
      runs(() => {
        expect(editorElement.querySelectorAll(".git-line-modified").length).toBe(1);
        editor.backspace();
        advanceClock(editor.getBuffer().stoppedChangingDelay);
      });
      waitsFor(() => editorElement.querySelectorAll(".git-line-modified").length < 1);
      runs(() => {
        expect(editorElement.querySelectorAll(".git-line-modified").length).toBe(0);
      });
    });
  });

  describe("when a modified file is opened", () => {
    it("highlights the changed lines", () => {
      fs.writeFileSync(path.join(projectPath, "sample.txt"), "Some different text.");

      waitsForPromise(() => atom.workspace.open(path.join(projectPath, "sample.txt")));

      runs(() => {
        editor = atom.workspace.getActiveTextEditor();
        editorElement = editor.getElement();
      });

      waitsFor(() => editor.getMarkers().length > 0);

      runs(() => {
        expect(editorElement.querySelectorAll(".git-line-modified").length).toBe(1);
        expect(editorElement.querySelector(".git-line-modified")).toHaveData("buffer-row", 0);
      });
    });
  });

  describe("when the project paths change", () => {
    it("doesn't try to use the destroyed git repository", () => {
      editor.deleteLine();
      atom.project.setPaths([temp.mkdirSync("no-repository")]);
      advanceClock(editor.getBuffer().stoppedChangingDelay);
      waitsFor(() => editor.getMarkers().length === 0);
      runs(() => {
        expect(editor.getMarkers().length).toBe(0);
      });
    });
  });

  describe("move-to-next-diff/move-to-previous-diff events", () => {
    it("moves the cursor to first character of the next/previous diff line", () => {
      editor.insertText("a");
      editor.setCursorBufferPosition([5]);
      editor.deleteLine();
      advanceClock(editor.getBuffer().stoppedChangingDelay);

      // The diff is computed off-thread by the git-host worker now, so wait for
      // the deletion marker before exercising the navigation commands.
      waitsFor(() => editorElement.querySelectorAll(".git-line-removed").length > 0);
      runs(() => {
        editor.setCursorBufferPosition([0]);
        atom.commands.dispatch(editorElement, "git-diff:move-to-next-diff");
        expect(editor.getCursorBufferPosition()).toEqual([4, 4]);

        atom.commands.dispatch(editorElement, "git-diff:move-to-previous-diff");
        expect(editor.getCursorBufferPosition()).toEqual([0, 0]);
      });
    });

    it("wraps around to the first/last diff in the file", () => {
      editor.insertText("a");
      editor.setCursorBufferPosition([5]);
      editor.deleteLine();
      advanceClock(editor.getBuffer().stoppedChangingDelay);

      waitsFor(() => editorElement.querySelectorAll(".git-line-removed").length > 0);
      runs(() => {
        editor.setCursorBufferPosition([0]);
        atom.commands.dispatch(editorElement, "git-diff:move-to-next-diff");
        expect(editor.getCursorBufferPosition().toArray()).toEqual([4, 4]);

        atom.commands.dispatch(editorElement, "git-diff:move-to-next-diff");
        expect(editor.getCursorBufferPosition().toArray()).toEqual([0, 0]);

        atom.commands.dispatch(editorElement, "git-diff:move-to-previous-diff");
        expect(editor.getCursorBufferPosition().toArray()).toEqual([4, 4]);
      });
    });

    describe("when the wrapAroundOnMoveToDiff config option is false", () => {
      beforeEach(() => atom.config.set("git-diff.wrapAroundOnMoveToDiff", false));

      it("does not wraps around to the first/last diff in the file", () => {
        editor.insertText("a");
        editor.setCursorBufferPosition([5]);
        editor.deleteLine();
        advanceClock(editor.getBuffer().stoppedChangingDelay);
        waitsFor(() => editorElement.querySelectorAll(".git-line-removed").length > 0);

        runs(() => {
          editor.setCursorBufferPosition([0]);
          atom.commands.dispatch(editorElement, "git-diff:move-to-next-diff");
          expect(editor.getCursorBufferPosition()).toEqual([4, 4]);

          atom.commands.dispatch(editorElement, "git-diff:move-to-next-diff");
          expect(editor.getCursorBufferPosition()).toEqual([4, 4]);

          atom.commands.dispatch(editorElement, "git-diff:move-to-previous-diff");
          expect(editor.getCursorBufferPosition()).toEqual([0, 0]);

          atom.commands.dispatch(editorElement, "git-diff:move-to-previous-diff");
          expect(editor.getCursorBufferPosition()).toEqual([0, 0]);
        });
      });
    });
  });

  describe("when the showIconsInEditorGutter config option is true", () => {
    beforeEach(() => {
      atom.config.set("git-diff.showIconsInEditorGutter", true);
    });

    it("the gutter has a git-diff-icon class", () => {
      waitsFor(() => screenUpdates > 0);
      runs(() => {
        expect(editorElement.querySelector(".gutter")).toHaveClass("git-diff-icon");
      });
    });

    it("keeps the git-diff-icon class when editor.showLineNumbers is toggled", () => {
      waitsFor(() => screenUpdates > 0);

      runs(() => {
        atom.config.set("editor.showLineNumbers", false);
        expect(editorElement.querySelector(".gutter")).not.toHaveClass("git-diff-icon");

        atom.config.set("editor.showLineNumbers", true);
        expect(editorElement.querySelector(".gutter")).toHaveClass("git-diff-icon");
      });
    });

    it("removes the git-diff-icon class when the showIconsInEditorGutter config option set to false", () => {
      waitsFor(() => screenUpdates > 0);

      runs(() => {
        atom.config.set("git-diff.showIconsInEditorGutter", false);
        expect(editorElement.querySelector(".gutter")).not.toHaveClass("git-diff-icon");
      });
    });
  });
});
