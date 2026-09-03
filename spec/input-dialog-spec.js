const InputDialog = require("../src/input-dialog");
const SelectList = require("../src/select-list");

describe("InputDialog", () => {
  let view;

  function createInputDialog(props) {
    return lumine.workspace.buildInputDialog(props);
  }

  beforeEach(() => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
  });

  afterEach(async () => {
    if (view) {
      await view.destroy();
      view = null;
    }
  });

  describe("public model API", () => {
    it("exposes its element, panel, query editor, and destruction state", async () => {
      view = createInputDialog({});

      expect(view.getElement()).toBe(view.element);
      expect(view.getPanel()).toBeDefined();
      expect(view.getPanelItem()).toBe(view);
      expect(view.getQueryEditor()).toBeDefined();
      expect(view.isDestroyed()).toBe(false);

      await view.destroy();
      expect(view.isDestroyed()).toBe(true);
      view = null;
    });

    it("publishes query changes through a Disposable event", () => {
      view = createInputDialog({});
      const changes = [];
      const subscription = view.onDidChangeQuery((change) => changes.push(change));

      view.getQueryEditor().setText("alpha");

      expect(changes.length).toBe(1);
      expect(changes[0].query).toBe("alpha");
      expect(changes[0].dialog).toBe(view);
      subscription.dispose();
    });

    it("owns cancellation instead of requiring a callback to hide it", () => {
      view = createInputDialog({});
      const cancellations = [];
      view.onDidCancel((event) => cancellations.push(event));
      view.show();

      view.cancel("escape");

      expect(view.isVisible()).toBe(false);
      expect(cancellations).toEqual([{ dialog: view, reason: "escape" }]);
    });

    it("offers named getters and setters for presentation state", async () => {
      const header = document.createElement("div");
      const content = document.createElement("div");
      view = createInputDialog({});

      await view.setStatus({ type: "warning", message: "Careful" });
      await view.setInfoMessage("Info");
      await view.setLoadingState({ message: "Loading", badge: 2 });
      await view.setPlaceholderText("Search");
      await view.setHeaderElement(header);
      await view.setContentElement(content);
      await view.setCrumb("Step");

      expect(view.getStatus()).toEqual({ type: "warning", message: "Careful" });
      expect(view.getInfoMessage()).toBe("Info");
      expect(view.getLoadingState()).toEqual({ message: "Loading", badge: 2 });
      expect(view.getPlaceholderText()).toBe("Search");
      expect(view.getHeaderElement()).toBe(header);
      expect(view.getContentElement()).toBe(content);
      expect(view.getCrumb()).toBe("Step");
    });
  });

  describe("rendering", () => {
    it("renders a query editor with the input-dialog root class and custom classes", () => {
      view = createInputDialog({ className: "my-package my-dialog" });
      expect(view.element.classList.contains("input-dialog")).toBe(true);
      expect(view.element.classList.contains("select-list")).toBe(false);
      expect(view.element.classList.contains("my-dialog")).toBe(true);
      expect(view.getQueryEditor()).toBeDefined();
      expect(view.element.querySelector("ol")).toBeNull();
    });

    it("hosts a caller-owned content element and preserves it across updates", async () => {
      const content = document.createElement("div");
      content.className = "dialog-body";
      view = createInputDialog({ contentElement: content });
      expect(view.element.contains(content)).toBe(true);

      await view.update({ infoMessage: "changed" });
      expect(view.element.contains(content)).toBe(true);

      const replacement = document.createElement("div");
      await view.update({ contentElement: replacement });
      expect(view.element.contains(content)).toBe(false);
      expect(view.element.contains(replacement)).toBe(true);
    });

    it("shows one message at a time, loading over status over info", async () => {
      view = createInputDialog({});
      await view.update({
        status: { type: "error", message: "boom" },
        infoMessage: "fyi",
        loadingMessage: "wait",
      });
      expect(view.component.refs.loadingMessage.textContent).toBe("wait");
      expect(view.component.refs.statusMessage).toBeUndefined();
      expect(view.component.refs.infoMessage).toBeUndefined();

      await view.update({ loadingMessage: null });
      expect(view.component.refs.statusMessage.textContent).toBe("boom");
      expect(view.component.refs.statusMessage.classList.contains("text-error")).toBe(true);

      // Clearing the overlay uncovers the resting line the dialog never lost.
      await view.update({ status: null });
      expect(view.component.refs.infoMessage.textContent).toBe("fyi");
    });

    it("clears a status on the next keystroke unless it is sticky", async () => {
      view = createInputDialog({});

      await view.update({ status: { type: "error", message: "Enter a value." } });
      view.getQueryEditor().setText("a");
      // The clear renders through the scheduler, so poll for the result
      // rather than awaiting the next update: the render may already have
      // flushed by the time we ask, and then there is no next update to wait
      // for.
      await conditionPromise(() => !view.component.refs.statusMessage);

      await view.update({ status: { message: "background", sticky: true } });
      view.getQueryEditor().setText("ab");
      // Nothing to poll for here — a sticky status is expected not to move —
      // so flush with an update of our own and then assert.
      await view.update({});
      expect(view.component.refs.statusMessage.textContent).toBe("background");
    });

    it("renders a header element above the query editor", () => {
      const header = document.createElement("label");
      header.textContent = "Prompt";
      view = createInputDialog({ headerElement: header });
      const children = Array.from(view.element.children);
      const headerIndex = children.indexOf(header);
      const editorIndex = children.findIndex((child) =>
        child.contains(view.getQueryEditor().element),
      );
      expect(headerIndex).toBe(0);
      expect(headerIndex).toBeLessThan(editorIndex);
    });
  });

  describe("confirm and cancel", () => {
    it("confirms with the raw query text", () => {
      const confirmed = [];
      view = createInputDialog({ didConfirm: (query) => confirmed.push(query) });
      view.getQueryEditor().setText("hello world");
      view.confirm();
      expect(confirmed).toEqual(["hello world"]);
    });

    it("invokes didCancel on cancel", () => {
      let cancelled = false;
      view = createInputDialog({ didCancel: () => (cancelled = true) });
      view.cancel();
      expect(cancelled).toBe(true);
    });

    it("reports query changes through didChangeQuery", () => {
      const queries = [];
      view = createInputDialog({ didChangeQuery: (query) => queries.push(query) });
      view.getQueryEditor().setText("abc");
      expect(queries).toEqual(["abc"]);
    });
  });

  describe("panel management", () => {
    it("shows and hides a modal panel and focuses the query editor", () => {
      view = createInputDialog({});
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
      view = createInputDialog({ didCancel: () => (cancelled = true) });
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
      view = createInputDialog({ willShow: () => willShowCalls++ });
      view.getQueryEditor().setText("stale");

      view.getPanel().show();

      expect(willShowCalls).toBe(1);
      expect(view.isVisible()).toBe(true);
      expect(view.element.contains(document.activeElement)).toBe(true);
      // Showing is showing, whoever did it: the dialog opens on an empty query.
      expect(view.getQuery()).toBe("");
    });

    it("selects a preserved query on show, so a keystroke still replaces it", () => {
      view = createInputDialog({ preserveQuery: true });
      view.getQueryEditor().setText("kept");

      view.getPanel().show();

      expect(view.getQueryEditor().getSelectedText()).toBe("kept");
    });

    it("carries the crumb prop on its panel and keeps it in sync", async () => {
      view = createInputDialog({ crumb: "Branches" });
      expect(view.getPanel().crumb).toBe("Branches");

      await view.update({ crumb: "Refs" });
      expect(view.panel.crumb).toBe("Refs");
    });

    it("enters a flow step without cancelling the dialog it covers", async () => {
      let cancelled = false;
      view = createInputDialog({ crumb: "Root", didCancel: () => (cancelled = true) });
      const step = createInputDialog({});
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
      view = createInputDialog({ className: "dialog-spec", crumb: "Dialog" });
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
      view = createInputDialog({ crumb: "Root", willShow: () => willShowCalls++ });
      const step = createInputDialog({});
      try {
        view.show();
        view.getQueryEditor().setText("query");
        step.show({ crumb: "Step" });
        expect(willShowCalls).toBe(1);

        expect(lumine.workspace.popModal()).toBe(true);

        expect(willShowCalls).toBe(2);
        expect(view.isVisible()).toBe(true);
        expect(view.getQueryEditor().getText()).toBe("query");
        expect(view.getQueryEditor().getSelectedText()).toBe("query");
        expect(view.element.contains(document.activeElement)).toBe(true);
        expect(lumine.workspace.getModalTrail()).toEqual(["Root"]);
      } finally {
        await step.destroy();
      }
    });
  });

  describe("explicit actions", () => {
    it("uses a primary command as confirmation and applies its disposition", async () => {
      let context;
      view = createInputDialog({
        commands: {
          "spec:accept-input": {
            description: "Accept the entered value.",
            didDispatch: (event) => (context = event.detail),
          },
        },
        actions: [
          {
            command: "spec:accept-input",
            context: "dialog",
            primary: true,
            disposition: "close",
          },
        ],
      });
      view.show({ query: "a value" });

      await view.confirm();

      expect(context.query).toBe("a value");
      expect(context.dialog).toBe(view);
      expect(view.isVisible()).toBe(false);
    });

    it("supports dynamic action registration on the full model", () => {
      view = createInputDialog({});
      const registration = view.addAction({
        command: "spec:temporary",
        context: "dialog",
        disposition: "stay",
      });

      expect(view.getActions().map(({ command }) => command)).toEqual(["spec:temporary"]);
      registration.dispose();
      expect(view.getActions()).toEqual([]);
    });

    it("resolves workspace action metadata while the dialog is detached", () => {
      const registration = lumine.commands.add(lumine.workspace.getElement(), {
        "spec:workspace-action": {
          description: "Run against the whole workspace.",
          didDispatch() {},
        },
      });
      view = createInputDialog({
        actions: [
          {
            command: "spec:workspace-action",
            context: "dialog",
            disposition: "stay",
            dispatch: "workspace",
          },
        ],
      });

      expect(view.getAvailableActions()[0].description).toBe("Run against the whole workspace.");
      registration.dispose();
    });

    it("uses the workspace action service without exposing a nested list", async () => {
      const dispatches = [];
      view = createInputDialog({
        className: "owner-dialog",
        commands: {
          "spec:stay": (event) => dispatches.push(event.detail.query),
        },
        actions: [
          {
            command: "spec:stay",
            context: "dialog",
            disposition: "stay",
          },
        ],
      });
      await view.show({ query: "kept" });

      expect(await view.showActions()).toBe(true);
      const actionList = lumine.workspace.getElement().querySelector(".select-list-actions");
      expect(actionList).not.toBeNull();
      expect(actionList.classList.contains("owner-dialog")).toBe(false);
      expect(view.itemActionsList).toBeUndefined();

      await lumine.commands.dispatch(actionList, "core:confirm");

      expect(dispatches).toEqual(["kept"]);
      expect(view.isVisible()).toBe(true);
    });
  });

  describe("data sources", () => {
    it("loads a snapshot on a fresh show and applies its publication", async () => {
      const load = jasmine.createSpy("load").and.callFake(({ query, parsedQuery, signal }) => {
        expect(query).toBe("seed");
        expect(parsedQuery).toEqual({ text: "seed", data: null });
        expect(signal).toEqual(jasmine.any(AbortSignal));
        return { infoMessage: "Loaded" };
      });
      view = createInputDialog({ source: { mode: "snapshot", load } });

      await view.show({ query: "seed" });

      expect(load).toHaveBeenCalledTimes(1);
      expect(view.getInfoMessage()).toBe("Loaded");
      expect(view.isLoading()).toBe(false);
    });
  });

  describe("focus policy", () => {
    it("keeps focus in the query editor when pressing non-interactive content", () => {
      const content = document.createElement("div");
      content.textContent = "static";
      view = createInputDialog({ contentElement: content });
      view.show();

      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      content.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it("lets interactive controls inside the content take focus", () => {
      const content = document.createElement("div");
      const input = document.createElement("input");
      content.appendChild(input);
      view = createInputDialog({ contentElement: content });
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
      view = createInputDialog({});
      view.show();
      const editorElement = view.getQueryEditor().element;
      const inner = editorElement.querySelector("input") || editorElement;
      spyOn(editorElement, "focus");

      const event = new FocusEvent("focusout", { bubbles: true, relatedTarget: inner });
      view.element.dispatchEvent(event);

      expect(editorElement.focus).not.toHaveBeenCalled();
    });
  });

  describe("typing", () => {
    it("lets a backtick through as a normal character", () => {
      view = createInputDialog({});
      const event = new KeyboardEvent("keydown", { key: "`", bubbles: true, cancelable: true });
      view.getQueryEditor().element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe("class hierarchy", () => {
    it("is the base class of SelectList", () => {
      expect(Object.getPrototypeOf(SelectList)).toBe(InputDialog);
    });
  });
});
