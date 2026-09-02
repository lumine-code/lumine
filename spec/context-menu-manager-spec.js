const ContextMenuManager = require("../src/context-menu-manager");

describe("ContextMenuManager", function () {
  let [contextMenu, menuManager, parent, child, grandchild] = [];

  beforeEach(function () {
    const resourcePath = lumine.application.getResourcePath();
    menuManager = {
      showPopup: jasmine.createSpy("showPopup").and.returnValue({ close() {} }),
    };
    contextMenu = new ContextMenuManager({ keymapManager: lumine.keymaps, menuManager });
    contextMenu.initialize({ resourcePath });

    parent = document.createElement("div");
    child = document.createElement("div");
    grandchild = document.createElement("div");
    parent.tabIndex = -1;
    child.tabIndex = -1;
    grandchild.tabIndex = -1;
    parent.classList.add("parent");
    child.classList.add("child");
    grandchild.classList.add("grandchild");
    child.appendChild(grandchild);
    parent.appendChild(child);

    document.body.appendChild(parent);
  });

  afterEach(function () {
    document.body.blur();
    document.body.removeChild(parent);
  });

  it("shows the HTML popup against the DOM target", () => {
    const template = [{ label: "Run", command: "package:run" }];
    contextMenu.show(grandchild, template);
    expect(menuManager.showPopup.calls.mostRecent().args[0]).toEqual(
      jasmine.objectContaining({ template, target: grandchild, anchor: grandchild }),
    );
  });

  describe("::add(itemsBySelector)", function () {
    it("can add top-level menu items that can be removed with the returned disposable", function () {
      const disposable = contextMenu.add({
        ".parent": [{ label: "A", command: "a" }],
        ".child": [{ label: "B", command: "b" }],
        ".grandchild": [{ label: "C", command: "c" }],
      });

      expect(contextMenu.templateForElement(grandchild)).toEqual([
        { label: "C", id: "C", command: "c" },
        { label: "B", id: "B", command: "b" },
        { label: "A", id: "A", command: "a" },
      ]);

      disposable.dispose();
      expect(contextMenu.templateForElement(grandchild)).toEqual([]);
    });

    it("stops inheriting above an element that declares a context-menu boundary", function () {
      // An embedded surface — a result bubble, a rendered widget — owns its
      // context menu: its host's items would not apply inside it. The
      // boundary element's own level still contributes.
      contextMenu.add({
        ".parent": [{ label: "A", command: "a" }],
        ".child": [{ label: "B", command: "b" }],
        ".grandchild": [{ label: "C", command: "c" }],
      });

      child.setAttribute("data-context-menu-boundary", "");
      expect(contextMenu.templateForElement(grandchild)).toEqual([
        { label: "C", id: "C", command: "c" },
        { label: "B", id: "B", command: "b" },
      ]);

      // Clicking outside the boundary still sees the ancestor's items.
      child.removeAttribute("data-context-menu-boundary");
      expect(contextMenu.templateForElement(grandchild)).toEqual([
        { label: "C", id: "C", command: "c" },
        { label: "B", id: "B", command: "b" },
        { label: "A", id: "A", command: "a" },
      ]);
    });

    it("can add submenu items to existing menus that can be removed with the returned disposable", function () {
      const disposable1 = contextMenu.add({
        ".grandchild": [{ label: "A", submenu: [{ label: "B", command: "b" }] }],
      });
      const disposable2 = contextMenu.add({
        ".grandchild": [{ label: "A", submenu: [{ label: "C", command: "c" }] }],
      });

      expect(contextMenu.templateForElement(grandchild)).toEqual([
        {
          label: "A",
          id: "A",
          submenu: [
            { label: "B", id: "B", command: "b" },
            { label: "C", id: "C", command: "c" },
          ],
        },
      ]);

      disposable2.dispose();
      expect(contextMenu.templateForElement(grandchild)).toEqual([
        {
          label: "A",
          id: "A",
          submenu: [{ label: "B", id: "B", command: "b" }],
        },
      ]);

      disposable1.dispose();
      expect(contextMenu.templateForElement(grandchild)).toEqual([]);
    });

    it("favors the most specific / recently added item in the case of a duplicate label", function () {
      grandchild.classList.add("foo");

      const disposable1 = contextMenu.add({
        ".grandchild": [{ label: "A", command: "a" }],
      });
      const disposable2 = contextMenu.add({
        ".grandchild.foo": [{ label: "A", command: "b" }],
      });
      const disposable3 = contextMenu.add({
        ".grandchild": [{ label: "A", command: "c" }],
      });

      contextMenu.add({
        ".child": [{ label: "A", command: "d" }],
      });

      expect(contextMenu.templateForElement(grandchild)).toEqual([
        { label: "A", id: "A", command: "b" },
      ]);

      disposable2.dispose();
      expect(contextMenu.templateForElement(grandchild)).toEqual([
        { label: "A", id: "A", command: "c" },
      ]);

      disposable3.dispose();
      expect(contextMenu.templateForElement(grandchild)).toEqual([
        { label: "A", id: "A", command: "a" },
      ]);

      disposable1.dispose();
      expect(contextMenu.templateForElement(grandchild)).toEqual([
        { label: "A", id: "A", command: "d" },
      ]);
    });

    it("allows multiple separators, but not adjacent to each other", function () {
      contextMenu.add({
        ".grandchild": [
          { label: "A", command: "a" },
          { type: "separator" },
          { type: "separator" },
          { label: "B", command: "b" },
          { type: "separator" },
          { type: "separator" },
          { label: "C", command: "c" },
        ],
      });

      expect(contextMenu.templateForElement(grandchild)).toEqual([
        { label: "A", id: "A", command: "a" },
        { type: "separator" },
        { label: "B", id: "B", command: "b" },
        { type: "separator" },
        { label: "C", id: "C", command: "c" },
      ]);
    });

    it("excludes items marked for display in devMode unless in dev mode", function () {
      contextMenu.add({
        ".grandchild": [
          { label: "A", command: "a", devMode: true },
          { label: "B", command: "b", devMode: false },
        ],
      });

      expect(contextMenu.templateForElement(grandchild)).toEqual([
        { label: "B", id: "B", command: "b" },
      ]);

      contextMenu.devMode = true;
      expect(contextMenu.templateForElement(grandchild)).toEqual([
        { label: "A", id: "A", command: "a" },
        { label: "B", id: "B", command: "b" },
      ]);
    });

    it("allows items to be associated with `created` hooks which are invoked on template construction with the item and event", function () {
      let createdEvent = null;

      const item = {
        label: "A",
        command: "a",
        created(event) {
          this.command = "b";
          createdEvent = event;
        },
      };

      contextMenu.add({ ".grandchild": [item] });

      const dispatchedEvent = { target: grandchild };
      expect(contextMenu.templateForEvent(dispatchedEvent)).toEqual([
        { label: "A", id: "A", command: "b" },
      ]);
      expect(item.command).toBe("a"); // doesn't modify original item template
      expect(createdEvent).toBe(dispatchedEvent);
    });

    it("allows items to be associated with `shouldDisplay` hooks which are invoked on construction to determine whether the item should be included", function () {
      let shouldDisplayEvent = null;
      let shouldDisplay = true;

      const item = {
        label: "A",
        command: "a",
        shouldDisplay(event) {
          this.foo = "bar";
          shouldDisplayEvent = event;
          return shouldDisplay;
        },
      };
      contextMenu.add({ ".grandchild": [item] });

      const dispatchedEvent = { target: grandchild };
      expect(contextMenu.templateForEvent(dispatchedEvent)).toEqual([
        { label: "A", id: "A", command: "a" },
      ]);
      expect(item.foo).toBeUndefined(); // doesn't modify original item template
      expect(shouldDisplayEvent).toBe(dispatchedEvent);

      shouldDisplay = false;
      expect(contextMenu.templateForEvent(dispatchedEvent)).toEqual([]);
    });

    it("prunes a trailing separator", function () {
      contextMenu.add({
        ".grandchild": [
          { label: "A", command: "a" },
          { type: "separator" },
          { label: "B", command: "b" },
          { type: "separator" },
        ],
      });

      expect(contextMenu.templateForEvent({ target: grandchild })).toEqual([
        { label: "A", id: "A", command: "a" },
        { type: "separator" },
        { label: "B", id: "B", command: "b" },
      ]);
    });

    it("prunes a leading separator", function () {
      contextMenu.add({
        ".grandchild": [
          { type: "separator" },
          { label: "A", command: "a" },
          { type: "separator" },
          { label: "B", command: "b" },
        ],
      });

      expect(contextMenu.templateForEvent({ target: grandchild })).toEqual([
        { label: "A", id: "A", command: "a" },
        { type: "separator" },
        { label: "B", id: "B", command: "b" },
      ]);
    });

    it("prunes duplicate separators", function () {
      contextMenu.add({
        ".grandchild": [
          { label: "A", command: "a" },
          { type: "separator" },
          { type: "separator" },
          { label: "B", command: "b" },
        ],
      });

      expect(contextMenu.templateForEvent({ target: grandchild })).toEqual([
        { label: "A", id: "A", command: "a" },
        { type: "separator" },
        { label: "B", id: "B", command: "b" },
      ]);
    });

    it("prunes all redundant separators", function () {
      contextMenu.add({
        ".grandchild": [
          { type: "separator" },
          { type: "separator" },
          { label: "A", command: "a" },
          { type: "separator" },
          { type: "separator" },
          { label: "B", command: "b" },
          { label: "C", command: "c" },
          { type: "separator" },
          { type: "separator" },
        ],
      });

      expect(contextMenu.templateForEvent({ target: grandchild })).toEqual([
        { label: "A", id: "A", command: "a" },
        { type: "separator" },
        { label: "B", id: "B", command: "b" },
        { label: "C", id: "C", command: "c" },
      ]);
    });

    it("normalizes separators inside a submenu too", function () {
      // `sortMenuItems` recurses through `sortTemplate`; the separate top-level
      // prune pass that used to run before it never did.
      contextMenu.add({
        ".grandchild": [
          {
            label: "Sub",
            submenu: [
              { type: "separator" },
              { label: "A", command: "a" },
              { type: "separator" },
              { type: "separator" },
              { label: "B", command: "b" },
              { type: "separator" },
            ],
          },
        ],
      });

      expect(contextMenu.templateForEvent({ target: grandchild })).toEqual([
        {
          label: "Sub",
          id: "Sub",
          submenu: [
            { label: "A", id: "A", command: "a" },
            { type: "separator" },
            { label: "B", id: "B", command: "b" },
          ],
        },
      ]);
    });

    it("throws an error when the selector is invalid", function () {
      let addError = null;
      try {
        contextMenu.add({ "<>": [{ label: "A", command: "a" }] });
      } catch (error) {
        addError = error;
      }
      expect(addError.message).toContain("<>");
    });

    it("calls `created` hooks for submenu items", function () {
      const item = {
        label: "A",
        command: "B",
        submenu: [
          {
            label: "C",
            created(_event) {
              this.label = "D";
            },
          },
        ],
      };
      contextMenu.add({ ".grandchild": [item] });

      const dispatchedEvent = { target: grandchild };
      expect(contextMenu.templateForEvent(dispatchedEvent)).toEqual([
        {
          label: "A",
          id: "A",
          command: "B",
          submenu: [
            {
              label: "D",
              id: "D",
            },
          ],
        },
      ]);
    });
  });

  describe("::templateForEvent(target)", function () {
    let [keymaps, item] = [];
    const controlALabel = process.platform === "darwin" ? "⌃A" : "Ctrl+A";
    const shiftBLabel = process.platform === "darwin" ? "⇧B" : "Shift+B";

    beforeEach(function () {
      keymaps = lumine.keymaps.add("source", {
        ".child": {
          "ctrl-a": "test:my-command",
          "shift-b": "test:my-other-command",
        },
      });
      item = {
        label: "My Command",
        command: "test:my-command",
        submenu: [
          {
            label: "My Other Command",
            command: "test:my-other-command",
          },
        ],
      };
      contextMenu.add({ ".parent": [item] });
    });

    afterEach(() => keymaps.dispose());

    it("adds humanized labels to items that have keybindings", function () {
      const dispatchedEvent = { target: child };
      expect(contextMenu.templateForEvent(dispatchedEvent)).toEqual([
        {
          label: "My Command",
          id: "My Command",
          command: "test:my-command",
          keyBindingLabel: controlALabel,
          submenu: [
            {
              label: "My Other Command",
              id: "My Other Command",
              command: "test:my-other-command",
              keyBindingLabel: shiftBLabel,
            },
          ],
        },
      ]);
    });

    it("adds labels for bindings declared on an ancestor of the target", function () {
      const dispatchedEvent = { target: grandchild };
      expect(contextMenu.templateForEvent(dispatchedEvent)).toEqual([
        {
          label: "My Command",
          id: "My Command",
          command: "test:my-command",
          keyBindingLabel: controlALabel,
          submenu: [
            {
              label: "My Other Command",
              id: "My Other Command",
              command: "test:my-other-command",
              keyBindingLabel: shiftBLabel,
            },
          ],
        },
      ]);
    });

    it("does not add accelerators when only a descendant of the right-clicked element is bound", function () {
      const dispatchedEvent = { target: parent };
      expect(contextMenu.templateForEvent(dispatchedEvent)).toEqual([
        {
          label: "My Command",
          id: "My Command",
          command: "test:my-command",
          submenu: [
            {
              label: "My Other Command",
              id: "My Other Command",
              command: "test:my-other-command",
            },
          ],
        },
      ]);
    });

    // Declared with the focus wrapper because half of it is only meaningful if
    // `.focus()` actually moved `activeElement`, which needs the spec window to
    // own the OS focus. Without the wrapper the first assertion would pass
    // vacuously wherever it does not.
    jasmine.itWithDocumentFocus(
      "resolves accelerators at the right-clicked element, not the focused one",
      function () {
        // The HTML popup dispatches directly at the element that was
        // right-clicked, so the advertised keystroke resolves there too.
        grandchild.focus();
        expect(contextMenu.templateForEvent({ target: parent })).toEqual([
          {
            label: "My Command",
            id: "My Command",
            command: "test:my-command",
            submenu: [
              {
                label: "My Other Command",
                id: "My Other Command",
                command: "test:my-other-command",
              },
            ],
          },
        ]);

        parent.focus();
        expect(contextMenu.templateForEvent({ target: child })).toEqual([
          {
            label: "My Command",
            id: "My Command",
            command: "test:my-command",
            keyBindingLabel: controlALabel,
            submenu: [
              {
                label: "My Other Command",
                id: "My Other Command",
                command: "test:my-other-command",
                keyBindingLabel: shiftBLabel,
              },
            ],
          },
        ]);
      },
    );

    it("resolves the same accelerators through templateForElement", function () {
      expect(contextMenu.templateForElement(child)).toEqual([
        {
          label: "My Command",
          id: "My Command",
          command: "test:my-command",
          keyBindingLabel: controlALabel,
          submenu: [
            {
              label: "My Other Command",
              id: "My Other Command",
              command: "test:my-other-command",
              keyBindingLabel: shiftBLabel,
            },
          ],
        },
      ]);
    });

    it("humanizes multi-keystroke key bindings", function () {
      lumine.keymaps.add("source", {
        ".child": {
          "ctrl-a ctrl-b": "test:multi-keystroke-command",
        },
      });
      contextMenu.clear();
      contextMenu.add({
        ".parent": [
          {
            label: "Multi-keystroke command",
            command: "test:multi-keystroke-command",
          },
        ],
      });

      const keystrokeLabel = process.platform === "darwin" ? "⌃A ⌃B" : "Ctrl+A Ctrl+B";
      expect(contextMenu.templateForEvent({ target: child })).toEqual([
        {
          label: "Multi-keystroke command",
          id: `Multi-keystroke command`,
          command: "test:multi-keystroke-command",
          keyBindingLabel: keystrokeLabel,
        },
      ]);
    });
  });

  describe("::templateForEvent(target) (sorting)", function () {
    it("applies simple sorting rules", function () {
      contextMenu.add({
        ".parent": [
          {
            label: "My Command",
            command: "test:my-command",
            after: ["test:my-other-command"],
          },
          {
            label: "My Other Command",
            command: "test:my-other-command",
          },
        ],
      });
      const dispatchedEvent = { target: parent };
      expect(contextMenu.templateForEvent(dispatchedEvent)).toEqual([
        {
          label: "My Other Command",
          id: "My Other Command",
          command: "test:my-other-command",
        },
        {
          label: "My Command",
          id: "My Command",
          command: "test:my-command",
        },
      ]);
    });

    it("applies sorting rules recursively to submenus", function () {
      contextMenu.add({
        ".parent": [
          {
            label: "Parent",
            submenu: [
              {
                label: "My Command",
                command: "test:my-command",
                after: ["test:my-other-command"],
              },
              {
                label: "My Other Command",
                command: "test:my-other-command",
              },
            ],
          },
        ],
      });
      const dispatchedEvent = { target: parent };
      expect(contextMenu.templateForEvent(dispatchedEvent)).toEqual([
        {
          label: "Parent",
          id: `Parent`,
          submenu: [
            {
              label: "My Other Command",
              id: "My Other Command",
              command: "test:my-other-command",
            },
            {
              label: "My Command",
              id: "My Command",
              command: "test:my-command",
            },
          ],
        },
      ]);
    });

    it("takes the positioning keys back out once it has read them", function () {
      // They are Lumine's, keyed on `command`. The template goes on to
      // `Menu.buildFromTemplate`, which reads the same four keys against `id` —
      // so leaving them in gives the menu a second, differently keyed pass over
      // items that are already in order.
      contextMenu.add({
        ".parent": [
          // `before` and `afterGroupContaining` name commands that are not
          // here, so they contribute no edge — they are present to be stripped.
          { label: "C", command: "test:c", after: ["test:b"], before: ["test:absent"] },
          { label: "B", command: "test:b" },
          { type: "separator" },
          {
            label: "A",
            command: "test:a",
            beforeGroupContaining: ["test:b"],
            afterGroupContaining: ["test:absent"],
          },
        ],
      });

      const template = contextMenu.templateForEvent({ target: child });
      const keys = template.flatMap((item) => Object.keys(item));
      for (const key of ["before", "after", "beforeGroupContaining", "afterGroupContaining"]) {
        expect(keys).not.toContain(key);
      }
      // Still sorted by them: A's group moved ahead, and C after B within theirs.
      expect(template.map((item) => item.command)).toEqual([
        "test:a",
        undefined,
        "test:b",
        "test:c",
      ]);
    });
  });
});
