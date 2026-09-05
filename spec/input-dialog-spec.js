const InputDialog = require("../src/input-dialog");
const SelectList = require("../src/select-list");
const { buildKeydownEvent } = require("./keymap-spec-helpers/helpers");

describe("InputDialog", () => {
  let host, view;

  function createInputDialog(props = {}) {
    view = lumine.workspace.buildInputDialog(props);
    return view;
  }

  function createHostedInputDialog(props = {}, hostOptions = {}) {
    host = lumine.workspace.addInputDialog(props, hostOptions);
    view = host.getModel();
    return host;
  }

  function getActionPicker() {
    return lumine.workspace
      .getElement()
      .querySelector(".select-list-actions lumine-input-dialog")
      ?.getModel();
  }

  beforeEach(() => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
  });

  afterEach(async () => {
    if (host) {
      await host.destroy();
      host = null;
    }
    if (view && !view.isDestroyed()) {
      await view.destroy();
    }
    view = null;
  });

  describe("public model API", () => {
    it("lazily materializes a detached element and registers its query editor only while connected", async () => {
      const panelCount = lumine.workspace.getModalPanels().length;
      view = createInputDialog({});
      const queryEditor = view.getQueryEditor();

      expect(view.component).toBeNull();
      expect(view.element).toBeUndefined();
      expect(lumine.textEditors.roleFor(queryEditor)).toBeNull();
      expect(lumine.workspace.getModalPanels().length).toBe(panelCount);

      const element = view.getElement();
      expect(view.getElement()).toBe(element);
      expect(view.component).not.toBeNull();
      expect(element.isConnected).toBe(false);
      expect(lumine.textEditors.roleFor(queryEditor)).toBeNull();
      expect(lumine.workspace.getModalPanels().length).toBe(panelCount);

      lumine.workspace.getElement().appendChild(element);
      expect(lumine.textEditors.roleFor(queryEditor)).toBe("input");
      element.remove();
      expect(lumine.textEditors.roleFor(queryEditor)).toBeNull();

      expect(view.isDestroyed()).toBe(false);

      await view.destroy();
      expect(view.isDestroyed()).toBe(true);
      view = null;
    });

    it("does not expose modal lifecycle on the detached model", () => {
      view = createInputDialog({});

      for (const method of [
        "show",
        "hide",
        "toggle",
        "cancel",
        "isVisible",
        "getPanel",
        "getPanelItem",
        "showActions",
        "restoreQuery",
        "onDidChangeVisible",
        "onDidOpen",
        "onDidResume",
        "onDidHide",
        "onDidCancel",
        "getCrumb",
        "setCrumb",
      ]) {
        expect(view[method]).withContext(method).toBeUndefined();
      }
    });

    it("rejects modal options when building a detached model", () => {
      expect(() => createInputDialog({ crumb: "Step" })).toThrowError(
        TypeError,
        /'crumb' is a modal host option/,
      );
      expect(() =>
        createInputDialog({ panelItem: document.createElement("section") }),
      ).toThrowError(TypeError, /'panelItem' is a modal host option/);
      expect(() => createInputDialog({ className: "dialog-spec" })).toThrowError(
        TypeError,
        /'className' is a modal host option/,
      );
    });

    it("lets a host borrow the complete model through a caller-owned interactive item", async () => {
      view = createInputDialog({});
      const item = document.createElement("section");
      const button = document.createElement("button");
      item.appendChild(view.getElement());
      item.appendChild(button);
      host = lumine.workspace.addInputDialog(view, { item });
      const cancel = jasmine.createSpy("cancel");
      host.onDidCancel(cancel);

      expect(host.getModel()).toBe(view);
      expect(host.getPanel().getItem()).toBe(item);
      expect(host.getPanel().getElement().contains(view.getElement())).toBe(true);

      host.show();
      button.focus();
      await new Promise(requestAnimationFrame);
      expect(cancel).not.toHaveBeenCalled();
      expect(host.isVisible()).toBe(true);
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

    it("keeps host requests neutral while embedded", async () => {
      const panels = lumine.workspace.getModalPanels().slice();
      view = createInputDialog({
        commands: { "spec:stay": () => {} },
        actions: [{ command: "spec:stay", context: "dialog", disposition: "close" }],
      });
      view.setQuery("embedded");
      const element = view.getElement();

      await lumine.commands.dispatch(element, "core:cancel");
      await lumine.commands.dispatch(element, "select-list:actions");
      await lumine.commands.dispatch(element, "select-list:restore-query");
      await view.runAction("spec:stay");

      expect(view.getQuery()).toBe("embedded");
      expect(view.isDestroyed()).toBe(false);
      expect(lumine.workspace.getModalPanels()).toEqual(panels);
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

      expect(view.getStatus()).toEqual({ type: "warning", message: "Careful" });
      expect(view.getInfoMessage()).toBe("Info");
      expect(view.getLoadingState()).toEqual({ message: "Loading", badge: 2 });
      expect(view.getPlaceholderText()).toBe("Search");
      expect(view.getHeaderElement()).toBe(header);
      expect(view.getContentElement()).toBe(content);
    });
  });

  describe("rendering", () => {
    it("renders a query editor with the input-dialog root class", () => {
      view = createInputDialog({});
      const element = view.getElement();
      expect(element.classList.contains("input-dialog")).toBe(true);
      expect(element.classList.contains("select-list")).toBe(false);
      expect(view.getQueryEditor()).toBeDefined();
      expect(element.querySelector("ol")).toBeNull();
    });

    it("hosts a caller-owned content element and preserves it across updates", async () => {
      const content = document.createElement("div");
      content.className = "dialog-body";
      view = createInputDialog({ contentElement: content });
      expect(view.getElement().contains(content)).toBe(true);

      await view.update({ infoMessage: "changed" });
      expect(view.getElement().contains(content)).toBe(true);

      const replacement = document.createElement("div");
      await view.update({ contentElement: replacement });
      expect(view.getElement().contains(content)).toBe(false);
      expect(view.getElement().contains(replacement)).toBe(true);
    });

    it("shows one message at a time, loading over status over info", async () => {
      view = createInputDialog({});
      view.getElement();
      await view.update({
        status: { type: "error", message: "boom" },
        infoMessage: "fyi",
        loadingMessage: "wait",
      });
      expect(view.getElement().querySelector(".loading-message").textContent).toBe("wait");
      expect(view.getElement().querySelector(".status-message")).toBeNull();
      expect(view.getElement().querySelector(".info-message")).toBeNull();

      await view.update({ loadingMessage: null });
      expect(view.getElement().querySelector(".status-message").textContent).toBe("boom");
      expect(
        view.getElement().querySelector(".status-message").classList.contains("text-error"),
      ).toBe(true);

      // Clearing the overlay uncovers the resting line the dialog never lost.
      await view.update({ status: null });
      expect(view.getElement().querySelector(".info-message").textContent).toBe("fyi");
    });

    it("clears a status on the next keystroke unless it is sticky", async () => {
      view = createInputDialog({});
      view.getElement();

      await view.update({ status: { type: "error", message: "Enter a value." } });
      view.getQueryEditor().setText("a");
      // The clear renders through the scheduler, so poll for the result
      // rather than awaiting the next update: the render may already have
      // flushed by the time we ask, and then there is no next update to wait
      // for.
      await conditionPromise(() => !view.getElement().querySelector(".status-message"));

      await view.update({ status: { message: "background", sticky: true } });
      view.getQueryEditor().setText("ab");
      // Nothing to poll for here — a sticky status is expected not to move —
      // so flush with an update of our own and then assert.
      await view.update({});
      expect(view.getElement().querySelector(".status-message").textContent).toBe("background");
    });

    it("renders a header element above the query editor", () => {
      const header = document.createElement("label");
      header.textContent = "Prompt";
      view = createInputDialog({ headerElement: header });
      const children = Array.from(view.getElement().children);
      const headerIndex = children.indexOf(header);
      const editorIndex = children.findIndex((child) =>
        child.contains(view.getQueryEditor().getElement()),
      );
      expect(headerIndex).toBe(0);
      expect(headerIndex).toBeLessThan(editorIndex);
    });
  });

  describe("confirmation and query", () => {
    it("confirms with the raw query text", () => {
      const confirmed = [];
      view = createInputDialog({});
      view.onDidConfirm(({ query }) => confirmed.push(query));
      view.getQueryEditor().setText("hello world");
      view.confirm();
      expect(confirmed).toEqual(["hello world"]);
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
    it("keeps add lazy, then shows and hides a modal panel while focusing the query editor", () => {
      const panelCount = lumine.workspace.getModalPanels().length;
      createHostedInputDialog({});

      expect(host.getModel()).toBe(view);
      expect(host.getElement).toBeUndefined();
      expect(host.panel).toBeNull();
      expect(view.component).toBeNull();
      expect(host.isVisible()).toBe(false);
      expect(lumine.workspace.getModalPanels().length).toBe(panelCount);

      host.show();
      expect(host.isVisible()).toBe(true);
      expect(lumine.workspace.getModalPanels()).toContain(host.getPanel());
      expect(view.getElement().contains(document.activeElement)).toBe(true);
      expect(lumine.textEditors.roleFor(view.getQueryEditor())).toBe("input");

      host.hide();
      expect(host.isVisible()).toBe(false);
    });

    it("finishes cleanup when an onDidDestroy listener throws", async () => {
      view = createInputDialog({});
      const firstHost = lumine.workspace.addInputDialog(view);
      const panel = firstHost.getPanel();
      firstHost.onDidDestroy(() => {
        throw new Error("listener failed");
      });

      await expectAsync(firstHost.destroy()).toBeRejectedWithError("listener failed");
      expect(firstHost.isDestroyed()).toBe(true);
      expect(view.isDestroyed()).toBe(false);
      expect(lumine.workspace.getModalPanels()).not.toContain(panel);

      host = lumine.workspace.addInputDialog(view);
      expect(host.getModel()).toBe(view);
    });

    it("cancels when focus moves outside the dialog", async () => {
      // Window focus is a separate guard in the implementation. Pin it here so
      // an open DevTools window cannot turn an in-dialog focus test into a
      // window-blur test.
      spyOn(document, "hasFocus").and.returnValue(true);
      let cancelled = false;
      createHostedInputDialog({});
      host.onDidCancel(() => (cancelled = true));
      host.show();

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
      createHostedInputDialog({
        source: {
          mode: "snapshot",
          load({ signal: loadSignal }) {
            signal = loadSignal;
            return new Promise((resolve) => (finishLoad = resolve));
          },
        },
      });
      host.onDidChangeVisible(({ visible }) => visibility.push(visible));
      host.onDidOpen(() => host.cancel("open-handler"));

      void host.show();

      expect(host.isVisible()).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(visibility).toEqual([true, false]);
      finishLoad();
    });

    it("does not emit stale visibility when a source loader cancels synchronously", () => {
      const visibility = [];
      createHostedInputDialog({
        source: {
          mode: "snapshot",
          load() {
            host.cancel("loader");
          },
        },
      });
      host.onDidChangeVisible(({ visible }) => visibility.push(visible));

      void host.show();

      expect(host.isVisible()).toBe(false);
      expect(view.isLoading()).toBe(false);
      expect(visibility).toEqual([true, false]);
    });

    it("reports coherent visibility when onDidHide reopens the dialog", () => {
      const visibility = [];
      let reopen = true;
      createHostedInputDialog({});
      host.onDidChangeVisible(({ visible }) => visibility.push(visible));
      host.onDidHide(() => {
        if (!reopen) return;
        reopen = false;
        host.show();
      });
      host.show();

      host.hide();

      expect(host.isVisible()).toBe(true);
      expect(visibility).toEqual([true, false, true]);
    });

    it("does not cancel a session reopened from an external panel hide", () => {
      createHostedInputDialog({});
      const cancel = jasmine.createSpy("cancel");
      host.onDidCancel(cancel);
      host.onDidHide(() => {
        if (!host.isVisible()) host.show();
      });
      host.show();

      host.getPanel().hide();

      expect(host.isVisible()).toBe(true);
      expect(cancel).not.toHaveBeenCalled();
    });

    it("does not continue a stale open cycle after a nested hide and show", () => {
      const load = jasmine.createSpy("load");
      const visibility = [];
      let restart = true;
      let opens = 0;
      createHostedInputDialog({ source: { mode: "snapshot", load } });
      host.onDidOpen(() => opens++);
      host.onDidChangeVisible(({ visible }) => {
        visibility.push(visible);
        if (!visible || !restart) return;
        restart = false;
        host.hide();
        host.show();
      });

      host.show();

      expect(host.isVisible()).toBe(true);
      expect(visibility).toEqual([true, false, true]);
      expect(opens).toBe(1);
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe("modal flow integration", () => {
    it("runs the show side effects when the panel is shown from outside", () => {
      let openCalls = 0;
      createHostedInputDialog({});
      host.onDidOpen(() => openCalls++);
      view.getQueryEditor().setText("stale");
      const panel = host.getPanel();

      panel.show();

      expect(openCalls).toBe(1);
      expect(host.isVisible()).toBe(true);
      expect(view.getElement().contains(document.activeElement)).toBe(true);
      // Showing is showing, whoever did it: the dialog opens on an empty query.
      expect(view.getQuery()).toBe("");
    });

    it("captures the opener before an externally shown panel activates its focus trap", () => {
      createHostedInputDialog({});
      const panel = host.getPanel();
      const opener = document.createElement("button");
      lumine.workspace.getElement().appendChild(opener);
      opener.focus();

      panel.show();

      expect(view.getActionContext().opener).toBe(opener);
      opener.remove();
    });

    it("captures and keeps the opener when shown through the host", () => {
      createHostedInputDialog({});
      const opener = document.createElement("button");
      lumine.workspace.getElement().appendChild(opener);
      opener.focus();

      host.show();
      expect(view.getActionContext().opener).toBe(opener);
      host.show();
      expect(view.getActionContext().opener).toBe(opener);

      opener.remove();
    });

    it("selects a query seeded on show, so a keystroke still replaces it", () => {
      createHostedInputDialog({});

      host.show({ query: "kept" });

      expect(view.getQueryEditor().getSelectedText()).toBe("kept");
    });

    it("restores and selects the query remembered by the host", () => {
      createHostedInputDialog({});
      host.show({ query: "remembered" });
      host.hide();
      host.show();
      expect(view.getQuery()).toBe("");

      expect(host.restoreQuery()).toBe(true);
      expect(view.getQuery()).toBe("remembered");
      expect(view.getQueryEditor().getSelectedText()).toBe("remembered");
    });

    it("keeps the declared crumb on the host and accepts a per-show crumb", () => {
      createHostedInputDialog({}, { crumb: "Branches" });
      expect(host.getPanel().crumb).toBe("Branches");

      host.show({ crumb: true });
      expect(lumine.workspace.getModalTrail()).toEqual(["Branches"]);
      host.hide();

      host.show({ crumb: "Refs" });
      expect(lumine.workspace.getModalTrail()).toEqual(["Refs"]);
    });

    it("enters a flow step without cancelling the dialog it covers", async () => {
      let cancelled = false;
      createHostedInputDialog({}, { crumb: "Root" });
      host.onDidCancel(() => (cancelled = true));
      const stepHost = lumine.workspace.addInputDialog({});
      try {
        host.show();

        stepHost.show({ crumb: "Step" });

        expect(cancelled).toBe(false);
        expect(host.isVisible()).toBe(false);
        expect(stepHost.isVisible()).toBe(true);
        expect(lumine.workspace.getModalTrail()).toEqual(["Root", "Step"]);
      } finally {
        await stepHost.destroy();
      }
    });

    it("lets a breadcrumb navigate while the current dialog traps focus", async () => {
      let rootCancellations = 0;
      let stepCancellations = 0;
      createHostedInputDialog({}, { crumb: "Root" });
      host.onDidCancel(() => rootCancellations++);
      const stepHost = lumine.workspace.addInputDialog({});
      stepHost.onDidCancel(() => stepCancellations++);
      try {
        host.show();
        stepHost.show({ crumb: "Step" });
        const breadcrumbs = lumine.workspace.getElement().querySelector(".modal-breadcrumbs");
        const rootCrumb = breadcrumbs.querySelector(".modal-breadcrumb:not(.current)");
        const currentCrumb = breadcrumbs.querySelector(".modal-breadcrumb.current");

        const currentMouseDown = new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          cancelable: true,
        });
        currentCrumb.dispatchEvent(currentMouseDown);
        currentCrumb.dispatchEvent(
          new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }),
        );
        await new Promise(requestAnimationFrame);

        expect(currentMouseDown.defaultPrevented).toBe(true);
        expect(stepHost.isVisible()).toBe(true);
        expect(lumine.workspace.getModalTrail()).toEqual(["Root", "Step"]);
        expect(rootCancellations).toBe(0);
        expect(stepCancellations).toBe(0);

        rootCrumb.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }),
        );
        rootCrumb.dispatchEvent(
          new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }),
        );
        await new Promise(requestAnimationFrame);

        expect(host.isVisible()).toBe(true);
        expect(stepHost.isVisible()).toBe(false);
        expect(lumine.workspace.getModalTrail()).toEqual(["Root"]);
        expect(rootCancellations).toBe(0);
        expect(stepCancellations).toBe(0);
      } finally {
        await stepHost.destroy();
      }
    });

    it("offers its declared actions through the shared action service", async () => {
      createHostedInputDialog(
        {
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
        },
        { crumb: "Dialog", className: "dialog-spec" },
      );
      host.show();
      await host.showActions();

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
      createHostedInputDialog({}, { crumb: "Root" });
      host.onDidOpen(() => openCalls++);
      host.onDidResume(() => resumeCalls++);
      host.onDidChangeVisible(({ visible }) => visibility.push(visible));
      const stepHost = lumine.workspace.addInputDialog({});
      try {
        host.show();
        view.getQueryEditor().setText("query");
        stepHost.show({ crumb: "Step" });
        expect(openCalls).toBe(1);
        expect(resumeCalls).toBe(0);

        expect(lumine.workspace.popModal()).toBe(true);

        expect(openCalls).toBe(1);
        expect(resumeCalls).toBe(1);
        expect(host.isVisible()).toBe(true);
        expect(view.getQueryEditor().getText()).toBe("query");
        expect(view.getQueryEditor().getSelectedText()).toBe("query");
        expect(view.getElement().contains(document.activeElement)).toBe(true);
        expect(lumine.workspace.getModalTrail()).toEqual(["Root"]);
        expect(visibility).toEqual([true, false, true]);
      } finally {
        await stepHost.destroy();
      }
    });

    it("finalizes hidden parents when cancelling the top flow step", async () => {
      let sourceSignal;
      let finishLoad;
      const cancellations = [];
      createHostedInputDialog(
        {
          source: {
            mode: "snapshot",
            load({ signal }) {
              sourceSignal = signal;
              return new Promise((resolve) => (finishLoad = resolve));
            },
          },
        },
        { crumb: "Root" },
      );
      host.onDidCancel(({ reason }) => cancellations.push(reason));
      const stepHost = lumine.workspace.addInputDialog({});
      try {
        void host.show();
        await conditionPromise(() => sourceSignal != null);
        stepHost.show({ crumb: "Step" });

        stepHost.cancel("escape");

        expect(cancellations).toEqual(["modal-flow"]);
        expect(sourceSignal.aborted).toBe(true);
        expect(lumine.workspace.getModalTrail()).toEqual([]);
        finishLoad();
      } finally {
        await stepHost.destroy();
      }
    });

    it("finalizes a popped child without cancelling it", async () => {
      let sourceSignal;
      let finishLoad;
      let hides = 0;
      let cancellations = 0;
      createHostedInputDialog({}, { crumb: "Root" });
      const stepHost = lumine.workspace.addInputDialog({
        source: {
          mode: "snapshot",
          load({ signal }) {
            sourceSignal = signal;
            return new Promise((resolve) => (finishLoad = resolve));
          },
        },
      });
      stepHost.onDidHide(() => hides++);
      stepHost.onDidCancel(() => cancellations++);
      try {
        host.show();
        void stepHost.show({ crumb: "Step" });
        await conditionPromise(() => sourceSignal != null);

        lumine.workspace.popModal();

        expect(hides).toBe(1);
        expect(cancellations).toBe(0);
        expect(sourceSignal.aborted).toBe(true);
        finishLoad();
      } finally {
        await stepHost.destroy();
      }
    });
  });

  describe("explicit actions", () => {
    it("uses a primary command as confirmation and applies its disposition", async () => {
      let context;
      createHostedInputDialog({
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
      host.show({ query: "a value" });

      await view.confirm();

      expect(context.query).toBe("a value");
      expect(context.dialog).toBe(view);
      expect(host.isVisible()).toBe(false);
    });

    it("lets a closing action move focus outside before the modal is hidden", async () => {
      const destination = document.createElement("button");
      lumine.workspace.getElement().appendChild(destination);
      createHostedInputDialog({
        commands: {
          "spec:focus-destination": () => destination.focus(),
        },
        actions: [
          {
            command: "spec:focus-destination",
            context: "dialog",
            primary: true,
            disposition: "close",
          },
        ],
      });
      host.show();

      await view.confirm();

      expect(host.isVisible()).toBe(false);
      expect(document.activeElement).toBe(destination);
      destination.remove();
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
      createHostedInputDialog({
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
      host.show();

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
      createHostedInputDialog({
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
      host.show();
      const running = view.confirm();
      await conditionPromise(() => view.isActionPending("spec:slow"));
      await host.showActions();
      const picker = getActionPicker();
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
      createHostedInputDialog(
        {
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
        },
        { className: "owner-dialog" },
      );
      await host.show({ query: "kept" });

      expect(await host.showActions()).toBe(true);
      const actionList = lumine.workspace
        .getElement()
        .querySelector(".select-list-actions lumine-input-dialog");
      expect(actionList).not.toBeNull();
      expect(actionList.classList.contains("owner-dialog")).toBe(false);
      await lumine.commands.dispatch(actionList, "core:confirm");

      expect(dispatches).toEqual(["kept"]);
      expect(host.isVisible()).toBe(true);
    });

    it("keeps a selected danger action red", async () => {
      createHostedInputDialog({
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
      host.show();
      await host.showActions();
      const picker = getActionPicker();
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
      createHostedInputDialog(
        {
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
        },
        { className: "owner-dialog" },
      );
      try {
        host.show();
        await host.showActions();
        let picker = getActionPicker();

        lumine.keymaps.handleKeyboardEvent(
          buildKeydownEvent({
            key: "o",
            ctrlKey: true,
            altKey: true,
            target: picker.getQueryEditor().getElement(),
          }),
        );
        await conditionPromise(() => dispatches.length === 1);
        expect(dispatches).toEqual(["alternate"]);

        await host.showActions();
        picker = getActionPicker();
        await picker.selectItemById("spec:alternate");
        lumine.keymaps.handleKeyboardEvent(
          buildKeydownEvent({ key: "Enter", target: picker.getQueryEditor().getElement() }),
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
      createHostedInputDialog({
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
      host.onDidCancel(({ reason }) => cancellationReasons.push(reason));
      host.onDidHide(() => hides++);
      void host.show();
      await conditionPromise(() => sourceSignal != null);
      await host.showActions();
      const picker = getActionPicker();

      await lumine.commands.dispatch(picker.getElement(), "core:cancel");

      expect(cancellationReasons).toEqual(["modal-flow"]);
      expect(hides).toBe(1);
      expect(sourceSignal.aborted).toBe(true);
      expect(host.isVisible()).toBe(false);
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
      createHostedInputDialog({ source: { mode: "snapshot", load } });

      await host.show({ query: "seed" });

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
    function panelRect() {
      return {
        x: 100,
        y: 50,
        left: 100,
        top: 50,
        right: 300,
        bottom: 150,
        width: 200,
        height: 100,
        toJSON() {},
      };
    }

    it("lets an outside mousedown through and cancels after the event", async () => {
      spyOn(document, "hasFocus").and.returnValue(true);
      const cancellations = [];
      const click = jasmine.createSpy("click");
      const outside = document.createElement("div");
      outside.addEventListener("click", click);
      lumine.workspace.getElement().appendChild(outside);
      createHostedInputDialog({});
      host.onDidCancel(({ reason }) => cancellations.push(reason));
      host.show();
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        cancelable: true,
      });

      outside.dispatchEvent(event);
      outside.dispatchEvent(
        new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }),
      );
      await new Promise(requestAnimationFrame);

      expect(event.defaultPrevented).toBe(false);
      expect(click).toHaveBeenCalled();
      expect(cancellations).toEqual(["click-outside"]);
      expect(host.isVisible()).toBe(false);
      outside.remove();
    });

    it("treats the panel's backdrop pseudo-element as an outside click", async () => {
      spyOn(document, "hasFocus").and.returnValue(true);
      const cancellations = [];
      createHostedInputDialog({});
      host.onDidCancel(({ reason }) => cancellations.push(reason));
      host.show();
      const panelElement = host.getPanel().getElement();
      spyOn(panelElement, "getBoundingClientRect").and.returnValue(panelRect());

      panelElement.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 20,
          clientY: 200,
        }),
      );
      await new Promise(requestAnimationFrame);

      expect(cancellations).toEqual(["click-outside"]);
      expect(host.isVisible()).toBe(false);
    });

    it("keeps a panel pseudo-element click inside the panel rectangle", async () => {
      spyOn(document, "hasFocus").and.returnValue(true);
      const cancellations = [];
      createHostedInputDialog({});
      host.onDidCancel(({ reason }) => cancellations.push(reason));
      host.show();
      const panelElement = host.getPanel().getElement();
      spyOn(panelElement, "getBoundingClientRect").and.returnValue(panelRect());

      panelElement.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 150,
          clientY: 100,
        }),
      );
      await new Promise(requestAnimationFrame);

      expect(cancellations).toEqual([]);
      expect(host.isVisible()).toBe(true);
    });

    it("keeps focus in the query editor when pressing non-interactive content", () => {
      const content = document.createElement("div");
      content.textContent = "static";
      createHostedInputDialog({ contentElement: content });
      host.show();

      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      content.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it("lets interactive controls inside the content take focus", () => {
      const content = document.createElement("div");
      const input = document.createElement("input");
      content.appendChild(input);
      createHostedInputDialog({ contentElement: content });
      host.show();

      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);

      input.focus();
      expect(document.activeElement).toBe(input);
    });

    it("does not refocus when focus moves into the query editor's own subtree", () => {
      // Refocusing here would re-fire focusout and recurse (RangeError). The
      // guard skips the refocus when the new focus target is inside the editor.
      createHostedInputDialog({});
      host.show();
      const editorElement = view.getQueryEditor().getElement();
      const inner = editorElement.querySelector("input") || editorElement;
      spyOn(editorElement, "focus");

      const event = new FocusEvent("focusout", { bubbles: true, relatedTarget: inner });
      view.getElement().dispatchEvent(event);

      expect(editorElement.focus).not.toHaveBeenCalled();
    });
  });

  describe("typing", () => {
    it("lets a backtick through as a normal character", () => {
      view = createInputDialog({});
      const event = new KeyboardEvent("keydown", { key: "`", bubbles: true, cancelable: true });
      view.getQueryEditor().getElement().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe("class hierarchy", () => {
    it("is the base class of SelectList", () => {
      expect(Object.getPrototypeOf(SelectList)).toBe(InputDialog);
    });
  });
});
