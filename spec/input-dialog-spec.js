const { InputDialogView, SelectListView } = require("../src/select-list-view");

describe("InputDialogView", () => {
  let view;

  beforeEach(() => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
  });

  afterEach(async () => {
    if (view) {
      await view.destroy();
      view = null;
    }
  });

  describe("rendering", () => {
    it("renders a query editor with the input-dialog root class and custom classes", () => {
      view = new InputDialogView({ className: "my-package my-dialog" });
      expect(view.element.classList.contains("input-dialog")).toBe(true);
      expect(view.element.classList.contains("select-list")).toBe(false);
      expect(view.element.classList.contains("my-dialog")).toBe(true);
      expect(view.refs.queryEditor).toBeDefined();
      expect(view.element.querySelector("ol")).toBeNull();
    });

    it("hosts a caller-owned content element and preserves it across updates", async () => {
      const content = document.createElement("div");
      content.className = "dialog-body";
      view = new InputDialogView({ contentElement: content });
      expect(view.element.contains(content)).toBe(true);

      await view.update({ infoMessage: "changed" });
      expect(view.element.contains(content)).toBe(true);

      const replacement = document.createElement("div");
      await view.update({ contentElement: replacement });
      expect(view.element.contains(content)).toBe(false);
      expect(view.element.contains(replacement)).toBe(true);
    });

    it("shows one message at a time, loading over status over info", async () => {
      view = new InputDialogView({});
      await view.update({
        status: { type: "error", message: "boom" },
        infoMessage: "fyi",
        loadingMessage: "wait",
      });
      expect(view.refs.loadingMessage.textContent).toBe("wait");
      expect(view.refs.statusMessage).toBeUndefined();
      expect(view.refs.infoMessage).toBeUndefined();

      await view.update({ loadingMessage: null });
      expect(view.refs.statusMessage.textContent).toBe("boom");
      expect(view.refs.statusMessage.classList.contains("text-error")).toBe(true);

      // Clearing the overlay uncovers the resting line the dialog never lost.
      await view.update({ status: null });
      expect(view.refs.infoMessage.textContent).toBe("fyi");
    });

    it("clears a status on the next keystroke unless it is sticky", async () => {
      view = new InputDialogView({});

      await view.update({ status: { type: "error", message: "Enter a value." } });
      view.refs.queryEditor.setText("a");
      // The clear renders through the scheduler, so poll for the result
      // rather than awaiting the next update: the render may already have
      // flushed by the time we ask, and then there is no next update to wait
      // for.
      await conditionPromise(() => !view.refs.statusMessage);

      await view.update({ status: { message: "background", sticky: true } });
      view.refs.queryEditor.setText("ab");
      // Nothing to poll for here — a sticky status is expected not to move —
      // so flush with an update of our own and then assert.
      await view.update({});
      expect(view.refs.statusMessage.textContent).toBe("background");
    });

    it("renders a header element above the query editor", () => {
      const header = document.createElement("label");
      header.textContent = "Prompt";
      view = new InputDialogView({ headerElement: header });
      const children = Array.from(view.element.children);
      const headerIndex = children.indexOf(header);
      const editorIndex = children.findIndex((child) =>
        child.contains(view.refs.queryEditor.element),
      );
      expect(headerIndex).toBe(0);
      expect(headerIndex).toBeLessThan(editorIndex);
    });
  });

  describe("checkboxes", () => {
    const CONFIG_KEY = "input-dialog-spec.flag";

    afterEach(() => {
      lumine.config.unset(CONFIG_KEY);
    });

    it("reflects the bound config value and updates it on toggle", () => {
      lumine.config.set(CONFIG_KEY, true);
      view = new InputDialogView({
        checkboxes: [{ label: "Do the thing", config: CONFIG_KEY }],
      });
      const input = view.element.querySelector(".input-checkbox");
      expect(input.checked).toBe(true);
      expect(view.element.querySelector(".input-label-text").textContent).toBe("Do the thing");

      input.checked = false;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      expect(lumine.config.get(CONFIG_KEY)).toBe(false);
    });

    it("re-renders when the bound config changes externally", async () => {
      lumine.config.set(CONFIG_KEY, false);
      view = new InputDialogView({
        checkboxes: [{ label: "Flag", config: CONFIG_KEY }],
      });
      expect(view.element.querySelector(".input-checkbox").checked).toBe(false);

      lumine.config.set(CONFIG_KEY, true);
      await InputDialogView.getScheduler().getNextUpdatePromise();
      expect(view.element.querySelector(".input-checkbox").checked).toBe(true);
    });

    it("keeps local state and calls onChange for unbound checkboxes", () => {
      const changes = [];
      view = new InputDialogView({
        checkboxes: [{ label: "Local", checked: false, onChange: (c) => changes.push(c) }],
      });
      const input = view.element.querySelector(".input-checkbox");
      expect(input.checked).toBe(false);

      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      expect(changes).toEqual([true]);
      expect(view.localCheckboxState.get(0)).toBe(true);
    });

    it("returns focus to the query editor after a toggle so Enter still confirms", () => {
      view = new InputDialogView({ checkboxes: [{ label: "Flag", checked: false }] });
      view.show();
      const input = view.element.querySelector(".input-checkbox");
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      expect(view.refs.queryEditor.element.contains(document.activeElement)).toBe(true);
    });
  });

  describe("confirm and cancel", () => {
    it("confirms with the raw query text", () => {
      const confirmed = [];
      view = new InputDialogView({ didConfirm: (query) => confirmed.push(query) });
      view.refs.queryEditor.setText("hello world");
      view.confirm();
      expect(confirmed).toEqual(["hello world"]);
    });

    it("invokes didCancel on cancel", () => {
      let cancelled = false;
      view = new InputDialogView({ didCancel: () => (cancelled = true) });
      view.cancel();
      expect(cancelled).toBe(true);
    });

    it("reports query changes through didChangeQuery", () => {
      const queries = [];
      view = new InputDialogView({ didChangeQuery: (query) => queries.push(query) });
      view.refs.queryEditor.setText("abc");
      expect(queries).toEqual(["abc"]);
    });
  });

  describe("panel management", () => {
    it("shows and hides a modal panel and focuses the query editor", () => {
      view = new InputDialogView({});
      expect(view.isVisible()).toBe(false);

      view.show();
      expect(view.isVisible()).toBe(true);
      expect(lumine.workspace.getModalPanels()).toContain(view.panel);
      expect(view.element.contains(document.activeElement)).toBe(true);

      view.hide();
      expect(view.isVisible()).toBe(false);
    });

    it("cancels when focus moves outside the dialog", async () => {
      // Window focus is a separate guard in the implementation. Pin it here so
      // an open DevTools window cannot turn an in-dialog focus test into a
      // window-blur test.
      spyOn(document, "hasFocus").and.returnValue(true);
      let cancelled = false;
      view = new InputDialogView({ didCancel: () => (cancelled = true) });
      view.show();

      const outside = document.createElement("input");
      lumine.views.getView(lumine.workspace).appendChild(outside);
      outside.focus();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      outside.remove();
      expect(cancelled).toBe(true);
    });
  });

  describe("modal flow integration", () => {
    it("runs the show side effects when the panel is shown from outside", () => {
      let willShowCalls = 0;
      view = new InputDialogView({ willShow: () => willShowCalls++ });
      view.refs.queryEditor.setText("stale");

      view.getPanel().show();

      expect(willShowCalls).toBe(1);
      expect(view.isVisible()).toBe(true);
      expect(view.element.contains(document.activeElement)).toBe(true);
      // Showing is showing, whoever did it: the dialog opens on an empty query.
      expect(view.getQuery()).toBe("");
    });

    it("selects a preserved query on show, so a keystroke still replaces it", () => {
      view = new InputDialogView({ preserveQuery: true });
      view.refs.queryEditor.setText("kept");

      view.getPanel().show();

      expect(view.refs.queryEditor.getSelectedText()).toBe("kept");
    });

    it("carries the crumb prop on its panel and keeps it in sync", async () => {
      view = new InputDialogView({ crumb: "Branches" });
      expect(view.getPanel().crumb).toBe("Branches");

      await view.update({ crumb: "Refs" });
      expect(view.panel.crumb).toBe("Refs");
    });

    it("enters a flow step without cancelling the dialog it covers", async () => {
      let cancelled = false;
      view = new InputDialogView({ crumb: "Root", didCancel: () => (cancelled = true) });
      const step = new InputDialogView({});
      try {
        view.show();

        step.show({ crumb: "Step" });

        expect(cancelled).toBe(false);
        expect(view.isVisible()).toBe(false);
        expect(step.isVisible()).toBe(true);
        expect(lumine.workspace.getModalTrail()).toEqual(["Root", "Step"]);
      } finally {
        await step.destroy();
      }
    });

    it("offers its own commands as item actions, like a select list", async () => {
      view = new InputDialogView({ className: "dialog-spec", crumb: "Dialog" });
      const commands = lumine.commands.add(view.element, {
        "dialog-spec:clear": {
          description: "Clear the field and start over",
          didDispatch: () => {},
        },
      });
      try {
        view.show();
        await view.showItemActions();

        expect(view.itemActionsList.isVisible()).toBeTruthy();
        expect(view.itemActionsList.props.items.map((a) => a.command)).toEqual([
          "dialog-spec:clear",
        ]);
        // A plain dialog has no selection to name.
        expect(view.itemActionsList.props.infoMessage).toBeNull();
        expect(lumine.workspace.getModalTrail()).toEqual(["Dialog", "Actions"]);
      } finally {
        commands.dispose();
      }
    });

    it("re-runs the show side effects when the flow navigates back", async () => {
      let willShowCalls = 0;
      view = new InputDialogView({ crumb: "Root", willShow: () => willShowCalls++ });
      const step = new InputDialogView({});
      try {
        view.show();
        view.refs.queryEditor.setText("query");
        step.show({ crumb: "Step" });
        expect(willShowCalls).toBe(1);

        expect(lumine.workspace.popModal()).toBe(true);

        expect(willShowCalls).toBe(2);
        expect(view.isVisible()).toBe(true);
        expect(view.refs.queryEditor.getText()).toBe("query");
        expect(view.refs.queryEditor.getSelectedText()).toBe("query");
        expect(view.element.contains(document.activeElement)).toBe(true);
        expect(lumine.workspace.getModalTrail()).toEqual(["Root"]);
      } finally {
        await step.destroy();
      }
    });
  });

  describe("focus policy", () => {
    it("keeps focus in the query editor when pressing non-interactive content", () => {
      const content = document.createElement("div");
      content.textContent = "static";
      view = new InputDialogView({ contentElement: content });
      view.show();

      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      content.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it("lets interactive controls inside the content take focus", () => {
      const content = document.createElement("div");
      const input = document.createElement("input");
      content.appendChild(input);
      view = new InputDialogView({ contentElement: content });
      view.show();

      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);

      input.focus();
      expect(document.activeElement).toBe(input);
    });

    it("does not refocus when focus moves into the query editor's own subtree", () => {
      // Refocusing here would re-fire focusout and recurse (RangeError). The
      // guard skips the refocus when the new focus target is inside the editor.
      view = new InputDialogView({});
      view.show();
      const editorElement = view.refs.queryEditor.element;
      const inner = editorElement.querySelector("input") || editorElement;
      spyOn(editorElement, "focus");

      const event = new FocusEvent("focusout", { bubbles: true, relatedTarget: inner });
      view.element.dispatchEvent(event);

      expect(editorElement.focus).not.toHaveBeenCalled();
    });
  });

  describe("typing", () => {
    it("lets a backtick through as a normal character", () => {
      view = new InputDialogView({});
      const event = new KeyboardEvent("keydown", { key: "`", bubbles: true, cancelable: true });
      view.refs.queryEditor.element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe("class hierarchy", () => {
    it("is the base class of SelectListView", () => {
      expect(Object.getPrototypeOf(SelectListView)).toBe(InputDialogView);
    });
  });
});
