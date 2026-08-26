const path = require("path");
const temp = require("@lumine-code/temp").track();
const dedent = require("dedent");
const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const Workspace = require("../src/workspace");
const Task = require("../src/task");
const Project = require("../src/project");
const RepositoryRegistry = require("../src/repository-registry");
const platform = require("./helpers/platform");
const _ = require("@lumine-code/underscore-plus");
const fs = require("@lumine-code/fs-plus");
const LumineEnvironment = require("../src/lumine-environment");
const { conditionPromise, timeoutPromise } = require("./helpers/async-spec-helpers");

describe("Workspace", () => {
  let workspace;
  let setDocumentEdited;

  let fsGetSizeSyncSpy;
  let fsOpenSyncSpy;

  beforeEach(async () => {
    jasmine.useRealClock();
    fsGetSizeSyncSpy = spyOn(fs, "getSizeSync").and.callThrough();
    fsOpenSyncSpy = spyOn(fs, "openSync").and.callThrough();

    workspace = lumine.workspace;
    workspace.resetFontSize();
    spyOn(lumine.applicationDelegate, "confirm");
    setDocumentEdited = spyOn(lumine.applicationDelegate, "setWindowDocumentEdited");
    lumine.project.setPaths([lumine.project.getDirectories()[0].resolve("dir")]);

    await lumine.workspace.itemLocationStore.clear();
  });

  afterEach(() => {
    try {
      temp.cleanupSync();
    } catch {
      // Do nothing
    }
  });

  async function simulateReload() {
    const workspaceState = workspace.serialize();
    const projectState = lumine.project.serialize({ isUnloading: true });
    workspace.destroy();
    lumine.project.destroy();
    lumine.repositories.destroy();
    lumine.repositories = new RepositoryRegistry({
      config: lumine.config,
      notificationManager: lumine.notifications,
    });
    lumine.project = new Project({
      notificationManager: lumine.notifications,
      packageManager: lumine.packages,
      confirm: lumine.window.confirm.bind(lumine.window),
      applicationDelegate: lumine.applicationDelegate,
      grammarRegistry: lumine.grammars,
      repositoryRegistry: lumine.repositories,
    });

    await lumine.project.deserialize(projectState);

    workspace = lumine.workspace = new Workspace({
      config: lumine.config,
      project: lumine.project,
      packageManager: lumine.packages,
      grammarRegistry: lumine.grammars,
      styleManager: lumine.styles,
      deserializerManager: lumine.deserializers,
      notificationManager: lumine.notifications,
      applicationDelegate: lumine.applicationDelegate,
      viewRegistry: lumine.views,
      assert: lumine.assert.bind(lumine),
      textEditorRegistry: lumine.textEditors,
    });
    workspace.initialize({ configDirPath: lumine.getConfigDirPath() });
    workspace.deserialize(workspaceState, lumine.deserializers);
  }

  describe("serialization", () => {
    describe("when the workspace contains text editors", () => {
      it("constructs the view with the same panes", async () => {
        const pane1 = lumine.workspace.getActivePane();
        const pane2 = pane1.splitRight({ copyActiveItem: true });
        const pane3 = pane2.splitRight({ copyActiveItem: true });
        let pane4 = null;

        await lumine.workspace.open(null).then((editor) => editor.setText("An untitled editor."));

        await lumine.workspace.open("b").then((editor) => pane2.activateItem(editor.copy()));

        await lumine.workspace.open("../sample.js").then((editor) => pane3.activateItem(editor));

        pane3.activeItem.setCursorScreenPosition([2, 4]);
        pane4 = pane2.splitDown();

        await lumine.workspace.open("../sample.txt").then((editor) => pane4.activateItem(editor));

        pane4.getActiveItem().setCursorScreenPosition([0, 2]);
        pane2.activate();

        await simulateReload();

        expect(lumine.workspace.getTextEditors().length).toBe(5);
        const [editor1, editor2, untitledEditor, editor3, editor4] =
          lumine.workspace.getTextEditors();
        const firstDirectory = lumine.project.getDirectories()[0];
        expect(firstDirectory).toBeDefined();
        expect(editor1.getPath()).toBe(firstDirectory.resolve("b"));
        expect(editor2.getPath()).toBe(firstDirectory.resolve("../sample.txt"));
        expect(editor2.getCursorScreenPosition()).toEqual([0, 2]);
        expect(editor3.getPath()).toBe(firstDirectory.resolve("b"));
        expect(editor4.getPath()).toBe(firstDirectory.resolve("../sample.js"));
        expect(editor4.getCursorScreenPosition()).toEqual([2, 4]);
        expect(untitledEditor.getPath()).toBeUndefined();
        expect(untitledEditor.getText()).toBe("An untitled editor.");

        expect(lumine.workspace.getActiveTextEditor().getPath()).toBe(editor3.getPath());
      });
    });

    describe("where there are no open panes or editors", () => {
      it("constructs the view with no open editors", async () => {
        lumine.workspace.getActivePane().destroy();
        expect(lumine.workspace.getTextEditors().length).toBe(0);
        await simulateReload();

        expect(lumine.workspace.getTextEditors().length).toBe(0);
      });
    });
  });

  describe("::open(itemOrURI, options)", () => {
    let openEvents = null;

    beforeEach(() => {
      openEvents = [];
      workspace.onDidOpen((event) => openEvents.push(event));
      spyOn(workspace.getActivePane(), "activate").and.callThrough();
    });

    describe("when the 'searchAllPanes' option is false (default)", () => {
      describe("when called without a uri or item", () => {
        it("adds and activates an empty editor on the active pane", async () => {
          let editor1;
          let editor2;

          editor1 = await workspace.open();

          expect(editor1.getPath()).toBeUndefined();
          expect(workspace.getActivePane().items).toEqual([editor1]);
          expect(workspace.getActivePaneItem()).toBe(editor1);
          expect(workspace.getActivePane().activate).toHaveBeenCalled();
          expect(openEvents).toEqual([
            {
              uri: undefined,
              pane: workspace.getActivePane(),
              item: editor1,
              index: 0,
            },
          ]);

          openEvents = [];
          editor2 = await workspace.open();

          expect(editor2.getPath()).toBeUndefined();
          expect(workspace.getActivePane().items).toEqual([editor1, editor2]);
          expect(workspace.getActivePaneItem()).toBe(editor2);
          expect(workspace.getActivePane().activate).toHaveBeenCalled();
          expect(openEvents).toEqual([
            {
              uri: undefined,
              pane: workspace.getActivePane(),
              item: editor2,
              index: 1,
            },
          ]);
        });
      });

      describe("when called with a uri", () => {
        describe("when the active pane already has an editor for the given uri", () => {
          it("activates the existing editor on the active pane", async () => {
            let editor;
            let editor1;
            let editor2;

            editor1 = await workspace.open("a");
            editor2 = await workspace.open("b");
            editor = await workspace.open("a");

            expect(editor).toBe(editor1);
            expect(workspace.getActivePaneItem()).toBe(editor);
            expect(workspace.getActivePane().activate).toHaveBeenCalled();
            const firstDirectory = lumine.project.getDirectories()[0];
            expect(firstDirectory).toBeDefined();
            expect(openEvents).toEqual([
              {
                uri: firstDirectory.resolve("a"),
                item: editor1,
                pane: lumine.workspace.getActivePane(),
                index: 0,
              },
              {
                uri: firstDirectory.resolve("b"),
                item: editor2,
                pane: lumine.workspace.getActivePane(),
                index: 1,
              },
              {
                uri: firstDirectory.resolve("a"),
                item: editor1,
                pane: lumine.workspace.getActivePane(),
                index: 0,
              },
            ]);
          });

          it("finds items in docks", async () => {
            const dock = lumine.workspace.getRightDock();
            const ITEM_URI = "lumine://test";
            const item = {
              getURI: () => ITEM_URI,
              getDefaultLocation: () => "left",
              getElement: () => document.createElement("div"),
            };
            dock.getActivePane().addItem(item);
            expect(dock.getPaneItems()).toHaveLength(1);

            await lumine.workspace.open(ITEM_URI, { searchAllPanes: true });

            expect(lumine.workspace.getPaneItems()).toHaveLength(1);
            expect(dock.getPaneItems()).toHaveLength(1);
            expect(dock.getPaneItems()[0]).toBe(item);
          });
        });

        describe("when the 'activateItem' option is false", () => {
          it("adds the item to the workspace", async () => {
            let editor;

            await workspace.open("a");
            editor = await workspace.open("b", { activateItem: false });

            expect(workspace.getPaneItems()).toContain(editor);
            expect(workspace.getActivePaneItem()).not.toBe(editor);
          });
        });

        describe("when the active pane does not have an editor for the given uri", () => {
          beforeEach(() => {
            lumine.workspace.enablePersistence = true;
          });

          afterEach(async () => {
            await lumine.workspace.itemLocationStore.clear();
            lumine.workspace.enablePersistence = false;
          });

          it("adds and activates a new editor for the given path on the active pane", async () => {
            let editor = await workspace.open("a");

            const firstDirectory = lumine.project.getDirectories()[0];
            expect(firstDirectory).toBeDefined();
            expect(editor.getURI()).toBe(firstDirectory.resolve("a"));
            expect(workspace.getActivePaneItem()).toBe(editor);
            expect(workspace.getActivePane().items).toEqual([editor]);
            expect(workspace.getActivePane().activate).toHaveBeenCalled();
          });

          it("discovers existing editors that are still opening", async () => {
            let editor0 = null;
            let editor1 = null;

            await Promise.all([
              workspace.open("spartacus.txt").then((o0) => {
                editor0 = o0;
              }),
              workspace.open("spartacus.txt").then((o1) => {
                editor1 = o1;
              }),
            ]);

            expect(editor0).toEqual(editor1);
            expect(workspace.getActivePane().items).toEqual([editor0]);
          });

          it("uses the location specified by the model's `getDefaultLocation()` method", async () => {
            const item = {
              getDefaultLocation: jasmine.createSpy().and.returnValue("right"),
              getElement: () => document.createElement("div"),
            };
            const opener = jasmine.createSpy().and.returnValue(item);
            const dock = lumine.workspace.getRightDock();
            spyOn(lumine.workspace.itemLocationStore, "load").and.returnValue(Promise.resolve());
            spyOn(lumine.workspace, "getOpeners").and.returnValue([opener]);
            expect(dock.getPaneItems()).toHaveLength(0);

            await lumine.workspace.open("a");

            expect(dock.getPaneItems()).toHaveLength(1);
            expect(opener).toHaveBeenCalled();
            expect(item.getDefaultLocation).toHaveBeenCalled();
          });

          it("prefers the last location the user used for that item", async () => {
            const ITEM_URI = "lumine://test";
            const item = {
              getURI: () => ITEM_URI,
              getDefaultLocation: () => "left",
              getElement: () => document.createElement("div"),
            };
            const opener = (uri) => (uri === ITEM_URI ? item : null);
            const dock = lumine.workspace.getRightDock();
            spyOn(lumine.workspace.itemLocationStore, "load").and.callFake((uri) =>
              uri === "lumine://test" ? Promise.resolve("right") : Promise.resolve(),
            );
            spyOn(lumine.workspace, "getOpeners").and.returnValue([opener]);
            expect(dock.getPaneItems()).toHaveLength(0);

            await lumine.workspace.open(ITEM_URI);

            expect(dock.getPaneItems()).toHaveLength(1);
            expect(dock.getPaneItems()[0]).toBe(item);
          });
        });
      });

      describe("when an item with the given uri exists in an inactive pane container", () => {
        it("activates that item if it is in that container's active pane", async () => {
          const item = await lumine.workspace.open("a");
          lumine.workspace.getLeftDock().activate();
          expect(await lumine.workspace.open("a", { searchAllPanes: false })).toBe(item);
          expect(lumine.workspace.getActivePaneContainer().getLocation()).toBe("center");
          expect(lumine.workspace.getPaneItems()).toEqual([item]);

          lumine.workspace.getActivePane().splitRight();
          lumine.workspace.getLeftDock().activate();
          const item2 = await lumine.workspace.open("a", {
            searchAllPanes: false,
          });
          expect(item2).not.toBe(item);
          expect(lumine.workspace.getActivePaneContainer().getLocation()).toBe("center");
          expect(lumine.workspace.getPaneItems()).toEqual([item, item2]);
        });
      });
    });

    describe("when the 'searchAllPanes' option is true", () => {
      describe("when an editor for the given uri is already open on an inactive pane", () => {
        it("activates the existing editor on the inactive pane, then activates that pane", async () => {
          let editor1;
          let editor2;
          const pane1 = workspace.getActivePane();
          const pane2 = workspace.getActivePane().splitRight();

          pane1.activate();
          editor1 = await workspace.open("a");

          pane2.activate();
          editor2 = await workspace.open("b");

          expect(workspace.getActivePaneItem()).toBe(editor2);

          await workspace.open("a", { searchAllPanes: true });

          expect(workspace.getActivePane()).toBe(pane1);
          expect(workspace.getActivePaneItem()).toBe(editor1);
        });

        it("discovers existing editors that are still opening in an inactive pane", async () => {
          let editor0 = null;
          let editor1 = null;
          const pane0 = workspace.getActivePane();
          const pane1 = workspace.getActivePane().splitRight();

          pane0.activate();
          const promise0 = workspace.open("spartacus.txt", { searchAllPanes: true }).then((o0) => {
            editor0 = o0;
          });
          pane1.activate();
          const promise1 = workspace.open("spartacus.txt", { searchAllPanes: true }).then((o1) => {
            editor1 = o1;
          });

          await Promise.all([promise0, promise1]);

          expect(editor0).toBeDefined();
          expect(editor1).toBeDefined();

          expect(editor0).toEqual(editor1);
          expect(workspace.getActivePane().items).toEqual([editor0]);
        });

        it("activates the pane in the dock with the matching item", async () => {
          const dock = lumine.workspace.getRightDock();
          const ITEM_URI = "lumine://test";
          const item = {
            getURI: () => ITEM_URI,
            getDefaultLocation: jasmine.createSpy().and.returnValue("left"),
            getElement: () => document.createElement("div"),
          };
          dock.getActivePane().addItem(item);
          spyOn(dock.paneForItem(item), "activate");

          await lumine.workspace.open(ITEM_URI, { searchAllPanes: true });

          expect(dock.paneForItem(item).activate).toHaveBeenCalled();
        });
      });

      describe("when no editor for the given uri is open in any pane", () => {
        it("opens an editor for the given uri in the active pane", async () => {
          let editor = await workspace.open("a", { searchAllPanes: true });

          expect(workspace.getActivePaneItem()).toBe(editor);
        });
      });
    });

    describe("when attempting to open an editor in a dock", () => {
      it("opens the editor in the workspace center", async () => {
        await lumine.workspace.open("sample.txt", { location: "right" });
        expect(lumine.workspace.getCenter().getActivePaneItem().getFileName()).toEqual(
          "sample.txt",
        );
      });
    });

    describe("when called with an item rather than a URI", () => {
      it("adds the item itself to the workspace", async () => {
        const item = document.createElement("div");
        await lumine.workspace.open(item);
        expect(lumine.workspace.getActivePaneItem()).toBe(item);
      });

      describe("when the active pane already contains the item", () => {
        it("activates the item", async () => {
          const item = document.createElement("div");

          await lumine.workspace.open(item);
          await lumine.workspace.open();
          expect(lumine.workspace.getActivePaneItem()).not.toBe(item);
          expect(lumine.workspace.getActivePane().getItems().length).toBe(2);

          await lumine.workspace.open(item);
          expect(lumine.workspace.getActivePaneItem()).toBe(item);
          expect(lumine.workspace.getActivePane().getItems().length).toBe(2);
        });
      });

      describe("when the item already exists in another pane", () => {
        it("activates the item in the pane that already contains it", async () => {
          const item = document.createElement("div");

          await lumine.workspace.open(item);
          const originalPane = lumine.workspace.getActivePane();
          await lumine.workspace.open(null, { split: "right" });
          expect(lumine.workspace.getActivePaneItem()).not.toBe(item);
          expect(lumine.workspace.getActivePane().getItems().length).toBe(1);

          await lumine.workspace.open(item);
          expect(lumine.workspace.getActivePane()).toBe(originalPane);
          expect(lumine.workspace.getActivePaneItem()).toBe(item);
          expect(originalPane.getItems().length).toBe(1);
        });
      });
    });

    describe("when the 'split' option is set", () => {
      describe("when the 'split' option is 'left'", () => {
        it("opens the editor in the leftmost pane of the current pane axis", async () => {
          const pane1 = workspace.getActivePane();
          const pane2 = pane1.splitRight();
          expect(workspace.getActivePane()).toBe(pane2);

          let editor = await workspace.open("a", { split: "left" });

          expect(workspace.getActivePane()).toBe(pane1);
          expect(pane1.items).toEqual([editor]);
          expect(pane2.items).toEqual([]);

          // Focus right pane and reopen the file on the left
          pane2.focus();
          editor = await workspace.open("a", { split: "left" });

          expect(workspace.getActivePane()).toBe(pane1);
          expect(pane1.items).toEqual([editor]);
          expect(pane2.items).toEqual([]);
        });
      });

      describe("when a pane axis is the leftmost sibling of the current pane", () => {
        it("opens the new item in the current pane", async () => {
          let editor;
          const pane1 = workspace.getActivePane();
          const pane2 = pane1.splitLeft();
          pane2.splitDown();
          pane1.activate();
          expect(workspace.getActivePane()).toBe(pane1);

          editor = await workspace.open("a", { split: "left" });

          expect(workspace.getActivePane()).toBe(pane1);
          expect(pane1.items).toEqual([editor]);
        });
      });

      describe("when the 'split' option is 'right'", () => {
        it("opens the editor in the rightmost pane of the current pane axis", async () => {
          let editor;
          const pane1 = workspace.getActivePane();
          let pane2;

          editor = await workspace.open("a", { split: "right" });

          pane2 = workspace.getPanes().filter((p) => p !== pane1)[0];
          expect(workspace.getActivePane()).toBe(pane2);
          expect(pane1.items).toEqual([]);
          expect(pane2.items).toEqual([editor]);

          // Focus right pane and reopen the file on the right
          pane1.focus();
          editor = await workspace.open("a", { split: "right" });

          expect(workspace.getActivePane()).toBe(pane2);
          expect(pane1.items).toEqual([]);
          expect(pane2.items).toEqual([editor]);
        });

        describe("when a pane axis is the rightmost sibling of the current pane", () => {
          it("opens the new item in a new pane split to the right of the current pane", async () => {
            let editor;
            const pane1 = workspace.getActivePane();
            const pane2 = pane1.splitRight();
            pane2.splitDown();
            pane1.activate();
            expect(workspace.getActivePane()).toBe(pane1);
            let pane4;

            editor = await workspace.open("a", { split: "right" });

            pane4 = workspace.getPanes().filter((p) => p !== pane1)[0];
            expect(workspace.getActivePane()).toBe(pane4);
            expect(pane4.items).toEqual([editor]);
            expect(workspace.getCenter().paneContainer.root.children[0]).toBe(pane1);
            expect(workspace.getCenter().paneContainer.root.children[1]).toBe(pane4);
          });
        });
      });

      describe("when the 'split' option is 'up'", () => {
        it("opens the editor in the topmost pane of the current pane axis", async () => {
          const pane1 = workspace.getActivePane();
          const pane2 = pane1.splitDown();
          expect(workspace.getActivePane()).toBe(pane2);

          let editor = await workspace.open("a", { split: "up" });

          expect(workspace.getActivePane()).toBe(pane1);
          expect(pane1.items).toEqual([editor]);
          expect(pane2.items).toEqual([]);

          // Focus bottom pane and reopen the file on the top
          pane2.focus();
          editor = await workspace.open("a", { split: "up" });

          expect(workspace.getActivePane()).toBe(pane1);
          expect(pane1.items).toEqual([editor]);
          expect(pane2.items).toEqual([]);
        });
      });

      describe("when a pane axis is the topmost sibling of the current pane", () => {
        it("opens the new item in the current pane", async () => {
          let editor;
          const pane1 = workspace.getActivePane();
          const pane2 = pane1.splitUp();
          pane2.splitRight();
          pane1.activate();
          expect(workspace.getActivePane()).toBe(pane1);

          editor = await workspace.open("a", { split: "up" });

          expect(workspace.getActivePane()).toBe(pane1);
          expect(pane1.items).toEqual([editor]);
        });
      });

      describe("when the 'split' option is 'down'", () => {
        it("opens the editor in the bottommost pane of the current pane axis", async () => {
          let editor;
          const pane1 = workspace.getActivePane();
          let pane2;

          editor = await workspace.open("a", { split: "down" });

          pane2 = workspace.getPanes().filter((p) => p !== pane1)[0];
          expect(workspace.getActivePane()).toBe(pane2);
          expect(pane1.items).toEqual([]);
          expect(pane2.items).toEqual([editor]);

          // Focus bottom pane and reopen the file on the right
          pane1.focus();
          editor = await workspace.open("a", { split: "down" });

          expect(workspace.getActivePane()).toBe(pane2);
          expect(pane1.items).toEqual([]);
          expect(pane2.items).toEqual([editor]);
        });

        describe("when a pane axis is the bottommost sibling of the current pane", () => {
          it("opens the new item in a new pane split to the bottom of the current pane", async () => {
            let editor;
            const pane1 = workspace.getActivePane();
            const pane2 = pane1.splitDown();
            pane1.activate();
            expect(workspace.getActivePane()).toBe(pane1);
            let pane4;

            editor = await workspace.open("a", { split: "down" });

            pane4 = workspace.getPanes().filter((p) => p !== pane1)[0];
            expect(workspace.getActivePane()).toBe(pane4);
            expect(pane4.items).toEqual([editor]);
            expect(workspace.getCenter().paneContainer.root.children[0]).toBe(pane1);
            expect(workspace.getCenter().paneContainer.root.children[1]).toBe(pane2);
          });
        });
      });

      describe("when 'activatePane' is false and the split creates a new pane", () => {
        it("leaves the original pane active when splitting right", async () => {
          const pane1 = workspace.getActivePane();

          const editor = await workspace.open("a", {
            split: "right",
            activatePane: false,
          });

          const pane2 = workspace.getPanes().filter((p) => p !== pane1)[0];
          expect(pane2).toBeDefined();
          expect(pane2.items).toEqual([editor]);
          expect(workspace.getActivePane()).toBe(pane1);
        });

        it("leaves the original pane active when splitting down", async () => {
          const pane1 = workspace.getActivePane();

          const editor = await workspace.open("a", {
            split: "down",
            activatePane: false,
          });

          const pane2 = workspace.getPanes().filter((p) => p !== pane1)[0];
          expect(pane2).toBeDefined();
          expect(pane2.items).toEqual([editor]);
          expect(workspace.getActivePane()).toBe(pane1);
        });
      });
    });

    describe("when an initialLine and initialColumn are specified", () => {
      it("moves the cursor to the indicated location", async () => {
        await workspace.open("a", { initialLine: 1, initialColumn: 5 });

        expect(workspace.getActiveTextEditor().getCursorBufferPosition()).toEqual([1, 5]);

        await workspace.open("a", { initialLine: 2, initialColumn: 4 });

        expect(workspace.getActiveTextEditor().getCursorBufferPosition()).toEqual([2, 4]);

        await workspace.open("a", { initialLine: 0, initialColumn: 0 });

        expect(workspace.getActiveTextEditor().getCursorBufferPosition()).toEqual([0, 0]);

        await workspace.open("a", { initialLine: NaN, initialColumn: 4 });

        expect(workspace.getActiveTextEditor().getCursorBufferPosition()).toEqual([0, 4]);

        await workspace.open("a", { initialLine: 2, initialColumn: NaN });

        expect(workspace.getActiveTextEditor().getCursorBufferPosition()).toEqual([2, 0]);

        await workspace.open("a", {
          initialLine: Infinity,
          initialColumn: Infinity,
        });

        expect(workspace.getActiveTextEditor().getCursorBufferPosition()).toEqual([2, 11]);

        await workspace.open("a", { initialLine: null, initialColumn: 4 });

        expect(workspace.getActiveTextEditor().getCursorBufferPosition()).toEqual([0, 4]);

        await workspace.open("a", { initialLine: 2, initialColumn: null });

        expect(workspace.getActiveTextEditor().getCursorBufferPosition()).toEqual([2, 0]);
      });

      it("does not throw when opened without position options", async () => {
        await workspace.open("a", {});
        await workspace.open("a", { initialLine: null, initialColumn: null });
        await workspace.open("a", {
          initialLine: undefined,
          initialColumn: undefined,
        });
      });

      it("does not throw when opening a file outside the project with null position options", async () => {
        // lumine-application.js parsePathToOpen() sets initialLine/initialColumn to null
        // for files opened without a line:column suffix (e.g. via recent files or drag-and-drop)
        const dir = temp.mkdirSync("outside-project");
        const filePath = path.join(dir, "outside.txt");
        fs.writeFileSync(filePath, "content outside project\n");

        await workspace.open(filePath, { initialLine: null, initialColumn: null });

        expect(workspace.getActiveTextEditor().getCursorBufferPosition()).toEqual([0, 0]);
      });

      it("unfolds the fold containing the line", async () => {
        let editor;

        await workspace.open("../sample-with-many-folds.js");
        editor = workspace.getActiveTextEditor();
        editor.foldBufferRow(2);
        expect(editor.isFoldedAtBufferRow(2)).toBe(true);
        expect(editor.isFoldedAtBufferRow(3)).toBe(true);

        await workspace.open("../sample-with-many-folds.js", {
          initialLine: 2,
        });
        expect(editor.isFoldedAtBufferRow(2)).toBe(false);
        expect(editor.isFoldedAtBufferRow(3)).toBe(false);
      });
    });

    describe("when the file size is over the limit defined in `core.warnOnLargeFileLimit`", () => {
      const shouldPromptForFileOfSize = async (size, shouldPrompt) => {
        fsGetSizeSyncSpy.and.returnValue(size * 1048577);

        let selectedButtonIndex = 1; // cancel
        lumine.applicationDelegate.confirm.and.callFake(() => Promise.resolve(selectedButtonIndex));

        let editor = await workspace.open("sample.js");
        if (shouldPrompt) {
          expect(editor).toBeUndefined();
          expect(lumine.applicationDelegate.confirm).toHaveBeenCalled();

          lumine.applicationDelegate.confirm.calls.reset();
          selectedButtonIndex = 0; // open the file

          await workspace.open("sample.js");

          expect(lumine.applicationDelegate.confirm).toHaveBeenCalled();
        } else {
          expect(editor).not.toBeUndefined();
        }
      };

      it("prompts before opening the file", async () => {
        lumine.config.set("core.warnOnLargeFileLimit", 20);
        await shouldPromptForFileOfSize(20, true);
      });

      it("doesn't prompt on files below the limit", async () => {
        lumine.config.set("core.warnOnLargeFileLimit", 30);
        await shouldPromptForFileOfSize(20, false);
      });

      it("prompts for smaller files with a lower limit", async () => {
        lumine.config.set("core.warnOnLargeFileLimit", 5);
        await shouldPromptForFileOfSize(10, true);
      });
    });

    describe("when `core.maxTextEditors` editors are already open", () => {
      beforeEach(() => {
        // The limit stands down in spec mode, since suites open far more files
        // than any sane limit; these specs are the ones that want it.
        spyOn(lumine.window, "isSpecMode").and.returnValue(false);
      });

      it("refuses the open, resolving with nothing", async () => {
        await workspace.open("sample.js");
        lumine.config.set("core.maxTextEditors", 1);

        const editor = await workspace.open("sample.txt");

        expect(editor).toBeUndefined();
        expect(workspace.getTextEditors().length).toBe(1);
      });

      it("says so once, with a button that opens it anyway", async () => {
        await workspace.open("sample.js");
        lumine.config.set("core.maxTextEditors", 1);
        spyOn(workspace.notificationManager, "addWarning").and.callThrough();

        await workspace.open("sample.txt");
        await workspace.open("sample.txt");

        expect(workspace.notificationManager.addWarning.calls.count()).toBe(2);
        const [message, options] = workspace.notificationManager.addWarning.calls.mostRecent().args;
        expect(message).toBe("Too many editors are open");
        expect(options.description).toContain("core.maxTextEditors");

        await options.buttons[0].onDidClick();
        expect(workspace.getTextEditors().length).toBe(2);
      });

      it("never refuses an item that is already open", async () => {
        const first = await workspace.open("sample.js");
        lumine.config.set("core.maxTextEditors", 1);

        expect(await workspace.open("sample.js")).toBe(first);
        expect(workspace.getTextEditors().length).toBe(1);
      });

      // Only editors carry the cost the limit exists for, and refusing the
      // views a package opens could block reaching the setting itself.
      it("never refuses an item that is not an editor", async () => {
        await workspace.open("sample.js");
        lumine.config.set("core.maxTextEditors", 1);
        workspace.addOpener((uri) =>
          uri === "lumine://a-view"
            ? { getTitle: () => "A view", element: document.createElement("div") }
            : undefined,
        );

        expect(await workspace.open("lumine://a-view")).not.toBeUndefined();
        expect(workspace.getCenter().getPaneItems().length).toBe(2);
      });

      it("does not count a preview against the limit when one is already pending", async () => {
        await workspace.open("sample.js", { pending: true });
        lumine.config.set("core.maxTextEditors", 1);

        const editor = await workspace.open("sample.txt", { pending: true });

        expect(editor).not.toBeUndefined();
        expect(workspace.getTextEditors().length).toBe(1);
      });

      it("does not limit anything when set to 0", async () => {
        await workspace.open("sample.js");
        lumine.config.set("core.maxTextEditors", 0);

        expect(await workspace.open("sample.txt")).not.toBeUndefined();
      });
    });

    describe("when passed a path that matches a custom opener", () => {
      it("returns the resource returned by the custom opener", async () => {
        const fooOpener = (pathToOpen, options) => {
          if (pathToOpen != null ? pathToOpen.match(/\.foo/) : undefined) {
            return { foo: pathToOpen, options };
          }
        };
        const barOpener = (pathToOpen) => {
          if (pathToOpen != null ? pathToOpen.match(/^bar:\/\//) : undefined) {
            return { bar: pathToOpen };
          }
        };
        workspace.addOpener(fooOpener);
        workspace.addOpener(barOpener);

        const pathToOpen = lumine.project.getDirectories()[0].resolve("a.foo");
        expect(await workspace.open(pathToOpen, { hey: "there" })).toEqual({
          foo: pathToOpen,
          options: { hey: "there" },
        });

        expect(await workspace.open("bar://baz")).toEqual({ bar: "bar://baz" });
      });
    });

    it("adds the file to the application's recent documents list", async () => {
      jasmine.filterByPlatform({ only: ["darwin"] }); // Feature only supported on macOS

      spyOn(lumine.applicationDelegate, "addRecentDocument");

      await workspace.open();

      expect(lumine.applicationDelegate.addRecentDocument).not.toHaveBeenCalled();

      await workspace.open("something://a/url");

      expect(lumine.applicationDelegate.addRecentDocument).not.toHaveBeenCalled();

      await workspace.open(__filename);

      expect(lumine.applicationDelegate.addRecentDocument).toHaveBeenCalledWith(__filename);
    });

    it("notifies ::onDidAddTextEditor observers", async () => {
      const absolutePath = require.resolve("./fixtures/dir/a");
      const newEditorHandler = jasmine.createSpy("newEditorHandler");
      workspace.onDidAddTextEditor(newEditorHandler);

      let editor = await workspace.open(absolutePath);

      expect(newEditorHandler.calls.argsFor(0)[0].textEditor).toBe(editor);
    });

    describe("when there is an error opening the file", () => {
      let notificationSpy = null;
      beforeEach(() =>
        lumine.notifications.onDidAddNotification((notificationSpy = jasmine.createSpy())),
      );

      describe("when a file does not exist", () => {
        it("creates an empty buffer for the specified path", async () => {
          await workspace.open("not-a-file.md");

          const editor = workspace.getActiveTextEditor();
          expect(notificationSpy).not.toHaveBeenCalled();
          expect(editor.getPath()).toContain("not-a-file.md");
        });
      });

      describe("when the user does not have access to the file", () => {
        beforeEach(() => {
          fsOpenSyncSpy.and.callFake((path) => {
            const error = new Error(`EACCES, permission denied '${path}'`);
            error.path = path;
            error.code = "EACCES";
            throw error;
          });
        });

        it("creates a notification", async () => {
          await workspace.open("file1");

          expect(notificationSpy).toHaveBeenCalled();
          const notification = notificationSpy.calls.mostRecent().args[0];
          expect(notification.getType()).toBe("warning");
          expect(notification.getMessage()).toContain("Permission denied");
          expect(notification.getMessage()).toContain("file1");
        });
      });

      describe("when the the operation is not permitted", () => {
        beforeEach(() => {
          fsOpenSyncSpy.and.callFake((path) => {
            const error = new Error(`EPERM, operation not permitted '${path}'`);
            error.path = path;
            error.code = "EPERM";
            throw error;
          });
        });

        it("creates a notification", async () => {
          await workspace.open("file1");

          expect(notificationSpy).toHaveBeenCalled();
          const notification = notificationSpy.calls.mostRecent().args[0];
          expect(notification.getType()).toBe("warning");
          expect(notification.getMessage()).toContain("Unable to open");
          expect(notification.getMessage()).toContain("file1");
        });
      });

      describe("when the the file is already open in windows", () => {
        beforeEach(() => {
          fsOpenSyncSpy.and.callFake((path) => {
            const error = new Error(`EBUSY, resource busy or locked '${path}'`);
            error.path = path;
            error.code = "EBUSY";
            throw error;
          });
        });

        it("creates a notification", async () => {
          await workspace.open("file1");

          expect(notificationSpy).toHaveBeenCalled();
          const notification = notificationSpy.calls.mostRecent().args[0];
          expect(notification.getType()).toBe("warning");
          expect(notification.getMessage()).toContain("Unable to open");
          expect(notification.getMessage()).toContain("file1");
        });
      });

      describe("when there is an unhandled error", () => {
        beforeEach(() => {
          fsOpenSyncSpy.and.callFake((_path) => {
            throw new Error("I dont even know what is happening right now!!");
          });
        });

        it("rejects the promise", (done) => {
          workspace.open("file1").catch((error) => {
            expect(error.message).toBe("I dont even know what is happening right now!!");
            done();
          });
        });
      });
    });

    describe("when the file is already open in pending state", () => {
      it("should terminate the pending state", async () => {
        let editor;
        let pane;

        editor = await lumine.workspace.open("sample.js", { pending: true });
        pane = lumine.workspace.getActivePane();

        expect(pane.getPendingItem()).toEqual(editor);

        await lumine.workspace.open("sample.js");

        expect(pane.getPendingItem()).toBeNull();
      });
    });

    describe("when opening will switch from a pending tab to a permanent tab", () => {
      it("keeps the pending tab open", async () => {
        let editor1;
        let editor2;

        editor1 = await lumine.workspace.open("sample.txt");
        editor2 = await lumine.workspace.open("sample2.txt", { pending: true });

        const pane = lumine.workspace.getActivePane();
        pane.activateItem(editor1);
        expect(pane.getItems().length).toBe(2);
        expect(pane.getItems()).toEqual([editor1, editor2]);
      });
    });

    describe("when replacing a pending item which is the last item in a second pane", () => {
      it("does not destroy the pane even if core.destroyEmptyPanes is on", async () => {
        lumine.config.set("core.destroyEmptyPanes", true);
        let editor1;
        let editor2;
        const leftPane = lumine.workspace.getActivePane();
        let rightPane;

        editor1 = await lumine.workspace.open("sample.js", { pending: true, split: "right" });
        rightPane = lumine.workspace.getActivePane();
        spyOn(rightPane, "destroy").and.callThrough();

        expect(leftPane).not.toBe(rightPane);
        expect(lumine.workspace.getActivePane()).toBe(rightPane);
        expect(lumine.workspace.getActivePane().getItems().length).toBe(1);
        expect(rightPane.getPendingItem()).toBe(editor1);

        editor2 = await lumine.workspace.open("sample.txt", { pending: true });

        expect(rightPane.getPendingItem()).toBe(editor2);
        expect(rightPane.destroy.calls.count()).toBe(0);
      });
    });

    describe("when opening an editor with a buffer that isn't part of the project", () => {
      it("adds the buffer to the project", async () => {
        const buffer = new TextBuffer();
        const editor = new TextEditor({ buffer });

        await lumine.workspace.open(editor);

        expect(lumine.project.getBuffers().map((buffer) => buffer.id)).toContain(buffer.id);
        expect(buffer.getLanguageMode().getLanguageId()).toBe("text.plain.null-grammar");
      });
    });
  });

  describe("finding items in the workspace", () => {
    it("can identify the pane and pane container for a given item or URI", () => {
      const uri = "lumine://test-pane-for-item";
      const item = {
        element: document.createElement("div"),
        getURI() {
          return uri;
        },
      };

      lumine.workspace.getActivePane().activateItem(item);
      expect(lumine.workspace.paneForItem(item)).toBe(lumine.workspace.getCenter().getActivePane());
      expect(lumine.workspace.paneContainerForItem(item)).toBe(lumine.workspace.getCenter());
      expect(lumine.workspace.paneForURI(uri)).toBe(lumine.workspace.getCenter().getActivePane());
      expect(lumine.workspace.paneContainerForURI(uri)).toBe(lumine.workspace.getCenter());

      lumine.workspace.getActivePane().destroyActiveItem();
      lumine.workspace.getLeftDock().getActivePane().activateItem(item);
      expect(lumine.workspace.paneForItem(item)).toBe(
        lumine.workspace.getLeftDock().getActivePane(),
      );
      expect(lumine.workspace.paneContainerForItem(item)).toBe(lumine.workspace.getLeftDock());
      expect(lumine.workspace.paneForURI(uri)).toBe(lumine.workspace.getLeftDock().getActivePane());
      expect(lumine.workspace.paneContainerForURI(uri)).toBe(lumine.workspace.getLeftDock());
    });
  });

  describe("::hide(uri)", () => {
    let item;
    const URI = "lumine://hide-test";

    beforeEach(() => {
      const el = document.createElement("div");
      item = {
        getTitle: () => "Item",
        getElement: () => el,
        getURI: () => URI,
      };
    });

    describe("when called with a URI", () => {
      it("if the item for the given URI is in the center, removes it", () => {
        const pane = lumine.workspace.getActivePane();
        pane.addItem(item);
        lumine.workspace.hide(URI);
        expect(pane.getItems().length).toBe(0);
      });

      it("if the item for the given URI is in a dock, hides the dock", () => {
        const dock = lumine.workspace.getLeftDock();
        const pane = dock.getActivePane();
        pane.addItem(item);
        dock.activate();
        expect(dock.isVisible()).toBe(true);
        const itemFound = lumine.workspace.hide(URI);
        expect(itemFound).toBe(true);
        expect(dock.isVisible()).toBe(false);
      });
    });

    describe("when called with an item", () => {
      it("if the item is in the center, removes it", () => {
        const pane = lumine.workspace.getActivePane();
        pane.addItem(item);
        lumine.workspace.hide(item);
        expect(pane.getItems().length).toBe(0);
      });

      it("if the item is in a dock, hides the dock", () => {
        const dock = lumine.workspace.getLeftDock();
        const pane = dock.getActivePane();
        pane.addItem(item);
        dock.activate();
        expect(dock.isVisible()).toBe(true);
        const itemFound = lumine.workspace.hide(item);
        expect(itemFound).toBe(true);
        expect(dock.isVisible()).toBe(false);
      });
    });
  });

  describe("::toggle(itemOrUri)", () => {
    describe("when the location resolves to a dock", () => {
      it("adds or shows the item and its dock if it is not currently visible, and otherwise hides the containing dock", async () => {
        const item1 = {
          getDefaultLocation() {
            return "left";
          },
          getElement() {
            return (this.element = document.createElement("div"));
          },
        };

        const item2 = {
          getDefaultLocation() {
            return "left";
          },
          getElement() {
            return (this.element = document.createElement("div"));
          },
        };

        const dock = workspace.getLeftDock();
        expect(dock.isVisible()).toBe(false);

        await workspace.toggle(item1);
        expect(dock.isVisible()).toBe(true);
        expect(dock.getActivePaneItem()).toBe(item1);

        await workspace.toggle(item2);
        expect(dock.isVisible()).toBe(true);
        expect(dock.getActivePaneItem()).toBe(item2);

        await workspace.toggle(item1);
        expect(dock.isVisible()).toBe(true);
        expect(dock.getActivePaneItem()).toBe(item1);

        await workspace.toggle(item1);
        expect(dock.isVisible()).toBe(false);
        expect(dock.getActivePaneItem()).toBe(item1);

        await workspace.toggle(item2);
        expect(dock.isVisible()).toBe(true);
        expect(dock.getActivePaneItem()).toBe(item2);
      });
    });

    describe("when the location resolves to the center", () => {
      it("adds or shows the item if it is not currently the active pane item, and otherwise removes the item", async () => {
        const item1 = {
          getDefaultLocation() {
            return "center";
          },
          getElement() {
            return (this.element = document.createElement("div"));
          },
        };

        const item2 = {
          getDefaultLocation() {
            return "center";
          },
          getElement() {
            return (this.element = document.createElement("div"));
          },
        };

        expect(workspace.getActivePaneItem()).toBeUndefined();
        await workspace.toggle(item1);
        expect(workspace.getActivePaneItem()).toBe(item1);
        await workspace.toggle(item2);
        expect(workspace.getActivePaneItem()).toBe(item2);
        await workspace.toggle(item1);
        expect(workspace.getActivePaneItem()).toBe(item1);
        await workspace.toggle(item1);
        expect(workspace.paneForItem(item1)).toBeUndefined();
        expect(workspace.getActivePaneItem()).toBe(item2);
      });
    });
  });

  describe("active pane containers", () => {
    it("maintains the active pane and item globally across active pane containers", () => {
      const leftDock = workspace.getLeftDock();
      const leftItem1 = { element: document.createElement("div") };
      const leftItem2 = { element: document.createElement("div") };
      const leftItem3 = { element: document.createElement("div") };
      const leftPane1 = leftDock.getActivePane();
      leftPane1.addItems([leftItem1, leftItem2]);
      const leftPane2 = leftPane1.splitDown({ items: [leftItem3] });

      const rightDock = workspace.getRightDock();
      const rightItem1 = { element: document.createElement("div") };
      const rightItem2 = { element: document.createElement("div") };
      const rightItem3 = { element: document.createElement("div") };
      const rightPane1 = rightDock.getActivePane();
      rightPane1.addItems([rightItem1, rightItem2]);
      const rightPane2 = rightPane1.splitDown({ items: [rightItem3] });

      const bottomDock = workspace.getBottomDock();
      const bottomItem1 = { element: document.createElement("div") };
      const bottomItem2 = { element: document.createElement("div") };
      const bottomItem3 = { element: document.createElement("div") };
      const bottomPane1 = bottomDock.getActivePane();
      bottomPane1.addItems([bottomItem1, bottomItem2]);
      const bottomPane2 = bottomPane1.splitDown({ items: [bottomItem3] });

      const center = workspace.getCenter();
      const centerItem1 = { element: document.createElement("div") };
      const centerItem2 = { element: document.createElement("div") };
      const centerItem3 = { element: document.createElement("div") };
      const centerPane1 = center.getActivePane();
      centerPane1.addItems([centerItem1, centerItem2]);
      const centerPane2 = centerPane1.splitDown({ items: [centerItem3] });

      const activePaneContainers = [];
      const activePanes = [];
      const activeItems = [];
      workspace.onDidChangeActivePaneContainer((container) => activePaneContainers.push(container));
      workspace.onDidChangeActivePane((pane) => activePanes.push(pane));
      workspace.onDidChangeActivePaneItem((item) => activeItems.push(item));
      function clearEvents() {
        activePaneContainers.length = 0;
        activePanes.length = 0;
        activeItems.length = 0;
      }

      expect(workspace.getActivePaneContainer()).toBe(center);
      expect(workspace.getActivePane()).toBe(centerPane2);
      expect(workspace.getActivePaneItem()).toBe(centerItem3);

      leftDock.activate();
      expect(workspace.getActivePaneContainer()).toBe(leftDock);
      expect(workspace.getActivePane()).toBe(leftPane2);
      expect(workspace.getActivePaneItem()).toBe(leftItem3);
      expect(activePaneContainers).toEqual([leftDock]);
      expect(activePanes).toEqual([leftPane2]);
      expect(activeItems).toEqual([leftItem3]);

      clearEvents();
      leftPane1.activate();
      leftPane1.activate();
      expect(workspace.getActivePaneContainer()).toBe(leftDock);
      expect(workspace.getActivePane()).toBe(leftPane1);
      expect(workspace.getActivePaneItem()).toBe(leftItem1);
      expect(activePaneContainers).toEqual([]);
      expect(activePanes).toEqual([leftPane1]);
      expect(activeItems).toEqual([leftItem1]);

      clearEvents();
      leftPane1.activateItem(leftItem2);
      leftPane1.activateItem(leftItem2);
      expect(workspace.getActivePaneContainer()).toBe(leftDock);
      expect(workspace.getActivePane()).toBe(leftPane1);
      expect(workspace.getActivePaneItem()).toBe(leftItem2);
      expect(activePaneContainers).toEqual([]);
      expect(activePanes).toEqual([]);
      expect(activeItems).toEqual([leftItem2]);

      clearEvents();
      expect(rightDock.getActivePane()).toBe(rightPane2);
      rightPane1.activate();
      rightPane1.activate();
      expect(workspace.getActivePaneContainer()).toBe(rightDock);
      expect(workspace.getActivePane()).toBe(rightPane1);
      expect(workspace.getActivePaneItem()).toBe(rightItem1);
      expect(activePaneContainers).toEqual([rightDock]);
      expect(activePanes).toEqual([rightPane1]);
      expect(activeItems).toEqual([rightItem1]);

      clearEvents();
      rightPane1.activateItem(rightItem2);
      expect(workspace.getActivePaneContainer()).toBe(rightDock);
      expect(workspace.getActivePane()).toBe(rightPane1);
      expect(workspace.getActivePaneItem()).toBe(rightItem2);
      expect(activePaneContainers).toEqual([]);
      expect(activePanes).toEqual([]);
      expect(activeItems).toEqual([rightItem2]);

      clearEvents();
      expect(bottomDock.getActivePane()).toBe(bottomPane2);
      bottomPane2.activate();
      bottomPane2.activate();
      expect(workspace.getActivePaneContainer()).toBe(bottomDock);
      expect(workspace.getActivePane()).toBe(bottomPane2);
      expect(workspace.getActivePaneItem()).toBe(bottomItem3);
      expect(activePaneContainers).toEqual([bottomDock]);
      expect(activePanes).toEqual([bottomPane2]);
      expect(activeItems).toEqual([bottomItem3]);

      clearEvents();
      center.activate();
      center.activate();
      expect(workspace.getActivePaneContainer()).toBe(center);
      expect(workspace.getActivePane()).toBe(centerPane2);
      expect(workspace.getActivePaneItem()).toBe(centerItem3);
      expect(activePaneContainers).toEqual([center]);
      expect(activePanes).toEqual([centerPane2]);
      expect(activeItems).toEqual([centerItem3]);

      clearEvents();
      centerPane1.activate();
      centerPane1.activate();
      expect(workspace.getActivePaneContainer()).toBe(center);
      expect(workspace.getActivePane()).toBe(centerPane1);
      expect(workspace.getActivePaneItem()).toBe(centerItem1);
      expect(activePaneContainers).toEqual([]);
      expect(activePanes).toEqual([centerPane1]);
      expect(activeItems).toEqual([centerItem1]);
    });
  });

  describe("::onDidStopChangingActivePaneItem()", () => {
    it("invokes observers when the active item of the active pane stops changing", async () => {
      const pane1 = lumine.workspace.getCenter().getActivePane();
      const pane2 = pane1.splitRight({
        items: [document.createElement("div"), document.createElement("div")],
      });
      lumine.workspace.getLeftDock().getActivePane().addItem(document.createElement("div"));

      const emittedItems = [];
      lumine.workspace.onDidStopChangingActivePaneItem((item) => emittedItems.push(item));

      pane2.activateNextItem();
      pane2.activateNextItem();
      pane1.activate();
      lumine.workspace.getLeftDock().activate();

      await timeoutPromise(100);
      expect(emittedItems).toEqual([lumine.workspace.getLeftDock().getActivePaneItem()]);
    });
  });

  describe("the grammar-used hook", () => {
    it("fires when opening a file or changing the grammar of an open file", async () => {
      await lumine.packages.activatePackage("language-javascript");
      await lumine.packages.activatePackage("language-python");

      const observeTextEditorsSpy = jasmine.createSpy("observeTextEditors");
      const javascriptGrammarUsed = jasmine.createSpy("javascript");
      const pythonGrammarUsed = jasmine.createSpy("python");

      lumine.packages.triggerDeferredActivationHooks();
      lumine.packages.onDidTriggerActivationHook("language-javascript:grammar-used", () => {
        lumine.workspace.observeTextEditors(observeTextEditorsSpy);
        javascriptGrammarUsed();
      });
      lumine.packages.onDidTriggerActivationHook("language-python:grammar-used", pythonGrammarUsed);

      expect(javascriptGrammarUsed).not.toHaveBeenCalled();
      expect(observeTextEditorsSpy).not.toHaveBeenCalled();
      const editor = await lumine.workspace.open("sample.js", {
        autoIndent: false,
      });
      expect(javascriptGrammarUsed).toHaveBeenCalled();
      expect(observeTextEditorsSpy.calls.count()).toBe(1);

      expect(pythonGrammarUsed).not.toHaveBeenCalled();
      lumine.grammars.assignLanguageMode(editor, "source.python");
      expect(pythonGrammarUsed).toHaveBeenCalled();
    });
  });

  describe("the root-scope-used hook", () => {
    it("fires when opening a file or changing the grammar of an open file", async () => {
      await lumine.packages.activatePackage("language-javascript");
      await lumine.packages.activatePackage("language-python");

      const observeTextEditorsSpy = jasmine.createSpy("observeTextEditors");
      const javascriptGrammarUsed = jasmine.createSpy("javascript");
      const pythonGrammarUsed = jasmine.createSpy("python");

      lumine.packages.triggerDeferredActivationHooks();
      lumine.packages.onDidTriggerActivationHook("source.js:root-scope-used", () => {
        lumine.workspace.observeTextEditors(observeTextEditorsSpy);
        javascriptGrammarUsed();
      });
      lumine.packages.onDidTriggerActivationHook(
        "source.python:root-scope-used",
        pythonGrammarUsed,
      );

      expect(javascriptGrammarUsed).not.toHaveBeenCalled();
      expect(observeTextEditorsSpy).not.toHaveBeenCalled();
      const editor = await lumine.workspace.open("sample.js", {
        autoIndent: false,
      });
      expect(javascriptGrammarUsed).toHaveBeenCalled();
      expect(observeTextEditorsSpy.calls.count()).toBe(1);

      expect(pythonGrammarUsed).not.toHaveBeenCalled();
      lumine.grammars.assignLanguageMode(editor, "source.python");
      expect(pythonGrammarUsed).toHaveBeenCalled();
    });
  });

  describe("the file opened hook", () => {
    it("fires when opening a file", async () => {
      const packageUsed = jasmine.createSpy("my-fake-package");

      lumine.packages.triggerDeferredActivationHooks();
      lumine.packages.onDidTriggerActivationHook("sample.js:file-name-opened", packageUsed);

      expect(packageUsed).not.toHaveBeenCalled();
      await lumine.workspace.open("sample.js", {
        autoIndent: false,
      });
      expect(packageUsed).toHaveBeenCalled();
    });
  });

  describe("::reopenItem()", () => {
    it("opens the uri associated with the last closed pane that isn't currently open", async () => {
      const pane = workspace.getActivePane();

      await workspace.open("a");
      await workspace.open("b");
      await workspace.open("file1");
      await workspace.open();

      // does not reopen items with no uri
      expect(workspace.getActivePaneItem().getURI()).toBeUndefined();
      pane.destroyActiveItem();

      await workspace.reopenItem();

      const firstDirectory = lumine.project.getDirectories()[0];
      expect(firstDirectory).toBeDefined();

      expect(workspace.getActivePaneItem().getURI()).not.toBeUndefined();

      // destroy all items
      expect(workspace.getActivePaneItem().getURI()).toBe(firstDirectory.resolve("file1"));
      pane.destroyActiveItem();
      expect(workspace.getActivePaneItem().getURI()).toBe(firstDirectory.resolve("b"));
      pane.destroyActiveItem();
      expect(workspace.getActivePaneItem().getURI()).toBe(firstDirectory.resolve("a"));
      pane.destroyActiveItem();

      // reopens items with uris
      expect(workspace.getActivePaneItem()).toBeUndefined();

      await workspace.reopenItem();

      expect(workspace.getActivePaneItem().getURI()).toBe(firstDirectory.resolve("a"));

      // does not reopen items that are already open
      await workspace.open("b");

      expect(workspace.getActivePaneItem().getURI()).toBe(firstDirectory.resolve("b"));

      await workspace.reopenItem();

      expect(workspace.getActivePaneItem().getURI()).toBe(firstDirectory.resolve("file1"));
    });
  });

  describe("::increase/decreaseFontSize()", () => {
    it("increases/decreases the font size without going below 1", () => {
      lumine.config.set("editor.fontSize", 1);
      workspace.increaseFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(2);
      workspace.increaseFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(3);
      workspace.decreaseFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(2);
      workspace.decreaseFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(1);
      workspace.decreaseFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(1);
    });
  });

  describe("::resetFontSize()", () => {
    it("resets the font size to the window's default font size", () => {
      const defaultFontSize = lumine.config.get("editor.defaultFontSize");

      workspace.increaseFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(defaultFontSize + 1);
      workspace.resetFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(defaultFontSize);
      workspace.decreaseFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(defaultFontSize - 1);
      workspace.resetFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(defaultFontSize);
    });

    it("resets the font size the default font size when it is changed", () => {
      const defaultFontSize = lumine.config.get("editor.defaultFontSize");
      workspace.increaseFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(defaultFontSize + 1);
      lumine.config.set("editor.defaultFontSize", 14);
      workspace.resetFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(14);
    });

    it("does nothing if the font size has not been changed", () => {
      const originalFontSize = lumine.config.get("editor.fontSize");

      workspace.resetFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(originalFontSize);
    });

    it("resets the font size when the editor's font size changes", () => {
      const originalFontSize = lumine.config.get("editor.fontSize");

      lumine.config.set("editor.fontSize", originalFontSize + 1);
      workspace.resetFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(originalFontSize);
      lumine.config.set("editor.fontSize", originalFontSize - 1);
      workspace.resetFontSize();
      expect(lumine.config.get("editor.fontSize")).toBe(originalFontSize);
    });
  });

  describe("::openLicense()", () => {
    it("opens the license as plain-text in a buffer", async () => {
      await workspace.openLicense();
      expect(workspace.getActivePaneItem().getText()).toMatch(/Copyright/);
    });
  });

  describe("::isTextEditor(obj)", () => {
    it("returns true when the passed object is an instance of `TextEditor`", () => {
      expect(workspace.isTextEditor(new TextEditor())).toBe(true);
      expect(workspace.isTextEditor({ getText: () => null })).toBe(false);
      expect(workspace.isTextEditor(null)).toBe(false);
      expect(workspace.isTextEditor(undefined)).toBe(false);
    });
  });

  describe("::getActiveTextEditor()", () => {
    describe("when the workspace center's active pane item is a text editor", () => {
      describe("when the workspace center has focus", () => {
        it("returns the text editor", () => {
          const workspaceCenter = workspace.getCenter();
          const editor = new TextEditor();
          workspaceCenter.getActivePane().activateItem(editor);
          workspaceCenter.activate();

          expect(workspace.getActiveTextEditor()).toBe(editor);
        });
      });

      describe("when a dock has focus", () => {
        it("returns the text editor", () => {
          const workspaceCenter = workspace.getCenter();
          const editor = new TextEditor();
          workspaceCenter.getActivePane().activateItem(editor);
          workspace.getLeftDock().activate();

          expect(workspace.getActiveTextEditor()).toBe(editor);
        });
      });
    });

    describe("when the workspace center's active pane item is not a text editor", () => {
      it("returns undefined", () => {
        const workspaceCenter = workspace.getCenter();
        const nonEditorItem = document.createElement("div");
        workspaceCenter.getActivePane().activateItem(nonEditorItem);

        expect(workspace.getActiveTextEditor()).toBeUndefined();
      });
    });
  });

  describe("::observeTextEditors()", () => {
    it("invokes the observer with current and future text editors", async () => {
      const observed = [];

      await workspace.open();
      await workspace.open();
      await workspace.openLicense();

      workspace.observeTextEditors((editor) => observed.push(editor));

      await workspace.open();

      expect(observed).toEqual(workspace.getTextEditors());
    });
  });

  describe("::observeActiveTextEditor()", () => {
    it("invokes the observer with current active text editor and each time a different text editor becomes active", () => {
      const pane = workspace.getCenter().getActivePane();
      const observed = [];

      const inactiveEditorBeforeRegisteringObserver = new TextEditor();
      const activeEditorBeforeRegisteringObserver = new TextEditor();
      pane.activateItem(inactiveEditorBeforeRegisteringObserver);
      pane.activateItem(activeEditorBeforeRegisteringObserver);

      workspace.observeActiveTextEditor((editor) => observed.push(editor));

      const editorAddedAfterRegisteringObserver = new TextEditor();
      pane.activateItem(editorAddedAfterRegisteringObserver);

      expect(observed).toEqual([
        activeEditorBeforeRegisteringObserver,
        editorAddedAfterRegisteringObserver,
      ]);
    });
  });

  describe("::onDidChangeActiveTextEditor()", () => {
    let center, pane, observed;

    beforeEach(() => {
      center = workspace.getCenter();
      pane = center.getActivePane();
      observed = [];
    });

    it("invokes the observer when a text editor becomes the workspace center's active pane item while a dock has focus", () => {
      workspace.onDidChangeActiveTextEditor((editor) => observed.push(editor));

      const dock = workspace.getLeftDock();
      dock.activate();
      expect(lumine.workspace.getActivePaneContainer()).toBe(dock);

      const editor = new TextEditor();
      center.getActivePane().activateItem(editor);
      expect(lumine.workspace.getActivePaneContainer()).toBe(dock);

      expect(observed).toEqual([editor]);
    });

    it("invokes the observer when the last text editor is closed", () => {
      const editor = new TextEditor();
      pane.activateItem(editor);

      workspace.onDidChangeActiveTextEditor((editor) => observed.push(editor));
      pane.destroyItem(editor);
      expect(observed).toEqual([undefined]);
    });

    it("invokes the observer when the workspace center's active pane item changes from an editor item to a non-editor item", () => {
      const editor = new TextEditor();
      const nonEditorItem = document.createElement("div");
      pane.activateItem(editor);

      workspace.onDidChangeActiveTextEditor((editor) => observed.push(editor));
      pane.activateItem(nonEditorItem);
      expect(observed).toEqual([undefined]);
    });

    it("does not invoke the observer when the workspace center's active pane item changes from a non-editor item to another non-editor item", () => {
      workspace.onDidChangeActiveTextEditor((editor) => observed.push(editor));

      const nonEditorItem1 = document.createElement("div");
      const nonEditorItem2 = document.createElement("div");
      pane.activateItem(nonEditorItem1);
      pane.activateItem(nonEditorItem2);

      expect(observed).toEqual([]);
    });

    it("invokes the observer when closing the one and only text editor after deserialization", async () => {
      pane.activateItem(new TextEditor());

      await simulateReload();

      workspace.onDidChangeActiveTextEditor((editor) => observed.push(editor));
      workspace.closeActivePaneItemOrEmptyPaneOrWindow();
      expect(observed).toEqual([undefined]);
    });
  });

  describe("file and embedded text editor resolution", () => {
    let pane, fileEditor, cellEditorA, cellEditorB, activeEmbedded, changeCallbacks, item;

    beforeEach(() => {
      pane = workspace.getCenter().getActivePane();
      fileEditor = new TextEditor();
      cellEditorA = new TextEditor();
      cellEditorB = new TextEditor();
      activeEmbedded = cellEditorA;
      changeCallbacks = [];
      // The protocol shape a notebook-like item implements: a backing editor
      // holding the file, an embedded editor being edited, one change signal.
      item = {
        getTitle: () => "Fake Notebook",
        getFileTextEditor: () => fileEditor,
        getActiveEmbeddedTextEditor: () => activeEmbedded,
        onDidChangeActiveTextEditors(callback) {
          changeCallbacks.push(callback);
          return {
            dispose: () => {
              changeCallbacks = changeCallbacks.filter((cb) => cb !== callback);
            },
          };
        },
      };
    });

    afterEach(() => {
      fileEditor.destroy();
      cellEditorA.destroy();
      cellEditorB.destroy();
    });

    it("resolves both editors through the active item's protocol methods", () => {
      const files = [];
      const embedded = [];
      workspace.onDidChangeActiveFileTextEditor((editor) => files.push(editor));
      workspace.onDidChangeActiveEmbeddedTextEditor((editor) => embedded.push(editor));

      pane.activateItem(item);

      expect(workspace.getActiveTextEditor()).toBeUndefined();
      expect(workspace.getActiveFileTextEditor()).toBe(fileEditor);
      expect(workspace.getActiveEmbeddedTextEditor()).toBe(cellEditorA);
      expect(files).toEqual([fileEditor]);
      expect(embedded).toEqual([cellEditorA]);
    });

    it("follows the item's change signal and dedupes each resolution", () => {
      pane.activateItem(item);

      const files = [];
      const embedded = [];
      workspace.onDidChangeActiveFileTextEditor((editor) => files.push(editor));
      workspace.onDidChangeActiveEmbeddedTextEditor((editor) => embedded.push(editor));

      activeEmbedded = cellEditorB;
      changeCallbacks.forEach((callback) => callback());

      // The file editor did not change, so only the embedded event fired.
      expect(files).toEqual([]);
      expect(embedded).toEqual([cellEditorB]);

      changeCallbacks.forEach((callback) => callback());
      expect(embedded).toEqual([cellEditorB]);
    });

    it("resolves a plain text editor to itself on both axes", () => {
      const editor = new TextEditor();
      const files = [];
      const embedded = [];
      workspace.onDidChangeActiveFileTextEditor((e) => files.push(e));
      workspace.onDidChangeActiveEmbeddedTextEditor((e) => embedded.push(e));

      pane.activateItem(editor);

      expect(workspace.getActiveFileTextEditor()).toBe(editor);
      expect(workspace.getActiveEmbeddedTextEditor()).toBe(editor);
      expect(files).toEqual([editor]);
      expect(embedded).toEqual([editor]);

      editor.destroy();
    });

    it("resolves to undefined for an item without the protocol and unsubscribes the previous item", () => {
      pane.activateItem(item);
      expect(changeCallbacks.length).toBe(1);

      const files = [];
      const embedded = [];
      workspace.onDidChangeActiveFileTextEditor((e) => files.push(e));
      workspace.onDidChangeActiveEmbeddedTextEditor((e) => embedded.push(e));

      pane.activateItem(document.createElement("div"));

      expect(workspace.getActiveFileTextEditor()).toBeUndefined();
      expect(workspace.getActiveEmbeddedTextEditor()).toBeUndefined();
      expect(files).toEqual([undefined]);
      expect(embedded).toEqual([undefined]);
      // The old item's signal is let go when it stops being active.
      expect(changeCallbacks.length).toBe(0);
    });
  });

  describe("when an editor is destroyed", () => {
    it("removes the editor", async () => {
      const editor = await workspace.open("a");
      expect(workspace.getTextEditors()).toHaveLength(1);
      editor.destroy();
      expect(workspace.getTextEditors()).toHaveLength(0);
    });
  });

  describe("when an editor is copied because its pane is split", () => {
    it("sets up the new editor to be configured by the text editor registry", async () => {
      await lumine.packages.activatePackage("language-javascript");

      const editor = await workspace.open("a");

      lumine.grammars.assignLanguageMode(editor, "source.js");
      expect(editor.getGrammar().name).toBe("JavaScript");

      workspace.getActivePane().splitRight({ copyActiveItem: true });
      const newEditor = workspace.getActiveTextEditor();
      expect(newEditor).not.toBe(editor);
      expect(newEditor.getGrammar().name).toBe("JavaScript");
    });
  });

  it("stores the active grammars used by all the open editors", async () => {
    await Promise.all([
      lumine.packages.activatePackage("language-javascript"),
      lumine.packages.activatePackage("language-python"),
      lumine.packages.activatePackage("language-todo"),
    ]);

    await lumine.workspace.open("sample.py");

    lumine.workspace.getActiveTextEditor().setText(dedent`
      i = /test/; #FIXME\
    `);

    const lumine2 = new LumineEnvironment({
      applicationDelegate: lumine.applicationDelegate,
    });
    lumine2.initialize({
      window: document.createElement("div"),
      document: Object.assign(document.createElement("div"), {
        body: document.createElement("div"),
        head: document.createElement("div"),
      }),
    });

    lumine2.packages.loadPackage("language-javascript");
    lumine2.packages.loadPackage("language-python");
    lumine2.packages.loadPackage("language-todo");
    await lumine2.project.deserialize(lumine.project.serialize());
    lumine2.workspace.deserialize(lumine.workspace.serialize(), lumine2.deserializers);

    let grammars = lumine2.grammars.getGrammars({ includeTreeSitter: true });

    let grammarScopes = grammars.map((grammar) => grammar.scopeName).sort();

    // The grammars a restored environment registers are the ones its
    // deserialized editors actually resolve, not everything its loaded packages
    // could provide: language-javascript is loaded above and contributes
    // nothing here because no open editor references source.js.
    expect(grammarScopes).toEqual([
      "source.python", // Tree-sitter grammars also load
      "source.python",
      "source.python.ipy",
      "source.python.ipy",
      "source.regexp.python",
      "text.plain.null-grammar",
      "text.python.console",
      "text.python.traceback",
      "text.todo",
      "text.todo",
    ]);

    lumine2.destroy();
  });

  describe("document.title", () => {
    it("is not changed by workspace activity", async () => {
      document.title = "Lumine";

      await lumine.workspace.open("b");
      lumine.project.setPaths([]);
      lumine.workspace.getActiveTextEditor().buffer.setPath(path.join(temp.dir, "renamed"));

      expect(document.title).toBe("Lumine");
    });
  });

  describe("document edited status", () => {
    let item1;
    let item2;

    beforeEach(async () => {
      await lumine.workspace.open("a");
      await lumine.workspace.open("b");

      [item1, item2] = lumine.workspace.getPaneItems();
    });

    it("calls setDocumentEdited when the active item changes", () => {
      expect(lumine.workspace.getActivePaneItem()).toBe(item2);
      item1.insertText("a");
      expect(item1.isModified()).toBe(true);
      lumine.workspace.getActivePane().activateNextItem();

      expect(setDocumentEdited).toHaveBeenCalledWith(true);
    });

    it("calls lumine.setDocumentEdited when the active item's modified status changes", async () => {
      expect(lumine.workspace.getActivePaneItem()).toBe(item2);
      item2.insertText("a");
      await timeoutPromise(item2.getBuffer().getStoppedChangingDelay());

      expect(item2.isModified()).toBe(true);
      expect(setDocumentEdited).toHaveBeenCalledWith(true);

      item2.undo();
      await timeoutPromise(item2.getBuffer().getStoppedChangingDelay());

      expect(item2.isModified()).toBe(false);
      expect(setDocumentEdited).toHaveBeenCalledWith(false);
    });
  });

  describe("adding panels", () => {
    class TestItem {}

    // Don't use ES6 classes because then we'll have to call `super()` which we
    // can't do with HTMLElement
    function TestItemElement() {
      this.constructor = TestItemElement;
    }
    function Ctor() {
      this.constructor = TestItemElement;
    }
    Ctor.prototype = HTMLElement.prototype;
    TestItemElement.prototype = new Ctor();
    TestItemElement.__super__ = HTMLElement.prototype;
    TestItemElement.prototype.initialize = function (model) {
      this.model = model;
      return this;
    };
    TestItemElement.prototype.getModel = function () {
      return this.model;
    };

    beforeEach(() =>
      lumine.views.addViewProvider(TestItem, (model) => new TestItemElement().initialize(model)),
    );

    describe("::addLeftPanel(model)", () => {
      it("adds a panel to the correct panel container", () => {
        let addPanelSpy;
        expect(lumine.workspace.getLeftPanels().length).toBe(0);
        lumine.workspace.panelContainers.left.onDidAddPanel((addPanelSpy = jasmine.createSpy()));

        const model = new TestItem();
        const panel = lumine.workspace.addLeftPanel({ item: model });

        expect(panel).toBeDefined();
        expect(addPanelSpy).toHaveBeenCalledWith({ panel, index: 0 });

        const itemView = lumine.views.getView(lumine.workspace.getLeftPanels()[0].getItem());
        expect(itemView instanceof TestItemElement).toBe(true);
        expect(itemView.getModel()).toBe(model);
      });
    });

    describe("::addRightPanel(model)", () => {
      it("adds a panel to the correct panel container", () => {
        let addPanelSpy;
        expect(lumine.workspace.getRightPanels().length).toBe(0);
        lumine.workspace.panelContainers.right.onDidAddPanel((addPanelSpy = jasmine.createSpy()));

        const model = new TestItem();
        const panel = lumine.workspace.addRightPanel({ item: model });

        expect(panel).toBeDefined();
        expect(addPanelSpy).toHaveBeenCalledWith({ panel, index: 0 });

        const itemView = lumine.views.getView(lumine.workspace.getRightPanels()[0].getItem());
        expect(itemView instanceof TestItemElement).toBe(true);
        expect(itemView.getModel()).toBe(model);
      });
    });

    describe("::addTopPanel(model)", () => {
      it("adds a panel to the correct panel container", () => {
        let addPanelSpy;
        expect(lumine.workspace.getTopPanels().length).toBe(0);
        lumine.workspace.panelContainers.top.onDidAddPanel((addPanelSpy = jasmine.createSpy()));

        const model = new TestItem();
        const panel = lumine.workspace.addTopPanel({ item: model });

        expect(panel).toBeDefined();
        expect(addPanelSpy).toHaveBeenCalledWith({ panel, index: 0 });

        const itemView = lumine.views.getView(lumine.workspace.getTopPanels()[0].getItem());
        expect(itemView instanceof TestItemElement).toBe(true);
        expect(itemView.getModel()).toBe(model);
      });
    });

    describe("::addBottomPanel(model)", () => {
      it("adds a panel to the correct panel container", () => {
        let addPanelSpy;
        expect(lumine.workspace.getBottomPanels().length).toBe(0);
        lumine.workspace.panelContainers.bottom.onDidAddPanel((addPanelSpy = jasmine.createSpy()));

        const model = new TestItem();
        const panel = lumine.workspace.addBottomPanel({ item: model });

        expect(panel).toBeDefined();
        expect(addPanelSpy).toHaveBeenCalledWith({ panel, index: 0 });

        const itemView = lumine.views.getView(lumine.workspace.getBottomPanels()[0].getItem());
        expect(itemView instanceof TestItemElement).toBe(true);
        expect(itemView.getModel()).toBe(model);
      });
    });

    describe("::addHeaderPanel(model)", () => {
      it("adds a panel to the correct panel container", () => {
        let addPanelSpy;
        expect(lumine.workspace.getHeaderPanels().length).toBe(0);
        lumine.workspace.panelContainers.header.onDidAddPanel((addPanelSpy = jasmine.createSpy()));

        const model = new TestItem();
        const panel = lumine.workspace.addHeaderPanel({ item: model });

        expect(panel).toBeDefined();
        expect(addPanelSpy).toHaveBeenCalledWith({ panel, index: 0 });

        const itemView = lumine.views.getView(lumine.workspace.getHeaderPanels()[0].getItem());
        expect(itemView instanceof TestItemElement).toBe(true);
        expect(itemView.getModel()).toBe(model);
      });
    });

    describe("::addFooterPanel(model)", () => {
      it("adds a panel to the correct panel container", () => {
        let addPanelSpy;
        expect(lumine.workspace.getFooterPanels().length).toBe(0);
        lumine.workspace.panelContainers.footer.onDidAddPanel((addPanelSpy = jasmine.createSpy()));

        const model = new TestItem();
        const panel = lumine.workspace.addFooterPanel({ item: model });

        expect(panel).toBeDefined();
        expect(addPanelSpy).toHaveBeenCalledWith({ panel, index: 0 });

        const itemView = lumine.views.getView(lumine.workspace.getFooterPanels()[0].getItem());
        expect(itemView instanceof TestItemElement).toBe(true);
        expect(itemView.getModel()).toBe(model);
      });
    });

    describe("::addModalPanel(model)", () => {
      it("adds a panel to the correct panel container", () => {
        let addPanelSpy;
        expect(lumine.workspace.getModalPanels().length).toBe(0);
        lumine.workspace.panelContainers.modal.onDidAddPanel((addPanelSpy = jasmine.createSpy()));

        const model = new TestItem();
        const panel = lumine.workspace.addModalPanel({ item: model });

        expect(panel).toBeDefined();
        expect(addPanelSpy).toHaveBeenCalledWith({ panel, index: 0 });

        const itemView = lumine.views.getView(lumine.workspace.getModalPanels()[0].getItem());
        expect(itemView instanceof TestItemElement).toBe(true);
        expect(itemView.getModel()).toBe(model);
      });
    });

    describe("::panelForItem(item)", () => {
      it("returns the panel associated with the item", () => {
        const item = new TestItem();
        const panel = lumine.workspace.addLeftPanel({ item });

        const itemWithNoPanel = new TestItem();

        expect(lumine.workspace.panelForItem(item)).toBe(panel);
        expect(lumine.workspace.panelForItem(itemWithNoPanel)).toBe(null);
      });
    });
  });

  describe("::buildSelectList(props)", () => {
    let lists;

    beforeEach(() => {
      lists = [];
    });

    afterEach(() => {
      for (const list of lists) list.destroy();
    });

    function build(props = {}) {
      const list = lumine.workspace.buildSelectList({
        items: ["alpha", "beta"],
        elementForItem: (item) => {
          const li = document.createElement("li");
          li.textContent = item;
          return li;
        },
        ...props,
      });
      lists.push(list);
      return list;
    }

    it("returns a usable list that renders its items", () => {
      const list = build();

      expect(list.element.classList.contains("select-list")).toBe(true);
      expect(Array.from(list.element.querySelectorAll("li"), (li) => li.textContent)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(list.getSelectedItem()).toBe("alpha");
    });

    it("gives every caller its own list and its own modal panel", () => {
      const first = build();
      const second = build();

      expect(first).not.toBe(second);
      expect(first.getPanel()).not.toBe(second.getPanel());
      expect(lumine.workspace.getModalPanels()).toContain(first.getPanel());
      expect(lumine.workspace.getModalPanels()).toContain(second.getPanel());
    });

    it("owns the panel across show and hide", () => {
      const list = build();

      expect(list.isVisible()).toBe(false);
      list.show();
      expect(list.isVisible()).toBe(true);
      list.hide();
      expect(list.isVisible()).toBe(false);
    });

    it("hands elementForItem a highlight function bound to the item", async () => {
      const list = build({
        elementForItem: (item, { highlight }) => {
          const li = document.createElement("li");
          li.appendChild(highlight(item));
          return li;
        },
      });

      list.refs.queryEditor.setText("al");
      await list.constructor.getScheduler().getNextUpdatePromise();

      const matches = list.element.querySelectorAll(".character-match");
      expect(Array.from(matches, (m) => m.textContent)).toEqual(["al"]);
    });

    it("builds a two-line row when elementForItem returns a descriptor", () => {
      const list = build({
        elementForItem: (item) => ({ primary: item, secondary: "detail" }),
      });

      const li = list.element.querySelector("li");
      expect(li.classList.contains("two-lines")).toBe(true);
      expect(li.querySelector(".primary-line").textContent).toBe("alpha");
      expect(li.querySelector(".secondary-line").textContent).toBe("detail");
    });

    it("chains lists into the modal breadcrumb trail via show({crumb})", () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      let cancelled = false;
      const root = build({ crumb: "Root", didCancelSelection: () => (cancelled = true) });
      const step = build();

      root.show();
      step.show({ crumb: "Step" });

      expect(cancelled).toBe(false);
      expect(root.isVisible()).toBe(false);
      expect(step.isVisible()).toBe(true);
      expect(lumine.workspace.getModalTrail()).toEqual(["Root", "Step"]);

      expect(lumine.workspace.popModal()).toBe(true);
      expect(root.isVisible()).toBe(true);
      expect(lumine.workspace.getModalTrail()).toEqual(["Root"]);
    });
  });

  describe("::buildInputDialog(props)", () => {
    let dialogs;

    beforeEach(() => {
      dialogs = [];
    });

    afterEach(() => {
      for (const dialog of dialogs) dialog.destroy();
    });

    function build(props = {}) {
      const dialog = lumine.workspace.buildInputDialog(props);
      dialogs.push(dialog);
      return dialog;
    }

    it("returns a dialog with a query editor and no list", () => {
      const dialog = build({ placeholderText: "Name" });

      expect(dialog.element.classList.contains("input-dialog")).toBe(true);
      expect(dialog.element.classList.contains("select-list")).toBe(false);
      expect(dialog.element.querySelector("ol.list-group")).toBeNull();
      expect(dialog.getQuery()).toBe("");
    });

    it("reports the typed query to didConfirm", () => {
      let confirmed = null;
      const dialog = build({ didConfirm: (query) => (confirmed = query) });

      dialog.refs.queryEditor.setText("a-name");
      dialog.confirm();

      expect(confirmed).toBe("a-name");
    });

    it("gives every caller its own dialog and its own modal panel", () => {
      const first = build();
      const second = build();

      expect(first).not.toBe(second);
      expect(first.getPanel()).not.toBe(second.getPanel());
    });
  });

  // ripgrep is the only built-in searcher; the loop is retained so the
  // ripgrep-specific branch below stays scoped to `ripgrep === true`.
  for (const ripgrep of [true]) {
    describe(`::scan(regex, options, callback)`, () => {
      function scan(regex, options, iterator) {
        return lumine.workspace.scan(regex, { ...options, ripgrep }, iterator);
      }

      describe("when called with a regex", () => {
        it("calls the callback with all regex results in all files in the project", async () => {
          const results = [];
          await scan(
            /(a)+/,
            { leadingContextLineCount: 1, trailingContextLineCount: 1 },
            (result) => results.push(result),
          );

          results.sort((a, b) => a.filePath.localeCompare(b.filePath));

          expect(results.length).toBeGreaterThan(0);
          expect(results[0].filePath).toBe(lumine.project.getDirectories()[0].resolve("a"));
          expect(results[0].matches).toHaveLength(3);
          expect(results[0].matches[0]).toEqual({
            matchText: "aaa",
            lineText: "aaa bbb",
            lineTextOffset: 0,
            range: [
              [0, 0],
              [0, 3],
            ],
            leadingContextLines: [],
            trailingContextLines: ["cc aa cc"],
          });
        });

        it("works with with escaped literals (like $ and ^)", async () => {
          const results = [];
          await scan(
            /\$\w+/,
            { leadingContextLineCount: 1, trailingContextLineCount: 1 },
            (result) => results.push(result),
          );

          expect(results.length).toBe(1);
          const { filePath, matches } = results[0];
          expect(filePath).toBe(lumine.project.getDirectories()[0].resolve("a"));
          expect(matches).toHaveLength(1);
          expect(matches[0]).toEqual({
            matchText: "$bill",
            lineText: "dollar$bill",
            lineTextOffset: 0,
            range: [
              [2, 6],
              [2, 11],
            ],
            leadingContextLines: ["cc aa cc"],
            trailingContextLines: [],
          });
        });

        it("works on evil filenames", async () => {
          lumine.config.set("core.excludeVcsIgnoredPaths", false);
          platform.generateEvilFiles();
          lumine.project.setPaths([path.join(__dirname, "fixtures", "evil-files")]);
          const paths = [];
          let matches = [];

          await scan(/evil/, {}, (result) => {
            paths.push(result.filePath);
            matches = matches.concat(result.matches);
          });

          // Sort the paths to make the test deterministic.
          paths.sort();

          _.each(matches, (m) => expect(m.matchText).toEqual("evil"));

          if (platform.isWindows()) {
            expect(paths.length).toBe(3);
            expect(paths[0]).toMatch(/a_file_with_utf8.txt$/);
            expect(paths[1]).toMatch(/file with spaces.txt$/);
            expect(path.basename(paths[2])).toBe("utfa\u0306.md");
          } else {
            expect(paths.length).toBe(5);
            expect(paths[0]).toMatch(/a_file_with_utf8.txt$/);
            expect(paths[1]).toMatch(/file with spaces.txt$/);
            expect(paths[2]).toMatch(/goddam\nnewlines$/m);
            expect(paths[3]).toMatch(/quote".txt$/m);
            expect(path.basename(paths[4])).toBe("utfa\u0306.md");
          }
        });

        it("ignores case if the regex includes the `i` flag", async () => {
          const results = [];
          await scan(/DOLLAR/i, {}, (result) => results.push(result));

          expect(results).toHaveLength(1);
        });

        it("decodes multibyte matches split across ripgrep output chunks", async () => {
          // A single line far larger than the OS pipe buffer forces ripgrep's JSON
          // output to arrive in multiple stdout chunks; a 3-byte character guarantees a
          // ~64 KB read boundary lands mid-character, which a naive Buffer->string
          // concatenation would decode into U+FFFD.
          const euro = "€"; // 3 bytes in UTF-8
          const line = euro.repeat(100000);
          const dir = temp.mkdirSync("ripgrep-utf8-");
          fs.writeFileSync(path.join(dir, "big-utf8.txt"), line + "\n");
          lumine.project.setPaths([dir]);

          const results = [];
          await scan(new RegExp(euro + "+"), {}, (result) => results.push(result));

          expect(results.length).toBe(1);
          const { matches } = results[0];
          expect(matches).toHaveLength(1);
          expect(matches[0].matchText).not.toContain("�");
          expect(matches[0].lineText).not.toContain("�");
          expect(matches[0].matchText.length).toBe(line.length);
          expect(matches[0].lineText.length).toBe(line.length);
        });

        it("matches end-anchored regexes on CRLF files without leaking `\\r`", async () => {
          const dir = temp.mkdirSync("ripgrep-crlf-");
          fs.writeFileSync(path.join(dir, "crlf.txt"), "alpha\r\naaa bbb\r\ngamma\r\n");
          lumine.project.setPaths([dir]);

          const results = [];
          // `$` only matches the CRLF line boundary when ripgrep runs with `--crlf`.
          await scan(
            /bbb$/,
            { leadingContextLineCount: 1, trailingContextLineCount: 1 },
            (result) => results.push(result),
          );

          expect(results.length).toBe(1);
          const { matches } = results[0];
          expect(matches).toHaveLength(1);
          expect(matches[0].matchText).toBe("bbb");
          expect(matches[0].lineText).toBe("aaa bbb");
          expect(matches[0].leadingContextLines).toEqual(["alpha"]);
          expect(matches[0].trailingContextLines).toEqual(["gamma"]);
          for (const line of [
            matches[0].lineText,
            ...matches[0].leadingContextLines,
            ...matches[0].trailingContextLines,
          ]) {
            expect(line).not.toContain("\r");
          }
        });

        it("strips `\\r` from internal rows of multiline CRLF matches", async () => {
          const dir = temp.mkdirSync("ripgrep-crlf-multiline-");
          fs.writeFileSync(path.join(dir, "crlf-multi.txt"), "one\r\ntwo\r\nthree\r\n");
          lumine.project.setPaths([dir]);

          const results = [];
          await scan(/one\r?\ntwo/, {}, (result) => results.push(result));

          expect(results.length).toBe(1);
          const { matches } = results[0];
          expect(matches).toHaveLength(1);
          expect(matches[0].lineText).toBe("one\ntwo");
          expect(matches[0].lineText).not.toContain("\r");
        });

        if (ripgrep) {
          it("returns empty text matches", async () => {
            const results = [];
            await scan(
              /^\s{0}/,
              {
                paths: [`oh-git`],
              },
              (result) => results.push(result),
            );

            expect(results.length).toBe(1);
            const { filePath, matches } = results[0];
            expect(filePath).toBe(
              lumine.project.getDirectories()[0].resolve(path.join("a-dir", "oh-git")),
            );
            expect(matches).toHaveLength(1);
            expect(matches[0]).toEqual({
              matchText: "",
              lineText: "bbb aaaa",
              lineTextOffset: 0,
              range: [
                [0, 0],
                [0, 0],
              ],
              leadingContextLines: [],
              trailingContextLines: [],
            });
          });

          describe("newlines on regexps", () => {
            it("returns multiline results from regexps", async () => {
              const results = [];

              await scan(/first\nsecond/, {}, (result) => results.push(result));

              expect(results.length).toBe(1);
              const { filePath, matches } = results[0];
              expect(filePath).toBe(
                lumine.project.getDirectories()[0].resolve("file-with-newline-literal"),
              );
              expect(matches).toHaveLength(1);
              expect(matches[0]).toEqual({
                matchText: "first\nsecond",
                lineText: "first\nsecond\\nthird",
                lineTextOffset: 0,
                range: [
                  [3, 0],
                  [4, 6],
                ],
                leadingContextLines: [],
                trailingContextLines: [],
              });
            });

            it("returns correctly the context lines", async () => {
              const results = [];

              await scan(
                /first\nsecond/,
                {
                  leadingContextLineCount: 2,
                  trailingContextLineCount: 2,
                },
                (result) => results.push(result),
              );

              expect(results.length).toBe(1);
              const { filePath, matches } = results[0];
              expect(filePath).toBe(
                lumine.project.getDirectories()[0].resolve("file-with-newline-literal"),
              );
              expect(matches).toHaveLength(1);
              expect(matches[0]).toEqual({
                matchText: "first\nsecond",
                lineText: "first\nsecond\\nthird",
                lineTextOffset: 0,
                range: [
                  [3, 0],
                  [4, 6],
                ],
                leadingContextLines: ["newline2", "newline3"],
                trailingContextLines: ["newline4", "newline5"],
              });
            });

            it("returns multiple results from the same line", async () => {
              const results = [];

              await scan(/line\d\nne/, {}, (result) => results.push(result));

              results.sort((a, b) => a.filePath.localeCompare(b.filePath));

              expect(results.length).toBe(1);

              const { filePath, matches } = results[0];
              expect(filePath).toBe(
                lumine.project.getDirectories()[0].resolve("file-with-newline-literal"),
              );
              expect(matches).toHaveLength(3);
              expect(matches[0]).toEqual({
                matchText: "line1\nne",
                lineText: "newline1\nnewline2",
                lineTextOffset: 0,
                range: [
                  [0, 3],
                  [1, 2],
                ],
                leadingContextLines: [],
                trailingContextLines: [],
              });
              expect(matches[1]).toEqual({
                matchText: "line2\nne",
                lineText: "newline2\nnewline3",
                lineTextOffset: 0,
                range: [
                  [1, 3],
                  [2, 2],
                ],
                leadingContextLines: [],
                trailingContextLines: [],
              });
              expect(matches[2]).toEqual({
                matchText: "line4\nne",
                lineText: "newline4\nnewline5",
                lineTextOffset: 0,
                range: [
                  [5, 3],
                  [6, 2],
                ],
                leadingContextLines: [],
                trailingContextLines: [],
              });
            });

            it("works with escaped newlines", async () => {
              const results = [];

              await scan(/second\\nthird/, {}, (result) => results.push(result));
              expect(results.length).toBe(1);
              const { filePath, matches } = results[0];
              expect(filePath).toBe(
                lumine.project.getDirectories()[0].resolve("file-with-newline-literal"),
              );
              expect(matches).toHaveLength(1);
              expect(matches[0]).toEqual({
                matchText: "second\\nthird",
                lineText: "second\\nthird",
                lineTextOffset: 0,
                range: [
                  [4, 0],
                  [4, 13],
                ],
                leadingContextLines: [],
                trailingContextLines: [],
              });
            });

            it("matches a regexp ending with a newline", async () => {
              const results = [];

              await scan(/newline3\n/, {}, (result) => results.push(result));
              expect(results.length).toBe(1);
              const { filePath, matches } = results[0];
              expect(filePath).toBe(
                lumine.project.getDirectories()[0].resolve("file-with-newline-literal"),
              );
              expect(matches).toHaveLength(1);
              expect(matches[0]).toEqual({
                matchText: "newline3\n",
                lineText: "newline3",
                lineTextOffset: 0,
                range: [
                  [2, 0],
                  [3, 0],
                ],
                leadingContextLines: [],
                trailingContextLines: [],
              });
            });
          });
          describe("pcre2 enabled", () => {
            it("supports lookbehind searches", async () => {
              const results = [];

              await scan(/(?<!a)aa\b/, { PCRE2: true }, (result) => results.push(result));

              expect(results.length).toBe(1);
              const { filePath, matches } = results[0];
              expect(filePath).toBe(lumine.project.getDirectories()[0].resolve("a"));
              expect(matches).toHaveLength(1);
              expect(matches[0]).toEqual({
                matchText: "aa",
                lineText: "cc aa cc",
                lineTextOffset: 0,
                range: [
                  [1, 3],
                  [1, 5],
                ],
                leadingContextLines: [],
                trailingContextLines: [],
              });
            });
          });
        }

        it("returns results on lines with unicode strings", async () => {
          const results = [];

          await scan(/line with unico/, {}, (result) => results.push(result));
          expect(results.length).toBe(1);
          const { filePath, matches } = results[0];
          expect(filePath).toBe(lumine.project.getDirectories()[0].resolve("file-with-unicode"));
          expect(matches).toHaveLength(1);
          expect(matches[0]).toEqual({
            matchText: "line with unico",
            lineText: "ДДДДДДДДДДДДДДДДДД line with unicode",
            lineTextOffset: 0,
            range: [
              [0, 19],
              [0, 34],
            ],
            leadingContextLines: [],
            trailingContextLines: [],
          });
        });

        it("returns results on files detected as binary", async () => {
          const results = [];

          await scan(
            /asciiProperty=Foo/,
            {
              trailingContextLineCount: 2,
            },
            (result) => results.push(result),
          );
          expect(results.length).toBe(1);
          const { filePath, matches } = results[0];
          expect(filePath).toBe(
            lumine.project.getDirectories()[0].resolve("file-detected-as-binary"),
          );
          expect(matches).toHaveLength(1);
          expect(matches[0]).toEqual({
            matchText: "asciiProperty=Foo",
            lineText: "asciiProperty=Foo",
            lineTextOffset: 0,
            range: [
              [0, 0],
              [0, 17],
            ],
            leadingContextLines: [],
            trailingContextLines: ["utf8Property=Fòò", "latin1Property=F��"],
          });
        });

        describe("when the core.excludeVcsIgnoredPaths config is used", () => {
          let projectPath;
          let ignoredPath;

          beforeEach(async () => {
            const sourceProjectPath = path.join(__dirname, "fixtures", "git", "working-dir");
            projectPath = path.join(temp.mkdirSync("lumine"));

            fs.cpSync(sourceProjectPath, projectPath, { recursive: true });

            fs.renameSync(path.join(projectPath, "git.git"), path.join(projectPath, ".git"));
            ignoredPath = path.join(projectPath, "ignored.txt");
            fs.writeFileSync(ignoredPath, "this match should not be included");
          });

          afterEach(() => {
            if (fs.existsSync(projectPath)) {
              fs.removeSync(projectPath);
            }
          });

          it("excludes ignored files when core.excludeVcsIgnoredPaths is true", async () => {
            lumine.project.setPaths([projectPath]);
            lumine.config.set("core.excludeVcsIgnoredPaths", true);
            const editor = await lumine.workspace.open(ignoredPath);
            editor.setText("modified match remains ignored");
            const resultHandler = jasmine.createSpy("result found");

            await scan(/match/, {}, ({ filePath }) => resultHandler(filePath));

            expect(editor.isModified()).toBe(true);
            expect(resultHandler).not.toHaveBeenCalled();
          });

          it("does not exclude ignored files when core.excludeVcsIgnoredPaths is false", async () => {
            lumine.project.setPaths([projectPath]);
            lumine.config.set("core.excludeVcsIgnoredPaths", false);
            const editor = await lumine.workspace.open(ignoredPath);
            editor.setText("modified buffer without the search term");
            const resultHandler = jasmine.createSpy("result found");

            await scan(/match/, {}, ({ filePath }) => resultHandler(filePath));

            expect(editor.isModified()).toBe(true);
            expect(resultHandler).toHaveBeenCalledWith(path.join(projectPath, "ignored.txt"));
          });

          it("includes ignored files when includeVcsIgnoredPaths is true", async () => {
            lumine.project.setPaths([projectPath]);
            lumine.config.set("core.excludeVcsIgnoredPaths", true);
            const editor = await lumine.workspace.open(ignoredPath);
            editor.setText("modified buffer without the search term");
            const resultHandler = jasmine.createSpy("result found");

            await scan(/match/, { includeVcsIgnoredPaths: true }, ({ filePath }) =>
              resultHandler(filePath),
            );

            expect(editor.isModified()).toBe(true);
            expect(resultHandler).toHaveBeenCalledWith(path.join(projectPath, "ignored.txt"));
          });

          it("does not exclude files when searching on an ignored folder even when core.excludeVcsIgnoredPaths is true", async () => {
            fs.mkdirSync(path.join(projectPath, "poop"));
            ignoredPath = path.join(path.join(projectPath, "poop", "whatever.txt"));
            fs.writeFileSync(ignoredPath, "this match should be included");

            lumine.project.setPaths([projectPath]);
            lumine.config.set("core.excludeVcsIgnoredPaths", true);
            const resultHandler = jasmine.createSpy("result found");

            await scan(/match/, { paths: ["poop"] }, ({ filePath }) => resultHandler(filePath));

            expect(resultHandler).toHaveBeenCalledWith(ignoredPath);
          });
        });

        describe("when the core.followSymlinks config is used", () => {
          let projectPath;

          beforeEach(async () => {
            const sourceProjectPath = path.join(__dirname, "fixtures", "dir", "a-dir");
            projectPath = path.join(temp.mkdirSync("lumine"));

            fs.cpSync(sourceProjectPath, projectPath, { recursive: true });

            fs.symlinkSync(
              path.join(__dirname, "fixtures", "dir", "b"),
              path.join(projectPath, "symlink"),
            );
          });

          afterEach(() => {
            if (fs.existsSync(projectPath)) {
              fs.removeSync(projectPath);
            }
          });

          it("follows symlinks when core.followSymlinks is true", async () => {
            lumine.project.setPaths([projectPath]);
            lumine.config.set("core.followSymlinks", true);
            const resultHandler = jasmine.createSpy("result found");

            await scan(/ccc/, {}, ({ filePath }) => resultHandler(filePath));

            expect(resultHandler).toHaveBeenCalledWith(path.join(projectPath, "symlink"));
          });

          it("does not follow symlinks when core.followSymlinks is false", async () => {
            lumine.project.setPaths([projectPath]);
            lumine.config.set("core.followSymlinks", false);
            const resultHandler = jasmine.createSpy("result found");

            await scan(/ccc/, {}, ({ filePath }) => resultHandler(filePath));

            expect(resultHandler).not.toHaveBeenCalled();
          });
        });

        describe("when there are hidden files", () => {
          let projectPath;

          beforeEach(async () => {
            const sourceProjectPath = path.join(__dirname, "fixtures", "dir", "a-dir");
            projectPath = path.join(temp.mkdirSync("lumine"));

            fs.cpSync(sourceProjectPath, projectPath, { recursive: true });

            // Note: This won't create a hidden file on Windows, in order to more
            // accurately test this behaviour there, we should either use a package
            // like `fswin` or manually spawn an `ATTRIB` command.
            fs.writeFileSync(path.join(projectPath, ".hidden"), "ccc");
          });

          afterEach(() => {
            if (fs.existsSync(projectPath)) {
              fs.removeSync(projectPath);
            }
          });

          it("searches on hidden files", async () => {
            lumine.project.setPaths([projectPath]);
            const resultHandler = jasmine.createSpy("result found");

            await scan(/ccc/, {}, ({ filePath }) => resultHandler(filePath));

            expect(resultHandler).toHaveBeenCalledWith(path.join(projectPath, ".hidden"));
          });
        });

        it("includes only files when a directory filter is specified", async () => {
          const projectPath = path.join(path.join(__dirname, "fixtures", "dir"));
          lumine.project.setPaths([projectPath]);

          const filePath = path.join(projectPath, "a-dir", "oh-git");

          const paths = [];
          let matches = [];

          await scan(/aaa/, { paths: [`a-dir${path.sep}`] }, (result) => {
            paths.push(result.filePath);
            matches = matches.concat(result.matches);
          });

          expect(paths.length).toBe(1);
          expect(paths[0]).toBe(filePath);
          expect(matches.length).toBe(1);
        });

        it("applies path globs only to files on disk when matching buffers are modified", async () => {
          const projectPath = path.join(__dirname, "fixtures", "workspace-scan");
          lumine.project.setPaths([projectPath]);

          const aSample1Editor = await lumine.workspace.open(
            path.join(projectPath, "a-dir", "sample1.js"),
          );
          aSample1Editor.setText(`${aSample1Editor.getText()} smapdi`);
          const bSample1Editor = await lumine.workspace.open(
            path.join(projectPath, "b-dir", "sample1.js"),
          );
          bSample1Editor.setText(`${bSample1Editor.getText()} smapdi`);

          const positiveGlobs = ["b-dir", "b-dir/*.js", "b-dir/**/*.js"];
          const negativeGlobs = ["!b-dir", "!b-dir/*.js", "!b-dir/**/*.js"];

          for (let glob of positiveGlobs) {
            const paths = [];
            await scan(/\bsmapdi\b/, { paths: [glob] }, (result) => {
              paths.push(lumine.project.relativize(result.filePath).replace(/\\/g, "/"));
            });

            expect(paths).toEqual(["b-dir/sample2.js"], glob);
          }

          for (let glob of negativeGlobs) {
            const paths = [];
            await scan(/\bsmapdi\b/, { paths: [glob] }, (result) => {
              paths.push(lumine.project.relativize(result.filePath).replace(/\\/g, "/"));
            });

            expect(paths).toEqual([], glob);
          }
        });

        it("includes files and folders that begin with a '.'", async () => {
          const projectPath = temp.mkdirSync("lumine-spec-workspace");
          const filePath = path.join(projectPath, ".text");
          fs.writeFileSync(filePath, "match this");
          lumine.project.setPaths([projectPath]);
          const paths = [];
          let matches = [];

          await scan(/match this/, {}, (result) => {
            paths.push(result.filePath);
            matches = matches.concat(result.matches);
          });

          expect(paths.length).toBe(1);
          expect(paths[0]).toBe(filePath);
          expect(matches.length).toBe(1);
        });

        it("excludes values in core.ignoredNames", async () => {
          const ignoredNames = lumine.config.get("core.ignoredNames");
          ignoredNames.push("a");
          lumine.config.set("core.ignoredNames", ignoredNames);
          const editor = await lumine.workspace.open("a");
          editor.setText("dollar in a modified ignored buffer");

          const resultHandler = jasmine.createSpy("result found");
          await scan(/dollar/, {}, () => resultHandler());

          expect(editor.isModified()).toBe(true);
          expect(resultHandler).not.toHaveBeenCalled();
        });

        it("searches the file on disk instead of its modified buffer", async () => {
          const results = [];
          const editor = await lumine.workspace.open("a");

          editor.setText("Elephant");

          await scan(/dollar|Elephant/, {}, (result) => results.push(result));

          const resultForA = _.find(results, ({ filePath }) => path.basename(filePath) === "a");
          expect(resultForA.matches).toHaveLength(1);
          expect(resultForA.matches[0].matchText).toBe("dollar");
          expect(editor.getText()).toBe("Elephant");
        });

        it("ignores buffers outside the project", async () => {
          const results = [];
          const editor = await lumine.workspace.open(temp.openSync().path);

          editor.setText("Elephant");

          await scan(/Elephant/, {}, (result) => results.push(result));

          expect(results).toHaveLength(0);
        });

        describe("when the project has multiple root directories", () => {
          let dir1;
          let dir2;
          let file1;
          let file2;
          let extraRootBasename;

          beforeEach(() => {
            dir1 = lumine.project.getPaths()[0];
            file1 = path.join(dir1, "a-dir", "oh-git");

            dir2 = temp.mkdirSync("a-second-dir");
            const aDir2 = path.join(dir2, "a-dir");
            file2 = path.join(aDir2, "a-file");
            fs.mkdirSync(aDir2);
            fs.writeFileSync(file2, "ccc aaaa");

            lumine.project.addPath(dir2);
            extraRootBasename = path.basename(dir2);
          });

          it("searches matching files in all of the project's root directories", async () => {
            const resultPaths = [];

            await scan(/aaaa/, {}, ({ filePath }) => resultPaths.push(filePath));

            expect(resultPaths.sort()).toEqual([file1, file2].sort());
          });

          describe("when an inclusion path starts with the basename of a root directory", () => {
            it("interprets the inclusion path as starting from that directory", async () => {
              let resultPaths = [];
              await scan(/aaaa/, { paths: ["dir"] }, ({ filePath }) => {
                if (!resultPaths.includes(filePath)) {
                  resultPaths.push(filePath);
                }
              });

              expect(resultPaths).toEqual([file1]);

              resultPaths = [];
              await scan(/aaaa/, { paths: [path.join("dir", "a-dir")] }, ({ filePath }) => {
                if (!resultPaths.includes(filePath)) {
                  resultPaths.push(filePath);
                }
              });

              expect(resultPaths).toEqual([file1]);

              resultPaths = [];
              await scan(/aaaa/, { paths: [path.basename(dir2)] }, ({ filePath }) => {
                if (!resultPaths.includes(filePath)) {
                  resultPaths.push(filePath);
                }
              });

              expect(resultPaths).toEqual([file2]);

              resultPaths = [];
              await scan(
                /aaaa/,
                { paths: [path.join(path.basename(dir2), "a-dir")] },
                ({ filePath }) => {
                  if (!resultPaths.includes(filePath)) {
                    resultPaths.push(filePath);
                  }
                },
              );

              expect(resultPaths).toEqual([file2]);
            });
          });

          describe("when an exclusion path starts with the basename of a root directory", () => {
            it("interprets the exclusion as applying only to that root", async () => {
              let resultPaths = [];
              await scan(/aaaa/, { paths: [`!${extraRootBasename}`] }, ({ filePath }) => {
                if (!resultPaths.includes(filePath)) {
                  resultPaths.push(filePath);
                }
              });

              expect(resultPaths).toEqual([file1]);
            });
          });

          describe("when inclusion paths mix inclusions and exclusions", () => {
            it("filters out a wholesale exclusion of another root", async () => {
              let resultPaths = [];
              await scan(/aaaa/, { paths: ["dir", `!${extraRootBasename}`] }, ({ filePath }) => {
                if (!resultPaths.includes(filePath)) {
                  resultPaths.push(filePath);
                }
              });

              expect(resultPaths).toEqual([file1]);
            });

            it("does not apply an exclusion that targets a different root", async () => {
              let resultPaths = [];
              await scan(
                /aaaa/,
                { paths: ["dir", `!${extraRootBasename}/**/*`] },
                ({ filePath }) => {
                  if (!resultPaths.includes(filePath)) {
                    resultPaths.push(filePath);
                  }
                },
              );

              expect(resultPaths).toEqual([file1]);
            });
          });

          describe("when a custom directory searcher is registered", () => {
            let fakeSearch = null;
            // Function that is invoked once all of the fields on fakeSearch are set.
            let onFakeSearchCreated = null;

            class FakeSearch {
              constructor(options) {
                // Note that hoisting resolve and reject in this way is generally frowned upon.
                this.options = options;
                this.promise = new Promise((resolve, reject) => {
                  this.hoistedResolve = resolve;
                  this.hoistedReject = reject;
                  if (typeof onFakeSearchCreated === "function") {
                    onFakeSearchCreated(this);
                  }
                });
              }
              then(...args) {
                return this.promise.then.apply(this.promise, args);
              }
              cancel() {
                this.cancelled = true;
                // According to the spec for a DirectorySearcher, invoking `cancel()` should
                // resolve the thenable rather than reject it.
                this.hoistedResolve();
              }
            }

            beforeEach(() => {
              fakeSearch = null;
              onFakeSearchCreated = null;
              lumine.packages.serviceHub.provide("workspace.search-provider", "1.0.0", {
                canSearchDirectory(directory) {
                  return directory.getPath() === dir1;
                },
                search(directory, regex, options) {
                  fakeSearch = new FakeSearch(options);
                  return fakeSearch;
                },
              });
            });

            it("can override the built-in directory searcher on a per-directory basis", async () => {
              const foreignFilePath = "ssh://foreign-directory:8080/hello.txt";
              const numPathsSearchedInDir2 = 1;
              const numPathsToPretendToSearchInCustomDirectorySearcher = 10;
              const searchResult = {
                filePath: foreignFilePath,
                matches: [
                  {
                    lineText: "Hello world",
                    lineTextOffset: 0,
                    matchText: "Hello",
                    range: [
                      [0, 0],
                      [0, 5],
                    ],
                  },
                ],
              };
              onFakeSearchCreated = (fakeSearch) => {
                fakeSearch.options.didMatch(searchResult);
                fakeSearch.options.didSearchPaths(
                  numPathsToPretendToSearchInCustomDirectorySearcher,
                );
                fakeSearch.hoistedResolve();
              };

              const resultPaths = [];
              const onPathsSearched = jasmine.createSpy("onPathsSearched");

              await scan(/aaaa/, { onPathsSearched }, ({ filePath }) => resultPaths.push(filePath));

              expect(resultPaths.sort()).toEqual([foreignFilePath, file2].sort());
              // onPathsSearched should be called once by each DirectorySearcher. The order is not
              // guaranteed, so we can only verify the total number of paths searched is correct
              // after the second call.
              expect(onPathsSearched.calls.count()).toBe(2);
              expect(onPathsSearched.calls.mostRecent().args[0]).toBe(
                numPathsToPretendToSearchInCustomDirectorySearcher + numPathsSearchedInDir2,
              );
            });

            it("can be cancelled when the object returned by scan() has its cancel() method invoked", async () => {
              const thenable = scan(/aaaa/, {}, () => {});
              let resultOfPromiseSearch;

              expect(fakeSearch.cancelled).toBe(undefined);
              thenable.cancel();
              expect(fakeSearch.cancelled).toBe(true);

              resultOfPromiseSearch = await thenable;

              expect(resultOfPromiseSearch).toBe("cancelled");
            });

            it("will have the side-effect of failing the overall search if it fails", async () => {
              // This provider's search should be cancelled when the first provider fails
              let cancelableSearch;
              let fakeSearch2 = null;
              lumine.packages.serviceHub.provide("workspace.search-provider", "1.0.0", {
                canSearchDirectory(directory) {
                  return directory.getPath() === dir2;
                },
                search(directory, regex, options) {
                  fakeSearch2 = new FakeSearch(options);
                  return fakeSearch2;
                },
              });

              let cancelableSearchCatchSpy = jasmine.createSpy("cancelableSearch catch spy");
              cancelableSearch = scan(/aaaa/, () => {});

              fakeSearch.hoistedReject();

              await cancelableSearch.catch(cancelableSearchCatchSpy);

              await new Promise((resolve) => {
                cancelableSearch.then(null, resolve);
              });

              expect(cancelableSearchCatchSpy).toHaveBeenCalled();
              expect(fakeSearch2.cancelled).toBe(true);
            });
          });
        });
      });

      describe("leadingContextLineCount and trailingContextLineCount options", () => {
        async function search({ leadingContextLineCount, trailingContextLineCount }) {
          const results = [];
          await scan(/result/, { leadingContextLineCount, trailingContextLineCount }, (result) =>
            results.push(result),
          );

          return {
            leadingContext: results[0].matches.map((result) => result.leadingContextLines),
            trailingContext: results[0].matches.map((result) => result.trailingContextLines),
          };
        }

        const expectedLeadingContext = [
          ["line 1", "line 2", "line 3", "line 4", "line 5"],
          ["line 6", "line 7", "line 8", "line 9", "line 10"],
          ["line 7", "line 8", "line 9", "line 10", "result 2"],
          ["line 10", "result 2", "result 3", "line 11", "line 12"],
        ];
        const expectedTrailingContext = [
          ["line 6", "line 7", "line 8", "line 9", "line 10"],
          ["result 3", "line 11", "line 12", "result 4", "line 13"],
          ["line 11", "line 12", "result 4", "line 13", "line 14"],
          ["line 13", "line 14", "line 15"],
        ];

        it("returns valid contexts no matter how many lines are requested", async () => {
          expect(await search({})).toEqual({
            leadingContext: [[], [], [], []],
            trailingContext: [[], [], [], []],
          });

          expect(
            await search({
              leadingContextLineCount: 1,
              trailingContextLineCount: 1,
            }),
          ).toEqual({
            leadingContext: expectedLeadingContext.map((result) => result.slice(-1)),
            trailingContext: expectedTrailingContext.map((result) => result.slice(0, 1)),
          });

          expect(
            await search({
              leadingContextLineCount: 2,
              trailingContextLineCount: 2,
            }),
          ).toEqual({
            leadingContext: expectedLeadingContext.map((result) => result.slice(-2)),
            trailingContext: expectedTrailingContext.map((result) => result.slice(0, 2)),
          });

          expect(
            await search({
              leadingContextLineCount: 5,
              trailingContextLineCount: 5,
            }),
          ).toEqual({
            leadingContext: expectedLeadingContext.map((result) => result.slice(-5)),
            trailingContext: expectedTrailingContext.map((result) => result.slice(0, 5)),
          });

          expect(
            await search({
              leadingContextLineCount: 2,
              trailingContextLineCount: 3,
            }),
          ).toEqual({
            leadingContext: expectedLeadingContext.map((result) => result.slice(-2)),
            trailingContext: expectedTrailingContext.map((result) => result.slice(0, 3)),
          });
        });
      });

      describe("with multiple project roots", () => {
        let projectDir1, projectDir2;
        let projectRoot1, projectRoot2;

        beforeEach(() => {
          projectDir1 = temp.mkdirSync("lumine");
          projectDir2 = temp.mkdirSync("lumine");

          // Within each of these two directories, create another directory so
          // we can control the exact basename.
          projectRoot1 = path.resolve(projectDir1, "alpha");
          projectRoot2 = path.resolve(projectDir2, "beta");
          fs.mkdirSync(projectRoot1);
          fs.mkdirSync(projectRoot2);

          let fixturesDirA = path.resolve(__dirname, "fixtures", "workspace-scan", "a-dir");
          let fixturesDirB = path.resolve(__dirname, "fixtures", "workspace-scan", "b-dir");

          fs.cpSync(fixturesDirA, projectRoot1, { recursive: true });
          fs.cpSync(fixturesDirB, projectRoot2, { recursive: true });

          lumine.project.setPaths([projectRoot1, projectRoot2]);
        });

        it("should search both roots when no paths are given", async () => {
          let results = [];
          await scan(
            /ipsum/,
            {
              leadingContextLineCount: 1,
              trailingContextLineCount: 1,
            },
            (result) => results.push(result.filePath),
          );

          results.sort((a, b) => a.localeCompare(b));

          let sortedExpectedFilePaths = [
            path.join(projectRoot1, "sample1.js"),
            path.join(projectRoot2, "sample1.js"),
          ].sort();

          expect(results).toEqual(sortedExpectedFilePaths);
        });
      });
    }); // Cancels other ongoing searches
  }

  describe("::replace(regex, replacementText, paths, iterator)", () => {
    let fixturesDir, projectDir;

    beforeEach(() => {
      fixturesDir = path.dirname(lumine.project.getPaths()[0]);
      projectDir = temp.mkdirSync("lumine");
      lumine.project.setPaths([projectDir]);
    });

    it("does not start a worker when no paths are requested", async () => {
      spyOn(Task, "once").and.callThrough();

      await lumine.workspace.replace(/items/g, "replacement", [], () => {});

      expect(Task.once).not.toHaveBeenCalled();
    });

    describe("when a file doesn't exist", () => {
      it("calls back with an error", async () => {
        const errors = [];
        const missingPath = path.resolve("/not-a-file.js");
        expect(fs.existsSync(missingPath)).toBeFalsy();

        await lumine.workspace.replace(/items/gi, "items", [missingPath], (result, error) =>
          errors.push(error),
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].path).toBe(missingPath);
      });
    });

    describe("when called with unopened files", () => {
      it("replaces properly", async () => {
        const filePath = path.join(projectDir, "sample.js");
        fs.copyFileSync(path.join(fixturesDir, "sample.js"), filePath);

        const results = [];
        await lumine.workspace.replace(/items/gi, "items", [filePath], (result) => {
          results.push(result);
        });

        expect(results).toHaveLength(1);
        expect(results[0].filePath).toBe(filePath);
        expect(results[0].replacements).toBe(6);
      });

      it("does not discard the multiline flag", async () => {
        const filePath = path.join(projectDir, "sample.js");
        fs.copyFileSync(path.join(fixturesDir, "sample.js"), filePath);

        const results = [];
        await lumine.workspace.replace(/;$/gim, "items", [filePath], (result) => {
          results.push(result);
        });

        expect(results).toHaveLength(1);
        expect(results[0].filePath).toBe(filePath);
        expect(results[0].replacements).toBe(8);
      });

      it("preserves the unicode flag", async () => {
        const filePath = path.join(projectDir, "unicode.txt");
        fs.writeFileSync(filePath, "😀 😀");
        const results = [];

        await lumine.workspace.replace(/[😀]/gu, "X", [filePath], (result) => {
          results.push(result);
        });

        expect(results).toEqual([{ filePath, replacements: 2 }]);
        expect(fs.readFileSync(filePath, "utf8")).toBe("X X");
      });
    });

    describe("when a buffer is already open", () => {
      it("replaces the file on disk and reloads an unmodified buffer", async () => {
        const filePath = path.join(projectDir, "sample.js");
        fs.copyFileSync(path.join(fixturesDir, "sample.js"), path.join(projectDir, "sample.js"));
        const results = [];
        const editor = await lumine.workspace.open("sample.js");
        await editor.buffer.getFileWatchStartPromise();
        const didReload = new Promise((resolve) => editor.buffer.onDidReload(resolve));
        spyOn(editor.buffer, "save").and.callThrough();

        expect(editor.isModified()).toBeFalsy();

        await lumine.workspace.replace(/items/gi, "okthen", [filePath], (result) => {
          results.push(result);
        });
        await didReload;

        expect(results).toHaveLength(1);
        expect(results[0].filePath).toBe(filePath);
        expect(results[0].replacements).toBe(6);
        expect(editor.buffer.save).not.toHaveBeenCalled();
        expect(editor.isModified()).toBeFalsy();
        expect(editor.getText()).toContain("okthen");
        expect(fs.readFileSync(filePath, "utf8")).toContain("okthen");
      });

      it("produces the same capture replacements for open and unopened files", async () => {
        const openPath = path.join(projectDir, "open.txt");
        const closedPath = path.join(projectDir, "closed.txt");
        fs.writeFileSync(openPath, "alpha beta");
        fs.writeFileSync(closedPath, "alpha beta");
        const editor = await lumine.workspace.open(openPath);
        await editor.buffer.getFileWatchStartPromise();
        const didReload = new Promise((resolve) => editor.buffer.onDidReload(resolve));
        const results = [];

        await lumine.workspace.replace(
          /(alpha|beta)/g,
          "<$1>",
          [openPath, closedPath],
          (result) => {
            results.push(result);
          },
        );
        await didReload;

        results.sort((a, b) => a.filePath.localeCompare(b.filePath));
        expect(results).toEqual(
          [
            { filePath: openPath, replacements: 2 },
            { filePath: closedPath, replacements: 2 },
          ].sort((a, b) => a.filePath.localeCompare(b.filePath)),
        );
        expect(editor.getText()).toBe("<alpha> <beta>");
        expect(fs.readFileSync(openPath, "utf8")).toBe("<alpha> <beta>");
        expect(fs.readFileSync(closedPath, "utf8")).toBe("<alpha> <beta>");
      });

      it("does not replace when the path is not specified", async () => {
        const filePath = path.join(projectDir, "sample.js");
        const commentFilePath = path.join(projectDir, "sample-with-comments.js");
        fs.copyFileSync(path.join(fixturesDir, "sample.js"), filePath);
        fs.copyFileSync(
          path.join(fixturesDir, "sample-with-comments.js"),
          path.join(projectDir, "sample-with-comments.js"),
        );
        const results = [];

        await lumine.workspace.open("sample-with-comments.js");

        await lumine.workspace.replace(/items/gi, "items", [commentFilePath], (result) =>
          results.push(result),
        );

        expect(results).toHaveLength(1);
        expect(results[0].filePath).toBe(commentFilePath);
      });

      it("replaces the file on disk and marks a modified buffer as conflicted", async () => {
        const filePath = path.join(projectDir, "sample.js");
        fs.copyFileSync(path.join(fixturesDir, "sample.js"), filePath);
        const results = [];
        const editor = await lumine.workspace.open("sample.js");
        await editor.buffer.getFileWatchStartPromise();

        editor.buffer.setTextInRange(
          [
            [0, 0],
            [0, 0],
          ],
          "omg",
        );
        const didConflict = new Promise((resolve) => editor.buffer.onDidConflict(resolve));
        expect(editor.isModified()).toBeTruthy();

        await lumine.workspace.replace(/items/gi, "okthen", [filePath], (result) => {
          results.push(result);
        });
        await didConflict;

        expect(results).toHaveLength(1);
        expect(results[0].filePath).toBe(filePath);
        expect(results[0].replacements).toBe(6);
        expect(editor.isModified()).toBeTruthy();
        expect(editor.isInConflict()).toBe(true);
        expect(editor.getText()).not.toContain("okthen");
        expect(fs.readFileSync(filePath, "utf8")).toContain("okthen");
      });
    });
  });

  describe("::saveActivePaneItem()", () => {
    let editor, notificationSpy;

    beforeEach(async () => {
      editor = await lumine.workspace.open("sample.js");

      notificationSpy = jasmine.createSpy("did-add-notification");
      lumine.notifications.onDidAddNotification(notificationSpy);
    });

    describe("when there is an error", () => {
      it("emits a warning notification when the file cannot be saved", async () => {
        spyOn(editor, "save").and.callFake(() => {
          throw new Error("'/some/file' is a directory");
        });

        await lumine.workspace.saveActivePaneItem();

        expect(notificationSpy).toHaveBeenCalled();
        expect(notificationSpy.calls.mostRecent().args[0].getType()).toBe("warning");
        expect(notificationSpy.calls.mostRecent().args[0].getMessage()).toContain("Unable to save");
      });

      it("emits a warning notification when the directory cannot be written to", async () => {
        spyOn(editor, "save").and.callFake(() => {
          throw new Error("ENOTDIR, not a directory '/Some/dir/and-a-file.js'");
        });

        await lumine.workspace.saveActivePaneItem();

        expect(notificationSpy).toHaveBeenCalled();
        expect(notificationSpy.calls.mostRecent().args[0].getType()).toBe("warning");
        expect(notificationSpy.calls.mostRecent().args[0].getMessage()).toContain("Unable to save");
      });

      it("emits a warning notification when the user does not have permission", async () => {
        spyOn(editor, "save").and.callFake(() => {
          const error = new Error("EACCES, permission denied '/Some/dir/and-a-file.js'");
          error.code = "EACCES";
          error.path = "/Some/dir/and-a-file.js";
          throw error;
        });

        await lumine.workspace.saveActivePaneItem();

        expect(notificationSpy).toHaveBeenCalled();
        expect(notificationSpy.calls.mostRecent().args[0].getType()).toBe("warning");
        expect(notificationSpy.calls.mostRecent().args[0].getMessage()).toContain("Unable to save");
      });

      it("emits a warning notification when the operation is not permitted", async () => {
        spyOn(editor, "save").and.callFake(() => {
          const error = new Error("EPERM, operation not permitted '/Some/dir/and-a-file.js'");
          error.code = "EPERM";
          error.path = "/Some/dir/and-a-file.js";
          throw error;
        });

        await lumine.workspace.saveActivePaneItem();

        expect(notificationSpy).toHaveBeenCalled();
        expect(notificationSpy.calls.mostRecent().args[0].getType()).toBe("warning");
        expect(notificationSpy.calls.mostRecent().args[0].getMessage()).toContain("Unable to save");
      });

      it("emits a warning notification when the file is already open by another app", async () => {
        spyOn(editor, "save").and.callFake(() => {
          const error = new Error("EBUSY, resource busy or locked '/Some/dir/and-a-file.js'");
          error.code = "EBUSY";
          error.path = "/Some/dir/and-a-file.js";
          throw error;
        });

        await lumine.workspace.saveActivePaneItem();

        expect(notificationSpy).toHaveBeenCalled();
        expect(notificationSpy.calls.mostRecent().args[0].getType()).toBe("warning");
        expect(notificationSpy.calls.mostRecent().args[0].getMessage()).toContain("Unable to save");
      });

      it("emits a warning notification when the file system is read-only", async () => {
        spyOn(editor, "save").and.callFake(() => {
          const error = new Error("EROFS, read-only file system '/Some/dir/and-a-file.js'");
          error.code = "EROFS";
          error.path = "/Some/dir/and-a-file.js";
          throw error;
        });

        await lumine.workspace.saveActivePaneItem();

        expect(notificationSpy).toHaveBeenCalled();
        expect(notificationSpy.calls.mostRecent().args[0].getType()).toBe("warning");
        expect(notificationSpy.calls.mostRecent().args[0].getMessage()).toContain("Unable to save");
      });

      it("emits a warning notification when the file cannot be saved", async () => {
        spyOn(editor, "save").and.callFake(() => {
          throw new Error("no one knows");
        });

        const catchSpy = jasmine.createSpy();
        await lumine.workspace.saveActivePaneItem().catch(catchSpy);

        expect(catchSpy).toHaveBeenCalled();
      });
    });
  });

  describe("::closeActivePaneItemOrEmptyPaneOrWindow", () => {
    beforeEach(async () => {
      spyOn(lumine.window, "close");
      await lumine.workspace.open();
    });

    it("closes the active center pane item, or the active center pane if it is empty, or the current window if there is only the empty root pane in the center", async () => {
      lumine.config.set("core.destroyEmptyPanes", false);

      const pane1 = lumine.workspace.getActivePane();
      const pane2 = pane1.splitRight({ copyActiveItem: true });

      expect(lumine.workspace.getCenter().getPanes().length).toBe(2);
      expect(pane2.getItems().length).toBe(1);
      lumine.workspace.closeActivePaneItemOrEmptyPaneOrWindow();

      expect(lumine.workspace.getCenter().getPanes().length).toBe(2);
      expect(pane2.getItems().length).toBe(0);

      lumine.workspace.closeActivePaneItemOrEmptyPaneOrWindow();

      expect(lumine.workspace.getCenter().getPanes().length).toBe(1);
      expect(pane1.getItems().length).toBe(1);

      lumine.workspace.closeActivePaneItemOrEmptyPaneOrWindow();
      expect(lumine.workspace.getCenter().getPanes().length).toBe(1);
      expect(pane1.getItems().length).toBe(0);
      expect(lumine.workspace.getCenter().getPanes().length).toBe(1);

      // The dock items should not be closed
      await lumine.workspace.open({
        getTitle: () => "Permanent Dock Item",
        element: document.createElement("div"),
        getDefaultLocation: () => "left",
        isPermanentDockItem: () => true,
      });
      await lumine.workspace.open({
        getTitle: () => "Impermanent Dock Item",
        element: document.createElement("div"),
        getDefaultLocation: () => "left",
      });

      expect(lumine.workspace.getLeftDock().getPaneItems().length).toBe(2);
      lumine.workspace.closeActivePaneItemOrEmptyPaneOrWindow();
      expect(lumine.window.close).toHaveBeenCalled();
    });
  });

  describe("::activateNextPane", () => {
    describe("when the active workspace pane is inside a dock", () => {
      it("activates the next pane in the dock", () => {
        const dock = lumine.workspace.getLeftDock();
        const dockPane1 = dock.getPanes()[0];
        const dockPane2 = dockPane1.splitRight();

        dockPane2.focus();
        expect(lumine.workspace.getActivePane()).toBe(dockPane2);
        lumine.workspace.activateNextPane();
        expect(lumine.workspace.getActivePane()).toBe(dockPane1);
      });
    });

    describe("when the active workspace pane is inside the workspace center", () => {
      it("activates the next pane in the workspace center", () => {
        const center = lumine.workspace.getCenter();
        const centerPane1 = center.getPanes()[0];
        const centerPane2 = centerPane1.splitRight();

        centerPane2.focus();
        expect(lumine.workspace.getActivePane()).toBe(centerPane2);
        lumine.workspace.activateNextPane();
        expect(lumine.workspace.getActivePane()).toBe(centerPane1);
      });
    });
  });

  describe("::activatePreviousPane", () => {
    describe("when the active workspace pane is inside a dock", () => {
      it("activates the previous pane in the dock", () => {
        const dock = lumine.workspace.getLeftDock();
        const dockPane1 = dock.getPanes()[0];
        const dockPane2 = dockPane1.splitRight();

        dockPane1.focus();
        expect(lumine.workspace.getActivePane()).toBe(dockPane1);
        lumine.workspace.activatePreviousPane();
        expect(lumine.workspace.getActivePane()).toBe(dockPane2);
      });
    });

    describe("when the active workspace pane is inside the workspace center", () => {
      it("activates the previous pane in the workspace center", () => {
        const center = lumine.workspace.getCenter();
        const centerPane1 = center.getPanes()[0];
        const centerPane2 = centerPane1.splitRight();

        centerPane1.focus();
        expect(lumine.workspace.getActivePane()).toBe(centerPane1);
        lumine.workspace.activatePreviousPane();
        expect(lumine.workspace.getActivePane()).toBe(centerPane2);
      });
    });
  });

  describe("::getVisiblePanes", () => {
    it("returns all panes in visible pane containers", () => {
      const center = workspace.getCenter();
      const leftDock = workspace.getLeftDock();
      const rightDock = workspace.getRightDock();
      const bottomDock = workspace.getBottomDock();

      const centerPane = center.getPanes()[0];
      const leftDockPane = leftDock.getPanes()[0];
      const rightDockPane = rightDock.getPanes()[0];
      const bottomDockPane = bottomDock.getPanes()[0];

      leftDock.hide();
      rightDock.hide();
      bottomDock.hide();
      expect(workspace.getVisiblePanes()).toContain(centerPane);
      expect(workspace.getVisiblePanes()).not.toContain(leftDockPane);
      expect(workspace.getVisiblePanes()).not.toContain(rightDockPane);
      expect(workspace.getVisiblePanes()).not.toContain(bottomDockPane);

      leftDock.show();
      expect(workspace.getVisiblePanes()).toContain(centerPane);
      expect(workspace.getVisiblePanes()).toContain(leftDockPane);
      expect(workspace.getVisiblePanes()).not.toContain(rightDockPane);
      expect(workspace.getVisiblePanes()).not.toContain(bottomDockPane);

      rightDock.show();
      expect(workspace.getVisiblePanes()).toContain(centerPane);
      expect(workspace.getVisiblePanes()).toContain(leftDockPane);
      expect(workspace.getVisiblePanes()).toContain(rightDockPane);
      expect(workspace.getVisiblePanes()).not.toContain(bottomDockPane);

      bottomDock.show();
      expect(workspace.getVisiblePanes()).toContain(centerPane);
      expect(workspace.getVisiblePanes()).toContain(leftDockPane);
      expect(workspace.getVisiblePanes()).toContain(rightDockPane);
      expect(workspace.getVisiblePanes()).toContain(bottomDockPane);
    });
  });

  describe("::getVisiblePaneContainers", () => {
    it("returns all visible pane containers", () => {
      const center = workspace.getCenter();
      const leftDock = workspace.getLeftDock();
      const rightDock = workspace.getRightDock();
      const bottomDock = workspace.getBottomDock();

      leftDock.hide();
      rightDock.hide();
      bottomDock.hide();
      expect(workspace.getVisiblePaneContainers()).toEqual([center]);

      leftDock.show();
      expect(workspace.getVisiblePaneContainers().sort()).toEqual([center, leftDock]);

      rightDock.show();
      expect(workspace.getVisiblePaneContainers().sort()).toEqual([center, leftDock, rightDock]);

      bottomDock.show();
      expect(workspace.getVisiblePaneContainers().sort()).toEqual([
        center,
        leftDock,
        rightDock,
        bottomDock,
      ]);
    });
  });

  describe("when the core.allowPendingPaneItems option is falsy", () => {
    it("does not open item with `pending: true` option as pending", async () => {
      let pane;
      lumine.config.set("core.allowPendingPaneItems", false);

      await lumine.workspace.open("sample.js", { pending: true });
      pane = lumine.workspace.getActivePane();

      expect(pane.getPendingItem()).toBeFalsy();
    });
  });

  describe("grammar activation", () => {
    it("notifies the workspace of which grammar is used", async () => {
      lumine.packages.triggerDeferredActivationHooks();

      const javascriptGrammarUsed = jasmine.createSpy("js grammar used");
      const pythonGrammarUsed = jasmine.createSpy("python grammar used");
      const cGrammarUsed = jasmine.createSpy("c grammar used");

      lumine.packages.onDidTriggerActivationHook(
        "language-javascript:grammar-used",
        javascriptGrammarUsed,
      );
      lumine.packages.onDidTriggerActivationHook("language-python:grammar-used", pythonGrammarUsed);
      lumine.packages.onDidTriggerActivationHook("language-c:grammar-used", cGrammarUsed);

      await lumine.packages.activatePackage("language-python");
      await lumine.packages.activatePackage("language-javascript");
      await lumine.packages.activatePackage("language-c");
      await lumine.workspace.open("sample-with-comments.js");

      // Hooks are triggered when opening new editors
      expect(javascriptGrammarUsed).toHaveBeenCalled();

      // Hooks are triggered when changing existing editors grammars
      lumine.grammars.assignLanguageMode(lumine.workspace.getActiveTextEditor(), "source.c");
      expect(cGrammarUsed).toHaveBeenCalled();

      // Hooks are triggered when editors are added in other ways.
      lumine.workspace.getActivePane().splitRight({ copyActiveItem: true });
      lumine.grammars.assignLanguageMode(lumine.workspace.getActiveTextEditor(), "source.python");
      expect(pythonGrammarUsed).toHaveBeenCalled();
    });
  });

  describe(".checkoutHeadRevision()", () => {
    let editor = null;
    beforeEach(async () => {
      jasmine.useRealClock();
      lumine.config.set("git.confirmCheckoutHeadRevision", false);

      editor = await lumine.workspace.open("sample-with-comments.js");
    });

    it("reverts to the version of its file checked into the project repository", async () => {
      editor.setCursorBufferPosition([0, 0]);
      editor.insertText("---\n");
      expect(editor.lineTextForBufferRow(0)).toBe("---");

      lumine.workspace.checkoutHeadRevision(editor);

      await conditionPromise(() => editor.lineTextForBufferRow(0) === "");
    });

    describe("when there's no repository for the editor's file", () => {
      it("doesn't do anything", () => {
        editor = new TextEditor();
        editor.setText("stuff");
        lumine.workspace.checkoutHeadRevision(editor);

        lumine.workspace.checkoutHeadRevision(editor);
      });
    });
  });

  describe("when an item is moved", () => {
    beforeEach(() => {
      lumine.workspace.enablePersistence = true;
    });

    afterEach(async () => {
      await lumine.workspace.itemLocationStore.clear();
      lumine.workspace.enablePersistence = false;
    });

    it("stores the new location if it's not the default", () => {
      const ITEM_URI = "lumine://test";
      const item = {
        getURI: () => ITEM_URI,
        getDefaultLocation: () => "left",
        getElement: () => document.createElement("div"),
      };
      const centerPane = workspace.getActivePane();
      centerPane.addItem(item);
      const dockPane = lumine.workspace.getRightDock().getActivePane();
      spyOn(workspace.itemLocationStore, "save");
      centerPane.moveItemToPane(item, dockPane);
      expect(workspace.itemLocationStore.save).toHaveBeenCalledWith(ITEM_URI, "right");
    });

    it("clears the location if it's the default", () => {
      const ITEM_URI = "lumine://test";
      const item = {
        getURI: () => ITEM_URI,
        getDefaultLocation: () => "right",
        getElement: () => document.createElement("div"),
      };
      const centerPane = workspace.getActivePane();
      centerPane.addItem(item);
      const dockPane = lumine.workspace.getRightDock().getActivePane();
      spyOn(workspace.itemLocationStore, "save");
      spyOn(workspace.itemLocationStore, "delete");
      centerPane.moveItemToPane(item, dockPane);
      expect(workspace.itemLocationStore.delete).toHaveBeenCalledWith(ITEM_URI);
      expect(workspace.itemLocationStore.save).not.toHaveBeenCalled();
    });
  });
});
