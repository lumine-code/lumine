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
    it("preserves fresh checkbox and radio states through every merge", function () {
      let enabled = true;
      contextMenu.add({
        ".child": [
          {
            label: "Mode",
            type: "checkbox",
            command: "test:toggle-mode",
            created() {
              this.checked = enabled;
            },
          },
          {
            label: "Scope",
            submenu: [{ label: "File", type: "radio", checked: false }],
          },
        ],
      });
      const first = contextMenu.templateForElement(grandchild);
      expect(first[0].checked).toBe(true);
      expect(first[1].submenu[0].checked).toBe(false);
      enabled = false;
      expect(contextMenu.templateForElement(grandchild)[0].checked).toBe(false);
      expect(first[0].checked).toBe(true);
    });

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

  describe("named groups", function () {
    const commands = (template) => template.map((item) => item.command);

    for (const registrationOrder of [
      ["policy", "package"],
      ["package", "policy"],
    ]) {
      it(`orders contributions across DOM levels with ${registrationOrder[0]} registered first`, () => {
        const definitions = {
          policy: {
            ".parent": {
              groupOrder: ["history", "clipboard", "extensions"],
              items: [
                { label: "Undo", command: "test:undo", group: "history", order: 10 },
                { label: "Copy", command: "test:copy", group: "clipboard", order: 10 },
              ],
            },
          },
          package: {
            ".grandchild": [
              { label: "Paste", command: "test:paste", group: "clipboard", order: 20 },
            ],
            ".child": [{ label: "Redo", command: "test:redo", group: "history", order: 20 }],
          },
        };
        for (const provider of registrationOrder) contextMenu.add(definitions[provider]);

        expect(contextMenu.templateForElement(grandchild)).toEqual([
          { label: "Undo", id: "Undo", command: "test:undo" },
          { label: "Redo", id: "Redo", command: "test:redo" },
          { type: "separator" },
          { label: "Copy", id: "Copy", command: "test:copy" },
          { label: "Paste", id: "Paste", command: "test:paste" },
        ]);
        expect(definitions.policy[".parent"].groupOrder).toEqual([
          "history",
          "clipboard",
          "extensions",
        ]);
        expect(definitions.package[".child"][0].group).toBe("history");
      });
    }

    it("uses the closest policy before a more specific ancestor policy", () => {
      parent.classList.add("specific");
      contextMenu.add({
        ".parent.specific": {
          groupOrder: ["second", "first"],
          items: [],
        },
        ".child": {
          groupOrder: ["first", "second"],
          items: [],
        },
        ".grandchild": [
          { label: "Second", command: "test:second", group: "second" },
          { label: "First", command: "test:first", group: "first" },
        ],
      });

      expect(commands(contextMenu.templateForElement(grandchild))).toEqual([
        "test:first",
        undefined,
        "test:second",
      ]);
    });

    it("inherits an ancestor policy through an items-only descriptor", () => {
      contextMenu.add({
        ".parent": {
          groupOrder: ["first", "second"],
          items: [],
        },
        ".child": {
          items: [
            { label: "Second", command: "test:second", group: "second" },
            { label: "First", command: "test:first", group: "first" },
          ],
        },
      });

      expect(commands(contextMenu.templateForElement(grandchild))).toEqual([
        "test:first",
        undefined,
        "test:second",
      ]);
    });

    it("retains the closest shared submenu layout while merging ancestor actions", () => {
      contextMenu.add({
        ".child": {
          groupOrder: ["primary", "secondary"],
          items: [
            {
              label: "Navigate",
              group: "primary",
              order: 10,
              groupOrder: ["forward", "back"],
              submenu: [
                { label: "Previous", command: "test:previous", group: "back", order: 10 },
                { label: "Next", command: "test:next", group: "forward", order: 10 },
              ],
            },
            { label: "Local Action", command: "test:local", group: "primary", order: 20 },
            { label: "Other Action", command: "test:other", group: "secondary", order: 10 },
          ],
        },
        ".parent": [
          {
            label: "Navigate",
            group: "secondary",
            order: 90,
            groupOrder: ["back", "forward"],
            submenu: [{ label: "Go to Line", command: "test:line", group: "forward", order: 20 }],
          },
        ],
      });

      const template = contextMenu.templateForElement(grandchild);
      expect(commands(template)).toEqual([undefined, "test:local", undefined, "test:other"]);
      expect(template[0].label).toBe("Navigate");
      expect(commands(template[0].submenu)).toEqual([
        "test:next",
        "test:line",
        undefined,
        "test:previous",
      ]);
    });

    it("uses selector specificity for policies at the same DOM level", () => {
      grandchild.classList.add("specific");
      contextMenu.add({
        ".grandchild.specific": {
          groupOrder: ["first", "second"],
          items: [],
        },
      });
      contextMenu.add({
        ".grandchild": {
          groupOrder: ["second", "first"],
          items: [
            { label: "Second", command: "test:second", group: "second" },
            { label: "First", command: "test:first", group: "first" },
          ],
        },
      });

      expect(commands(contextMenu.templateForElement(grandchild))).toEqual([
        "test:first",
        undefined,
        "test:second",
      ]);
    });

    it("restores an earlier policy when the equally specific later policy is disposed", () => {
      contextMenu.add({
        ".child": {
          groupOrder: ["first", "second"],
          items: [
            { label: "First", command: "test:first", group: "first" },
            { label: "Second", command: "test:second", group: "second" },
          ],
        },
      });
      const laterPolicy = contextMenu.add({
        ".child": { groupOrder: ["second", "first"], items: [] },
      });

      expect(commands(contextMenu.templateForElement(grandchild))).toEqual([
        "test:second",
        undefined,
        "test:first",
      ]);
      laterPolicy.dispose();
      expect(commands(contextMenu.templateForElement(grandchild))).toEqual([
        "test:first",
        undefined,
        "test:second",
      ]);
    });

    it("cuts ancestor policies at a context-menu boundary", () => {
      contextMenu.add({
        ".parent": { groupOrder: ["second", "first"], items: [] },
        ".child": [
          { label: "First", command: "test:first", group: "first" },
          { label: "Second", command: "test:second", group: "second" },
        ],
      });
      child.setAttribute("data-context-menu-boundary", "");

      expect(commands(contextMenu.templateForElement(grandchild))).toEqual([
        "test:first",
        "test:second",
      ]);
      child.removeAttribute("data-context-menu-boundary");
      expect(commands(contextMenu.templateForElement(grandchild))).toEqual([
        "test:second",
        undefined,
        "test:first",
      ]);
    });

    it("removes empty groups after shouldDisplay changes and package disposal", () => {
      let showHistory = true;
      contextMenu.add({
        ".parent": {
          groupOrder: ["history", "clipboard", "extensions"],
          items: [
            {
              label: "Undo",
              command: "test:undo",
              group: "history",
              shouldDisplay: () => showHistory,
            },
          ],
        },
      });
      const packageMenu = contextMenu.add({
        ".child": [
          { type: "separator" },
          { label: "Copy", command: "test:copy", group: "clipboard" },
          { type: "separator" },
        ],
      });

      expect(commands(contextMenu.templateForElement(grandchild))).toEqual([
        "test:undo",
        undefined,
        "test:copy",
      ]);
      showHistory = false;
      expect(commands(contextMenu.templateForElement(grandchild))).toEqual(["test:copy"]);
      packageMenu.dispose();
      expect(contextMenu.templateForElement(grandchild)).toEqual([]);
      showHistory = true;
      expect(commands(contextMenu.templateForElement(grandchild))).toEqual(["test:undo"]);
    });

    it("preserves separately fenced legacy blocks in the extensions group", () => {
      contextMenu.add({
        ".parent": {
          groupOrder: ["history", "extensions", "clipboard"],
          items: [
            { label: "Undo", command: "test:undo", group: "history" },
            { label: "Copy", command: "test:copy", group: "clipboard" },
          ],
        },
        ".grandchild": [
          { type: "separator" },
          { label: "Run B", command: "test:b", afterGroupContaining: ["test:a"] },
          { type: "separator" },
        ],
        ".child": [
          { type: "separator" },
          { label: "Run A", command: "test:a" },
          { type: "separator" },
        ],
      });

      expect(commands(contextMenu.templateForElement(grandchild))).toEqual([
        "test:undo",
        undefined,
        "test:a",
        undefined,
        "test:b",
        undefined,
        "test:copy",
      ]);
    });

    it("applies legacy positioning within named groups and strips all layout metadata", () => {
      contextMenu.add({
        ".child": {
          groupOrder: ["actions", "extensions"],
          items: [
            {
              label: "B",
              command: "test:b",
              group: "actions",
              order: 10,
              after: ["test:a"],
            },
            { label: "A", command: "test:a", group: "actions", order: 20 },
            {
              label: "Submenu",
              group: "extensions",
              groupOrder: ["create", "close"],
              submenu: [
                { label: "Close", command: "test:close", group: "close", order: 10 },
                { label: "Open", command: "test:open", group: "create", order: 10 },
              ],
            },
          ],
        },
      });

      const template = contextMenu.templateForElement(grandchild);
      expect(commands(template)).toEqual(["test:a", "test:b", undefined, undefined]);
      expect(commands(template[3].submenu)).toEqual(["test:open", undefined, "test:close"]);
      const allItems = [...template, ...template[3].submenu];
      for (const item of allItems) {
        for (const key of ["group", "order", "groupOrder", "sortBy", "after"]) {
          expect(Object.hasOwn(item, key)).toBe(false);
        }
      }
    });

    it("accepts a selector descriptor that sorts items by label", () => {
      contextMenu.add({
        ".child": {
          sortBy: "label",
          items: [
            { label: "Zebra", command: "test:zebra" },
            { label: "Alpha", command: "test:alpha" },
          ],
        },
      });

      expect(commands(contextMenu.templateForElement(grandchild))).toEqual([
        "test:alpha",
        "test:zebra",
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

    it("only infers key bindings for commands without a detail payload", function () {
      contextMenu.clear();
      const details = [{ redistribute: true }, {}, false, 0, "alternate"];
      contextMenu.add({
        ".parent": [
          { label: "Plain", command: "test:my-command" },
          { label: "Null Detail", command: "test:my-command", commandDetail: null },
          ...details.map((commandDetail, index) => ({
            label: `Variant ${index}`,
            command: "test:my-command",
            commandDetail,
          })),
          {
            label: "Nested",
            submenu: [
              { label: "Plain", command: "test:my-other-command" },
              {
                label: "Variant",
                command: "test:my-other-command",
                commandDetail: { sequentize: true },
              },
            ],
          },
        ],
      });

      const template = contextMenu.templateForElement(child);
      expect(template[0].keyBindingLabel).toBe(controlALabel);
      expect(template[1].keyBindingLabel).toBe(controlALabel);
      for (const [index, detail] of details.entries()) {
        expect(template[index + 2].keyBindingLabel).toBeUndefined();
        expect(template[index + 2].commandDetail).toEqual(detail);
      }
      const nested = template.at(-1).submenu;
      expect(nested[0].keyBindingLabel).toBe(shiftBLabel);
      expect(nested[1].keyBindingLabel).toBeUndefined();
      expect(nested[1].commandDetail).toEqual({ sequentize: true });
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

    for (const registrationOrder of [
      ["terminal", "spawn"],
      ["spawn", "terminal"],
    ]) {
      it(`merges shared Terminal contributions with ${registrationOrder[0]} registered first`, () => {
        const providers = {
          terminal: [
            {
              label: "Open New",
              command: "terminal:open",
              beforeGroupContaining: ["terminal-spawn:open"],
            },
          ],
          spawn: [
            { type: "separator" },
            { label: "Spawn New", command: "terminal-spawn:open" },
            { type: "separator" },
          ],
        };
        contextMenu.add({
          ".child": [
            { type: "separator" },
            {
              label: "Git Publish",
              id: "tree:publish",
              afterGroupContaining: [{ id: "tree:terminal" }, "tree:files"],
              submenu: [{ label: "as Major", command: "publish:major" }],
            },
            { type: "separator" },
          ],
          ".parent": [
            { type: "separator" },
            { label: "Files", command: "tree:files" },
            { type: "separator" },
          ],
        });
        for (const provider of registrationOrder) {
          contextMenu.add({
            ".child": [
              { type: "separator" },
              {
                label: "Terminal",
                id: "tree:terminal",
                afterGroupContaining: ["tree:files"],
                submenu: providers[provider],
              },
              { type: "separator" },
            ],
          });
        }

        const template = contextMenu.templateForElement(grandchild);
        expect(template.map((item) => item.id)).toEqual([
          "Files",
          undefined,
          "tree:terminal",
          undefined,
          "tree:publish",
        ]);
        const terminal = template[2];
        expect(terminal.command).toBeUndefined();
        expect(terminal.submenu.map((item) => item.command)).toEqual([
          "terminal:open",
          undefined,
          "terminal-spawn:open",
        ]);
        expect(terminal.afterGroupContaining).toBeUndefined();
        expect(template[4].afterGroupContaining).toBeUndefined();
        expect(terminal.submenu[0].beforeGroupContaining).toBeUndefined();
      });
    }

    it("takes the positioning keys back out once it has read them", function () {
      // They are Lumine's: strings name commands and objects name ids. The
      // template goes on to `Menu.buildFromTemplate`, which reads the same four
      // keys against `id` — so leaving them in gives the menu a second,
      // differently keyed pass over items that are already in order.
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
