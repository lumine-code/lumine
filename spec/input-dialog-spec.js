const InputDialog = require("../src/input-dialog");
const SelectList = require("../src/select-list");
const { buildKeydownEvent } = require("./keymap-spec-helpers/helpers");

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

    it("uses a caller-owned panel item without narrowing the dialog model", () => {
      const panelItem = document.createElement("section");
      view = createInputDialog({ panelItem });

      expect(view.getPanelItem()).toBe(panelItem);
      expect(view.getElement()).not.toBe(panelItem);
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
      view = createInputDialog({});
      view.onDidConfirm(({ query }) => confirmed.push(query));
      view.getQueryEditor().setText("hello world");
      view.confirm();
      expect(confirmed).toEqual(["hello world"]);
    });

    it("invokes didCancel on cancel", () => {
      let cancelled = false;
      view = createInputDialog({});
      view.onDidCancel(() => (cancelled = true));
      view.cancel();
      expect(cancelled).toBe(true);
    });

    it("reports query changes through didChangeQuery", () => {
      const queries = [];
      view = createInputDialog({});
      view.onDidChangeQuery(({ query }) => queries.push(query));
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
      expect(lumine.workspace.getModalPanels()).toContain(view.getPanel());
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
      view = createInputDialog({});
      view.onDidCancel(() => (cancelled = true));
      view.show();

      const outside = document.createElement("input");
      lumine.views.getView(lumine.workspace).appendChild(outside);
      outside.focus();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      outside.remove();
      expect(cancelled).toBe(true);
    });

    it("does not reopen a source after an onDidOpen cancellation", async () => {
      let signal;
      let finishLoad;
      const visibility = [];
      view = createInputDialog({
        source: {
          mode: "snapshot",
          load({ signal: loadSignal }) {
            signal = loadSignal;
            return new Promise((resolve) => (finishLoad = resolve));
          },
        },
      });
      view.onDidChangeVisible(({ visible }) => visibility.push(visible));
      view.onDidOpen(() => view.cancel("open-handler"));

      void view.show();

      expect(view.isVisible()).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(visibility).toEqual([true, false]);
      finishLoad();
    });

    it("does not emit stale visibility when a source loader cancels synchronously", () => {
      const visibility = [];
      view = createInputDialog({
        source: {
          mode: "snapshot",
          load() {
            view.cancel("loader");
          },
        },
      });
      view.onDidChangeVisible(({ visible }) => visibility.push(visible));

      void view.show();

      expect(view.isVisible()).toBe(false);
      expect(view.isLoading()).toBe(false);
      expect(visibility).toEqual([true, false]);
    });

    it("reports coherent visibility when onDidHide reopens the dialog", () => {
      const visibility = [];
      let reopen = true;
      view = createInputDialog({});
      view.onDidChangeVisible(({ visible }) => visibility.push(visible));
      view.onDidHide(() => {
        if (!reopen) return;
        reopen = false;
        view.show();
      });
      view.show();

      view.hide();

      expect(view.isVisible()).toBe(true);
      expect(visibility).toEqual([true, false, true]);
    });

    it("does not continue a stale open cycle after a nested hide and show", () => {
      const load = jasmine.createSpy("load");
      const visibility = [];
      let restart = true;
      let opens = 0;
      view = createInputDialog({ source: { mode: "snapshot", load } });
      view.onDidOpen(() => opens++);
      view.onDidChangeVisible(({ visible }) => {
        visibility.push(visible);
        if (!visible || !restart) return;
        restart = false;
        view.hide();
        view.show();
      });

      view.show();

      expect(view.isVisible()).toBe(true);
      expect(visibility).toEqual([true, false, true]);
      expect(opens).toBe(1);
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe("modal flow integration", () => {
    it("runs the show side effects when the panel is shown from outside", () => {
      let openCalls = 0;
      view = createInputDialog({});
      view.onDidOpen(() => openCalls++);
      view.getQueryEditor().setText("stale");
      const opener = document.createElement("button");
      lumine.workspace.getElement().appendChild(opener);
      opener.focus();

      view.getPanel().show();

      expect(openCalls).toBe(1);
      expect(view.isVisible()).toBe(true);
      expect(view.element.contains(document.activeElement)).toBe(true);
      // Showing is showing, whoever did it: the dialog opens on an empty query.
      expect(view.getQuery()).toBe("");
      expect(view.getActionContext().opener).toBe(opener);
      view.show();
      expect(view.getActionContext().opener).toBe(opener);
      opener.remove();
    });

    it("selects a query seeded on show, so a keystroke still replaces it", () => {
      view = createInputDialog({});

      view.show({ query: "kept" });

      expect(view.getQueryEditor().getSelectedText()).toBe("kept");
    });

    it("carries the crumb prop on its panel and keeps it in sync", async () => {
      view = createInputDialog({ crumb: "Branches" });
      expect(view.getPanel().crumb).toBe("Branches");

      await view.update({ crumb: "Refs" });
      expect(view.getPanel().crumb).toBe("Refs");
    });

    it("enters a flow step without cancelling the dialog it covers", async () => {
      let cancelled = false;
      view = createInputDialog({ crumb: "Root" });
      view.onDidCancel(() => (cancelled = true));
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

    it("offers its declared actions through the shared action service", async () => {
      view = createInputDialog({
        className: "dialog-spec",
        crumb: "Dialog",
        commands: {
          "dialog-spec:clear": {
            description: "Clear the field and start over",
            didDispatch() {},
          },
        },
        actions: [
          {
            command: "dialog-spec:clear",
            context: "dialog",
            disposition: "stay",
          },
        ],
      });
      view.show();
      await view.showActions();

      expect(view.getAvailableActions().map((action) => action.command)).toEqual([
        "dialog-spec:clear",
      ]);
      expect(lumine.workspace.getElement().querySelector(".select-list-actions")).not.toBeNull();
      expect(lumine.workspace.getModalTrail()).toEqual(["Dialog", "Actions"]);
    });

    it("reports a resume rather than a second fresh open when flow navigates back", async () => {
      let openCalls = 0;
      let resumeCalls = 0;
      const visibility = [];
      view = createInputDialog({ crumb: "Root" });
      view.onDidOpen(() => openCalls++);
      view.onDidResume(() => resumeCalls++);
      view.onDidChangeVisible(({ visible }) => visibility.push(visible));
      const step = createInputDialog({});
      try {
        view.show();
        view.getQueryEditor().setText("query");
        step.show({ crumb: "Step" });
        expect(openCalls).toBe(1);
        expect(resumeCalls).toBe(0);

        expect(lumine.workspace.popModal()).toBe(true);

        expect(openCalls).toBe(1);
        expect(resumeCalls).toBe(1);
        expect(view.isVisible()).toBe(true);
        expect(view.getQueryEditor().getText()).toBe("query");
        expect(view.getQueryEditor().getSelectedText()).toBe("query");
        expect(view.element.contains(document.activeElement)).toBe(true);
        expect(lumine.workspace.getModalTrail()).toEqual(["Root"]);
        expect(visibility).toEqual([true, false, true]);
      } finally {
        await step.destroy();
      }
    });

    it("finalizes hidden parents when cancelling the top flow step", async () => {
      let sourceSignal;
      let finishLoad;
      const cancellations = [];
      view = createInputDialog({
        crumb: "Root",
        source: {
          mode: "snapshot",
          load({ signal }) {
            sourceSignal = signal;
            return new Promise((resolve) => (finishLoad = resolve));
          },
        },
      });
      view.onDidCancel(({ reason }) => cancellations.push(reason));
      const step = createInputDialog({});
      try {
        void view.show();
        await conditionPromise(() => sourceSignal != null);
        step.show({ crumb: "Step" });

        step.cancel("escape");

        expect(cancellations).toEqual(["modal-flow"]);
        expect(sourceSignal.aborted).toBe(true);
        expect(lumine.workspace.getModalTrail()).toEqual([]);
        finishLoad();
      } finally {
        await step.destroy();
      }
    });

    it("finalizes a popped child without cancelling it", async () => {
      let sourceSignal;
      let finishLoad;
      let hides = 0;
      let cancellations = 0;
      view = createInputDialog({ crumb: "Root" });
      const step = createInputDialog({
        source: {
          mode: "snapshot",
          load({ signal }) {
            sourceSignal = signal;
            return new Promise((resolve) => (finishLoad = resolve));
          },
        },
      });
      step.onDidHide(() => hides++);
      step.onDidCancel(() => cancellations++);
      try {
        view.show();
        void step.show({ crumb: "Step" });
        await conditionPromise(() => sourceSignal != null);

        lumine.workspace.popModal();

        expect(hides).toBe(1);
        expect(cancellations).toBe(0);
        expect(sourceSignal.aborted).toBe(true);
        finishLoad();
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

    it("reports the reason when a primary action is disabled", async () => {
      view = createInputDialog({
        commands: { "spec:disabled": () => {} },
        actions: [
          {
            command: "spec:disabled",
            context: "dialog",
            disposition: "stay",
            primary: true,
            enabled: false,
            disabledReason: "Choose a value first.",
          },
        ],
      });

      const result = await view.confirm();

      expect(result.status).toBe("disabled");
      expect(view.getStatus()).toEqual({ type: "warning", message: "Choose a value first." });
    });

    it("awaits an asynchronous confirmation descriptor", async () => {
      const confirm = spyOn(lumine.applicationDelegate, "confirm").and.resolveTo(0);
      view = createInputDialog({
        commands: { "spec:confirmed": () => {} },
        actions: [
          {
            command: "spec:confirmed",
            context: "dialog",
            disposition: "stay",
            primary: true,
            confirm: async () => ({ message: "Async question", confirmText: "Proceed" }),
          },
        ],
      });

      const result = await view.confirm();

      expect(result.status).toBe("success");
      expect(confirm.calls.mostRecent().args[0].message).toBe("Async question");
      expect(confirm.calls.mostRecent().args[0].buttons).toEqual(["Proceed", "Cancel"]);
    });

    it("does not open a late confirmation after destruction", async () => {
      const confirm = spyOn(lumine.applicationDelegate, "confirm").and.resolveTo(0);
      let finishDescriptor;
      view = createInputDialog({
        commands: { "spec:confirmed": () => {} },
        actions: [
          {
            command: "spec:confirmed",
            context: "dialog",
            disposition: "stay",
            confirm: () => new Promise((resolve) => (finishDescriptor = resolve)),
          },
        ],
      });
      const running = view.runAction("spec:confirmed");
      await conditionPromise(() => finishDescriptor != null);

      await view.destroy();
      view = null;
      finishDescriptor({ message: "Too late" });

      await expectAsync(running).toBeResolvedTo(jasmine.objectContaining({ status: "aborted" }));
      await Promise.resolve();
      expect(confirm).not.toHaveBeenCalled();
    });

    it("contains action failures at the UI command boundary after reporting them", async () => {
      view = createInputDialog({
        commands: {
          "spec:fail": async () => {
            throw new Error("Action failed");
          },
        },
        actions: [
          {
            command: "spec:fail",
            context: "dialog",
            disposition: "stay",
            primary: true,
          },
        ],
      });

      await expectAsync(lumine.commands.dispatch(view.getElement(), "core:confirm")).toBeResolved();
      expect(view.getStatus()).toEqual({ type: "error", message: "Action failed" });
      await expectAsync(view.runAction("spec:fail")).toBeRejectedWithError("Action failed");
    });

    it("exposes pending state, shows progress, and deduplicates primary submission", async () => {
      let finish;
      const command = jasmine
        .createSpy("command")
        .and.callFake(() => new Promise((resolve) => (finish = resolve)));
      view = createInputDialog({
        commands: { "spec:slow": command },
        actions: [
          {
            command: "spec:slow",
            context: "dialog",
            disposition: "stay",
            primary: true,
          },
        ],
      });
      view.show();

      const first = view.confirm();
      await conditionPromise(() => view.isActionPending("spec:slow"));
      const second = view.confirm();
      await conditionPromise(() => view.getElement().querySelector(".action-pending-spinner"));

      expect(command).toHaveBeenCalledTimes(1);
      expect(view.getAvailableActions()[0].pending).toBe(true);
      expect(view.getElement().getAttribute("aria-busy")).toBe("true");
      expect(view.getElement().querySelector(".action-pending-spinner")).not.toBeNull();

      finish();
      await Promise.all([first, second]);
      await conditionPromise(() => !view.getElement().querySelector(".action-pending-spinner"));
      expect(view.isActionPending()).toBe(false);
      expect(view.getAvailableActions()[0].pending).toBe(false);
      expect(view.getElement().hasAttribute("aria-busy")).toBe(false);
    });

    it("refreshes pending rows while the shared action picker is open", async () => {
      let finish;
      view = createInputDialog({
        commands: {
          "spec:slow": () => new Promise((resolve) => (finish = resolve)),
        },
        actions: [
          {
            command: "spec:slow",
            context: "dialog",
            disposition: "stay",
            primary: true,
          },
        ],
      });
      view.show();
      const running = view.confirm();
      await conditionPromise(() => view.isActionPending("spec:slow"));
      await view.showActions();
      const picker = lumine.workspace.getElement().querySelector(".select-list-actions").getModel();
      expect(picker.getElement().querySelector('[aria-busy="true"]').textContent).toContain(
        "In progress…",
      );

      finish();
      await running;
      await conditionPromise(
        () =>
          picker.getElement().querySelector('[role="option"]')?.getAttribute("aria-busy") == null,
      );
      expect(picker.getElement().textContent).not.toContain("In progress…");
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

    it("lets an action registration be disposed after the dialog", async () => {
      view = createInputDialog({});
      const registration = view.addAction({
        command: "spec:temporary",
        context: "dialog",
        disposition: "stay",
      });
      await view.destroy();
      view = null;

      expect(() => registration.dispose()).not.toThrow();
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
      await lumine.commands.dispatch(actionList, "core:confirm");

      expect(dispatches).toEqual(["kept"]);
      expect(view.isVisible()).toBe(true);
    });

    it("keeps a selected danger action red", async () => {
      view = createInputDialog({
        commands: {
          "spec:keep": () => {},
          "spec:trash": () => {},
        },
        actions: [
          { command: "spec:keep", context: "dialog", disposition: "stay" },
          {
            command: "spec:trash",
            context: "dialog",
            disposition: "stay",
            tone: "danger",
          },
        ],
      });
      view.show();
      await view.showActions();
      const picker = lumine.workspace.getElement().querySelector(".select-list-actions").getModel();
      await picker.selectItemById("spec:trash");
      const row = picker.getElement().querySelector("[role='option'].text-error.selected");
      const probe = document.createElement("span");
      probe.style.color = "var(--text-color-error)";
      lumine.workspace.getElement().appendChild(probe);

      expect(row).not.toBeNull();
      expect(getComputedStyle(row).color).toBe(getComputedStyle(probe).color);
      probe.remove();
    });

    it("bridges owner keybindings without making Enter run the owner's primary action", async () => {
      const dispatches = [];
      const keymaps = lumine.keymaps.add("input-dialog-action-spec", {
        ".owner-dialog lumine-text-editor[mini]": {
          "ctrl-alt-o": "spec:alternate",
        },
      });
      view = createInputDialog({
        className: "owner-dialog",
        commands: {
          "spec:primary": () => dispatches.push("primary"),
          "spec:alternate": () => dispatches.push("alternate"),
        },
        actions: [
          {
            command: "spec:primary",
            context: "dialog",
            disposition: "stay",
            primary: true,
          },
          { command: "spec:alternate", context: "dialog", disposition: "stay" },
        ],
      });
      try {
        view.show();
        await view.showActions();
        let picker = lumine.workspace.getElement().querySelector(".select-list-actions").getModel();

        lumine.keymaps.handleKeyboardEvent(
          buildKeydownEvent({
            key: "o",
            ctrlKey: true,
            altKey: true,
            target: picker.getQueryEditor().element,
          }),
        );
        await conditionPromise(() => dispatches.length === 1);
        expect(dispatches).toEqual(["alternate"]);

        await view.showActions();
        picker = lumine.workspace.getElement().querySelector(".select-list-actions").getModel();
        await picker.selectItemById("spec:alternate");
        lumine.keymaps.handleKeyboardEvent(
          buildKeydownEvent({ key: "Enter", target: picker.getQueryEditor().element }),
        );
        await conditionPromise(() => dispatches.length === 2);
        expect(dispatches).toEqual(["alternate", "alternate"]);
      } finally {
        keymaps.dispose();
      }
    });

    it("finalizes a suspended owner when the action picker is cancelled", async () => {
      let sourceSignal;
      let finishLoad;
      const cancellationReasons = [];
      let hides = 0;
      view = createInputDialog({
        source: {
          mode: "snapshot",
          load({ signal }) {
            sourceSignal = signal;
            return new Promise((resolve) => (finishLoad = resolve));
          },
        },
        commands: { "spec:stay": () => {} },
        actions: [{ command: "spec:stay", context: "dialog", disposition: "stay" }],
      });
      view.onDidCancel(({ reason }) => cancellationReasons.push(reason));
      view.onDidHide(() => hides++);
      void view.show();
      await conditionPromise(() => sourceSignal != null);
      await view.showActions();
      const picker = lumine.workspace.getElement().querySelector(".select-list-actions").getModel();

      picker.cancel("escape");

      expect(cancellationReasons).toEqual(["modal-flow"]);
      expect(hides).toBe(1);
      expect(sourceSignal.aborted).toBe(true);
      expect(view.isVisible()).toBe(false);
      finishLoad();
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

    it("keeps the previous source when a replacement is invalid", () => {
      const source = { mode: "snapshot", load() {} };
      view = createInputDialog({ source });

      expect(() => view.setSource({ mode: "invalid", load() {} })).toThrowError(TypeError);
      expect(view.getSource()).toBe(source);
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
