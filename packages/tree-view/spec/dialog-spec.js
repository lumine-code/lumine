const fs = require("fs");
const os = require("os");
const path = require("path");
const fsCompat = require("../lib/fs-compat");
const AddDialog = require("../lib/add-dialog");
const MoveDialog = require("../lib/move-dialog");
const CopyDialog = require("../lib/copy-dialog");
const {
  activeSession,
  modalElement,
  statusText,
  setQuery,
  confirm,
  settle,
} = require("../../../spec/helpers/modal-helpers");

describe("TreeView dialogs", () => {
  let projectPath;
  let dialogs;

  beforeEach(() => {
    projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tree-view-dialog-")));
    atom.project.setPaths([projectPath]);
    jasmine.attachToDOM(atom.views.getView(atom.workspace));
    dialogs = [];
  });

  afterEach(() => {
    if (atom.modals.isOpen()) atom.modals.cancel("api");
    dialogs.length = 0;
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  // Opens the dialog, types a path and confirms it, the way a user would.
  async function submit(dialog, text) {
    dialog.attach();
    await settle();
    setQuery(text);
    await settle();
    confirm();
    await settle();
  }

  function track(dialog) {
    dialogs.push(dialog);
    return dialog;
  }

  function fixture(name, contents = "") {
    const full = path.join(projectPath, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
    return full;
  }

  describe("AddDialog", () => {
    it("renders the prompt in the header and creates a file", async () => {
      const dialog = track(new AddDialog(projectPath, true));
      dialog.attach();
      await settle();

      expect(modalElement().querySelector("label.icon").textContent).toContain("file");
      expect(statusText()).toContain("relative to the project root");

      let created = null;
      dialog.onDidCreateFile((createdPath) => (created = createdPath));
      setQuery("newfile.txt");
      await settle();
      confirm();
      await settle();

      expect(created).toBe(path.join(projectPath, "newfile.txt"));
      expect(fs.existsSync(created)).toBe(true);
      expect(atom.modals.isOpen()).toBe(false);
    });

    it("shows an error and stays open when the target already exists", async () => {
      fixture("exists.txt");
      const dialog = track(new AddDialog(projectPath, true));
      await submit(dialog, "exists.txt");

      expect(statusText()).toContain("already exists");
      expect(modalElement().classList.contains("error")).toBe(true);
      // The path has to stay correctable, so the dialog must not close.
      expect(atom.modals.isOpen()).toBe(true);
    });
  });

  describe("MoveDialog", () => {
    it("moves the entry and reports the move", async () => {
      const source = fixture("old.txt", "content");
      let moved = null;
      const dialog = track(
        new MoveDialog(source, {
          onMove: ({ initialPath, newPath }) => (moved = { initialPath, newPath }),
        }),
      );
      await submit(dialog, "renamed.txt");

      const destination = path.join(projectPath, "renamed.txt");
      expect(fs.existsSync(source)).toBe(false);
      expect(fs.existsSync(destination)).toBe(true);
      expect(moved).toEqual({ initialPath: source, newPath: destination });
    });
  });

  describe("CopyDialog", () => {
    function makeCopyDialog(source, onCopy) {
      return track(new CopyDialog(source, { onCopy: onCopy || (() => {}) }));
    }

    it("binds the open-after-copy checkbox to the tree-view.openAfterCopy config", async () => {
      atom.config.set("tree-view.openAfterCopy", true);
      makeCopyDialog(fixture("a.txt", "hi")).attach();
      await settle();

      const checkbox = modalElement().querySelector(".input-checkbox");
      expect(checkbox.checked).toBe(true);

      checkbox.checked = false;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      expect(atom.config.get("tree-view.openAfterCopy")).toBe(false);
    });

    it("reflects an external config change in the checkbox", async () => {
      atom.config.set("tree-view.openAfterCopy", false);
      makeCopyDialog(fixture("a.txt", "hi")).attach();
      await settle();
      expect(modalElement().querySelector(".input-checkbox").checked).toBe(false);

      atom.config.set("tree-view.openAfterCopy", true);
      await settle();
      expect(modalElement().querySelector(".input-checkbox").checked).toBe(true);
    });

    it("opens the duplicate when openAfterCopy is enabled", async () => {
      atom.config.set("tree-view.openAfterCopy", true);
      // Run the copy callback synchronously so the open decision is testable
      // without depending on real async filesystem timing.
      spyOn(fsCompat, "copy").and.callFake((source, destination, callback) => callback());
      spyOn(atom.workspace, "open").and.returnValue(Promise.resolve());

      await submit(makeCopyDialog(fixture("a.txt", "hi")), "b.txt");

      expect(fsCompat.copy).toHaveBeenCalled();
      expect(atom.workspace.open).toHaveBeenCalledWith(path.join(projectPath, "b.txt"), {
        activatePane: true,
      });
    });

    it("does not open the duplicate when openAfterCopy is disabled", async () => {
      atom.config.set("tree-view.openAfterCopy", false);
      spyOn(fsCompat, "copy").and.callFake((source, destination, callback) => callback());
      spyOn(atom.workspace, "open").and.returnValue(Promise.resolve());

      await submit(makeCopyDialog(fixture("a.txt", "hi")), "b.txt");

      expect(fsCompat.copy).toHaveBeenCalled();
      expect(atom.workspace.open).not.toHaveBeenCalled();
    });
  });
});
