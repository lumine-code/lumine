const { CompositeDisposable } = require("lumine");
const { humanizeKeystroke } = require("@lumine-code/underscore-plus");
// The component is an npm package that consumes the Lumine API, so it can only
// run inside the editor — which is also where its contract lives, since
// packages reach it through `lumine.workspace.buildSelectList`. Its own repo
// keeps the jsdom tests for the pure render helpers.
const { SelectListView } = require("@lumine-code/select-list");

describe("SelectListView", () => {
  let view;

  function textItemView(props = {}) {
    return new SelectListView({
      items: ["one", "two", "three"],
      elementForItem: (item) => {
        const li = document.createElement("li");
        li.textContent = item;
        return li;
      },
      ...props,
    });
  }

  function listTexts() {
    return Array.from(view.element.querySelectorAll("li"), (li) => li.textContent);
  }

  async function nextUpdate() {
    await SelectListView.getScheduler().getNextUpdatePromise();
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

  describe("rendering and filtering", () => {
    it("renders all items initially and filters them as the query changes", async () => {
      view = textItemView();
      expect(listTexts()).toEqual(["one", "two", "three"]);

      view.refs.queryEditor.setText("tw");
      await nextUpdate();
      expect(listTexts()).toEqual(["two"]);

      view.refs.queryEditor.setText("");
      await nextUpdate();
      expect(listTexts()).toEqual(["one", "two", "three"]);
    });

    it("filters via filterKeyForItem for object items", async () => {
      view = new SelectListView({
        items: [{ name: "alpha" }, { name: "beta" }],
        filterKeyForItem: (item) => item.name,
        elementForItem: (item) => {
          const li = document.createElement("li");
          li.textContent = item.name;
          return li;
        },
      });

      view.refs.queryEditor.setText("bet");
      await nextUpdate();
      expect(listTexts()).toEqual(["beta"]);
    });

    it("keeps an adopted element returned by elementForItem", async () => {
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      const elementRegistration = lumine.elements.addWindow(frame.contentWindow);
      const documentRegistration = lumine.views.registerDocument(frame.contentDocument);
      const itemElement = document.createElement("li");
      itemElement.textContent = "adopted";
      frame.contentDocument.adoptNode(itemElement);

      try {
        view = new SelectListView({
          document: frame.contentDocument,
          items: ["one"],
          elementForItem: () => itemElement,
        });

        expect(view.element.querySelector("li")).toBe(itemElement);
      } finally {
        await view?.destroy();
        view = null;
        documentRegistration.dispose();
        elementRegistration.dispose();
        frame.remove();
      }
    });

    it("renders standalone separators before items selected by id", async () => {
      view = textItemView({ separatorIds: ["two"] });

      let separator = view.element.querySelector(".select-list-separator");
      expect(separator.tagName).toBe("LI");
      expect(separator.getAttribute("role")).toBe("separator");
      expect(separator.previousElementSibling.textContent).toBe("one");
      expect(separator.nextElementSibling.textContent).toBe("two");
      expect(view.items).toEqual(["one", "two", "three"]);

      await view.selectNext();
      expect(view.getSelectedItem()).toBe("two");
      expect(view.element.querySelector("li.selected").textContent).toBe("two");

      await view.update({ separatorIds: ["three"] });
      separator = view.element.querySelector(".select-list-separator");
      expect(separator.previousElementSibling.textContent).toBe("two");
      expect(separator.nextElementSibling.textContent).toBe("three");
    });

    it("supports custom item identifiers for separators", () => {
      const items = [{ name: "alpha" }, { name: "beta" }];
      view = new SelectListView({
        items,
        separatorIds: ["BETA"],
        idForItem: (item) => item.name.toUpperCase(),
        filterKeyForItem: (item) => item.name,
        elementForItem: (item) => ({ primary: item.name }),
      });

      const separator = view.element.querySelector(".select-list-separator");
      expect(separator.previousElementSibling.textContent).toBe("alpha");
      expect(separator.nextElementSibling.textContent).toBe("beta");
    });

    it("limits the rendered items to a maxResults batch behind the Show more row", () => {
      view = textItemView({ maxResults: 2 });
      expect(listTexts()).toEqual(["one", "two", "Show more…"]);
    });

    it("renders emptyMessage when no items match", async () => {
      view = textItemView({ emptyMessage: "nothing here" });
      view.refs.queryEditor.setText("zzz");
      await nextUpdate();
      expect(view.refs.emptyMessage.textContent).toBe("nothing here");
    });

    it("renders two-line items from {primary, secondary} descriptors", () => {
      view = new SelectListView({
        items: ["item"],
        elementForItem: (item) => ({ primary: item, secondary: "detail" }),
      });
      const li = view.element.querySelector("li");
      expect(li.classList.contains("two-lines")).toBe(true);
      expect(li.querySelector(".primary-line").textContent).toBe("item");
      expect(li.querySelector(".secondary-line").textContent).toBe("detail");
    });

    it("passes matchIndices aligned with the filter key to elementForItem", async () => {
      view = new SelectListView({
        items: ["abc", "xyz"],
        elementForItem: (item, { filterKey, matchIndices, highlight }) => {
          const li = document.createElement("li");
          // Handed back explicitly rather than defaulted, so the assertion is
          // about the indices lining up with the filter key.
          li.appendChild(highlight(filterKey, matchIndices));
          return li;
        },
      });

      view.refs.queryEditor.setText("ac");
      await nextUpdate();
      const matches = view.element.querySelectorAll(".character-match");
      expect(Array.from(matches, (m) => m.textContent)).toEqual(["a", "c"]);
    });

    it("hands a descriptor's didRender the finished element", async () => {
      const rendered = [];
      view = new SelectListView({
        items: ["one", "two"],
        elementForItem: (item) => ({
          primary: item,
          didRender: (li) => {
            li.dataset.item = item;
            rendered.push(li);
          },
        }),
      });

      await nextUpdate();
      expect(rendered.length).toBe(2);
      expect(rendered[0].tagName).toBe("LI");
      expect(Array.from(view.element.querySelectorAll("li"), (li) => li.dataset.item)).toEqual([
        "one",
        "two",
      ]);
    });

    it("passes a highlight function bound to the item's own match indices", async () => {
      view = new SelectListView({
        items: ["abc", "xyz"],
        elementForItem: (item, { filterKey, highlight }) => {
          const li = document.createElement("li");
          li.appendChild(highlight(filterKey));
          return li;
        },
      });

      view.refs.queryEditor.setText("ac");
      await nextUpdate();
      const matches = view.element.querySelectorAll(".character-match");
      expect(Array.from(matches, (m) => m.textContent)).toEqual(["a", "c"]);
    });

    it("lets highlight take explicit indices, for callers that shift offsets", async () => {
      view = new SelectListView({
        items: ["abc"],
        elementForItem: (item, { highlight }) => {
          const li = document.createElement("li");
          li.appendChild(highlight(`>${item}`, [1, 3]));
          return li;
        },
      });

      await nextUpdate();
      const matches = view.element.querySelectorAll(".character-match");
      expect(Array.from(matches, (m) => m.textContent)).toEqual(["a", "c"]);
    });

    it("does not compute match indices unless highlight is called without them", async () => {
      const getMatchIndicesSpy = spyOn(
        SelectListView.prototype,
        "getMatchIndices",
      ).and.callThrough();

      view = new SelectListView({
        items: ["abc"],
        elementForItem: (item, { highlight }) => {
          const li = document.createElement("li");
          li.appendChild(highlight(item, [0]));
          return li;
        },
      });

      await nextUpdate();
      expect(getMatchIndicesSpy).not.toHaveBeenCalled();
    });

    it("provides highlight on the re-render path as well", async () => {
      view = new SelectListView({
        // Forces the IntersectionObserver path, so re-rendering a row goes
        // through renderItemAtIndex rather than a full renderItems pass.
        initiallyVisibleItemCount: 1,
        items: ["abc", "abd"],
        elementForItem: (item, { highlight }) => {
          const li = document.createElement("li");
          li.appendChild(highlight(item));
          return li;
        },
      });

      view.refs.queryEditor.setText("ab");
      await nextUpdate();
      await view.selectIndex(1);
      const matches = view.element.querySelectorAll("li .character-match");
      expect(Array.from(matches, (m) => m.textContent)).toEqual(["ab", "ab"]);
    });
  });

  describe("selection", () => {
    it("wraps when navigating past the ends of the list", async () => {
      view = textItemView();
      expect(view.getSelectedItem()).toBe("one");

      await view.selectPrevious();
      expect(view.getSelectedItem()).toBe("three");

      await view.selectNext();
      expect(view.getSelectedItem()).toBe("one");

      await view.selectLast();
      expect(view.getSelectedItem()).toBe("three");

      await view.selectFirst();
      expect(view.getSelectedItem()).toBe("one");
    });

    it("starts empty and steps off both ends into the empty selection when allowed", async () => {
      view = textItemView({ allowEmptySelection: true });
      // The state has to be reachable to be useful, so the list starts in it.
      expect(view.getSelectedItem()).toBeNull();

      await view.selectNext();
      expect(view.getSelectedItem()).toBe("one");
      await view.selectNext();
      await view.selectNext();
      expect(view.getSelectedItem()).toBe("three");

      // Off the end, then back in at the far end.
      await view.selectNext();
      expect(view.getSelectedItem()).toBeNull();
      await view.selectNext();
      expect(view.getSelectedItem()).toBe("one");

      // Up is the same cycle in reverse.
      await view.selectPrevious();
      expect(view.getSelectedItem()).toBeNull();
      await view.selectPrevious();
      expect(view.getSelectedItem()).toBe("three");
    });

    it("still takes an explicit initial selection when empty selections are allowed", async () => {
      view = textItemView({ allowEmptySelection: true, initialSelectionIndex: 0 });
      expect(view.getSelectedItem()).toBe("one");

      await view.selectPrevious();
      expect(view.getSelectedItem()).toBeNull();
    });

    it("names an end rather than emptying the selection when asked for one", async () => {
      view = textItemView({ allowEmptySelection: true });

      await view.selectLast();
      expect(view.getSelectedItem()).toBe("three");
      await view.selectFirst();
      expect(view.getSelectedItem()).toBe("one");
    });

    it("marks the selected item's element and reports selection changes", async () => {
      const selections = [];
      view = textItemView({ didChangeSelection: (item) => selections.push(item) });

      await view.selectNext();
      expect(view.element.querySelector("li.selected").textContent).toBe("two");
      expect(selections[selections.length - 1]).toBe("two");
    });

    it("selects an item with the middle mouse button without confirming it", async () => {
      const confirmed = [];
      view = textItemView({ didConfirmSelection: (item) => confirmed.push(item) });
      const secondItem = view.element.querySelectorAll("li")[1];
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        button: 1,
        cancelable: true,
      });

      secondItem.dispatchEvent(event);
      await nextUpdate();

      expect(event.defaultPrevented).toBe(true);
      expect(view.getSelectedItem()).toBe("two");
      expect(confirmed).toEqual([]);
    });

    it("confirms the selected item and empty selections", async () => {
      const confirmed = [];
      let confirmedEmpty = false;
      view = textItemView({
        didConfirmSelection: (item) => confirmed.push(item),
        didConfirmEmptySelection: () => (confirmedEmpty = true),
      });

      view.confirmSelection();
      expect(confirmed).toEqual(["one"]);

      view.refs.queryEditor.setText("zzz");
      await nextUpdate();
      view.confirmSelection();
      expect(confirmedEmpty).toBe(true);
    });

    it("invokes didCancelSelection on cancel", () => {
      let cancelled = false;
      view = textItemView({ didCancelSelection: () => (cancelled = true) });
      view.cancelSelection();
      expect(cancelled).toBe(true);
    });
  });

  describe("panel management", () => {
    it("shows and hides a modal panel and focuses the query editor", () => {
      view = textItemView();
      expect(view.isVisible()).toBe(false);

      view.show();
      expect(view.isVisible()).toBe(true);
      expect(lumine.workspace.getModalPanels()).toContain(view.panel);
      expect(view.element.contains(document.activeElement)).toBe(true);

      view.hide();
      expect(view.isVisible()).toBe(false);

      view.toggle();
      expect(view.isVisible()).toBe(true);
    });

    it("creates the panel hidden on getPanel() and reuses it on show()", () => {
      view = textItemView();
      const panel = view.getPanel();
      expect(panel.isVisible()).toBe(false);
      expect(lumine.workspace.getModalPanels()).toContain(panel);

      view.show();
      expect(view.panel).toBe(panel);
      expect(panel.isVisible()).toBe(true);
    });

    it("exposes panelItem as the panel's item", () => {
      const wrapper = {};
      view = textItemView({ panelItem: wrapper });
      wrapper.element = view.element;

      expect(view.getPanel().getItem()).toBe(wrapper);
    });

    it("calls willShow whenever the panel becomes visible", () => {
      let willShowCalls = 0;
      view = textItemView({
        willShow: () => willShowCalls++,
      });
      view.show();
      expect(willShowCalls).toBe(1);

      // Showing while already visible does not re-run it.
      view.show();
      expect(willShowCalls).toBe(1);

      // The panel being shown from outside the view runs it too — that is
      // how a modal-flow back navigation refreshes the list.
      view.hide();
      view.getPanel().show();
      expect(willShowCalls).toBe(2);
    });

    it("destroys its panel on destroy", async () => {
      view = textItemView();
      const panel = view.getPanel();
      await view.destroy();
      view = null;
      expect(lumine.workspace.getModalPanels()).not.toContain(panel);
    });

    it("moves a visible stable panel across surfaces and rehomes it on surface teardown", async () => {
      lumine.initializeDetachedPaneSurfaces({ force: true });
      const editor = lumine.workspace.buildTextEditor();
      lumine.workspace.getActivePane().addItem(editor);
      const primarySurface = lumine.workspace.getWindowSurface(
        lumine.views.getView(lumine.workspace),
      );
      let detachedPane;
      const relocationCancelled = jasmine.createSpy("relocationCancelled");

      view = new SelectListView({
        owner: editor,
        preserveQuery: true,
        didCancelSelection: relocationCancelled,
        items: ["one", "two"],
        initiallyVisibleItemCount: 1,
        elementForItem: (item, { visible }) => {
          // Deliberately return a primary-realm row. The list must adopt it
          // before ListItemView schedules work against its owner Document.
          const element = document.createElement("li");
          if (visible) element.textContent = item;
          return element;
        },
      });
      const panel = view.getPanel();
      const visibilityChanges = jasmine.createSpy("visibilityChanges");
      panel.onDidChangeVisible(visibilityChanges);

      try {
        editor.getElement().focus();
        view.show();
        expect(panel.getContainer()).toBe(lumine.workspace.panelContainers.modal);
        expect(view.element.ownerDocument).toBe(document);
        expect(view.visibilityObserver instanceof window.IntersectionObserver).toBe(true);
        view.refs.queryEditor.setText("kept");

        detachedPane = await lumine.workspace.detachPaneItem(editor, { show: false });
        const detachedSurface = lumine.workspace.getWindowSurface(editor);
        await view.update({ items: ["three", "four"] });

        expect(view.getPanel()).toBe(panel);
        expect(panel.getContainer()).toBe(detachedSurface.modalPanelContainer);
        expect(panel.getElement().ownerDocument).toBe(detachedSurface.document);
        expect(view.element.ownerDocument).toBe(detachedSurface.document);
        expect(view.refs.queryEditor.element.ownerDocument).toBe(detachedSurface.document);
        expect(
          Array.from(view.element.querySelectorAll("li")).every(
            (element) => element.ownerDocument === detachedSurface.document,
          ),
        ).toBe(true);
        expect(view.visibilityObserver instanceof detachedSurface.window.IntersectionObserver).toBe(
          true,
        );
        expect(view.element.contains(detachedSurface.document.activeElement)).toBe(true);
        expect(view.getQuery()).toBe("kept");
        expect(visibilityChanges.calls.allArgs()).toEqual([[true]]);

        const fixedView = new SelectListView({
          surface: primarySurface,
          items: ["fixed"],
          elementForItem: (item, { document }) => {
            const element = document.createElement("li");
            element.textContent = item;
            return element;
          },
        });
        try {
          expect(() => fixedView.show({ surface: detachedSurface })).toThrowError(
            /cannot override the dialog's declared route/,
          );
          expect(fixedView.getPanel().getContainer()).toBe(lumine.workspace.panelContainers.modal);
          expect(fixedView.element.ownerDocument).toBe(document);
        } finally {
          await fixedView.destroy();
        }

        await lumine.workspace.attachDetachedPane(detachedPane);
        detachedPane = null;
        expect(panel.getContainer()).toBe(lumine.workspace.panelContainers.modal);
        expect(view.element.ownerDocument).toBe(document);
        expect(view.document).toBe(document);
        expect(view.getPanel()).toBe(panel);
        expect(view.visibilityObserver instanceof window.IntersectionObserver).toBe(true);
        expect(view.isVisible()).toBe(true);
        expect(view.getQuery()).toBe("kept");
        expect(view.element.contains(document.activeElement)).toBe(true);
        expect(visibilityChanges.calls.allArgs()).toEqual([[true]]);
        expect(relocationCancelled).not.toHaveBeenCalled();
        view.hide();
        expect(editor.getElement().contains(document.activeElement)).toBe(true);
        expect(visibilityChanges.calls.allArgs()).toEqual([[true], [false]]);
      } finally {
        view.hide();
        if (detachedPane?.isDetached?.()) {
          await lumine.workspace.attachDetachedPane(detachedPane);
        }
        lumine.workspace.paneForItem(editor)?.destroyItem(editor, true);
        lumine.initializeDetachedPaneSurfaces();
      }
    });

    it("destroys an owner-routed panel when its pane item is destroyed", () => {
      const editor = lumine.workspace.buildTextEditor();
      const pane = lumine.workspace.getActivePane();
      pane.addItem(editor);
      const cancelled = jasmine.createSpy("cancelled");
      view = textItemView({ owner: editor, didCancelSelection: cancelled });
      const panel = view.getPanel();
      view.show();

      pane.destroyItem(editor, true);

      expect(panel.isDestroyed()).toBe(true);
      expect(view.isVisible()).toBe(false);
      expect(cancelled).toHaveBeenCalledTimes(1);
    });

    it("returns an owner-routed visible panel when a surface transition rolls back", async () => {
      lumine.initializeDetachedPaneSurfaces({ force: true });
      const editor = lumine.workspace.buildTextEditor();
      lumine.workspace.getActivePane().addItem(editor);
      view = textItemView({ owner: editor, preserveQuery: true });
      const panel = view.getPanel();
      const visibilityChanges = jasmine.createSpy("visibilityChanges");
      panel.onDidChangeVisible(visibilityChanges);
      editor.getElement().focus();
      view.show();
      view.refs.queryEditor.setText("kept");
      const rejection = lumine.workspace.addWindowSurfaceTransitionObserver(() => ({
        commit() {
          throw new Error("later participant failed");
        },
      }));

      try {
        await expectAsync(
          lumine.workspace.detachPaneItem(editor, { show: false }),
        ).toBeRejectedWithError(/later participant failed/);

        expect(lumine.workspace.paneForItem(editor).isDetached()).toBe(false);
        expect(panel.getContainer()).toBe(lumine.workspace.panelContainers.modal);
        expect(panel.getElement().ownerDocument).toBe(document);
        expect(view.isVisible()).toBe(true);
        expect(view.getQuery()).toBe("kept");
        expect(view.element.contains(document.activeElement)).toBe(true);
        expect(visibilityChanges.calls.allArgs()).toEqual([[true]]);
      } finally {
        rejection.dispose();
        view.hide();
        lumine.workspace.paneForItem(editor)?.destroyItem(editor, true);
        lumine.initializeDetachedPaneSurfaces();
      }
    });
  });

  describe("initiallyVisibleItemCount", () => {
    it("renders items beyond the count with visible: false", () => {
      const items = [];
      for (let i = 0; i < 10; i++) items.push(`item-${i}`);

      view = new SelectListView({
        items,
        initiallyVisibleItemCount: 4,
        elementForItem: (item, { visible }) => {
          const li = document.createElement("li");
          if (visible) li.textContent = item;
          return li;
        },
      });

      const texts = listTexts();
      expect(texts.length).toBe(10);
      expect(texts.slice(0, 4)).toEqual(["item-0", "item-1", "item-2", "item-3"]);
      expect(texts.slice(4).every((text) => text === "")).toBe(true);
    });

    it("re-renders an item with visible: true when selected", async () => {
      const items = ["a", "b", "c"];
      view = new SelectListView({
        items,
        initiallyVisibleItemCount: 1,
        elementForItem: (item, { visible }) => {
          const li = document.createElement("li");
          if (visible) li.textContent = item;
          return li;
        },
      });
      expect(listTexts()).toEqual(["a", "", ""]);

      await view.selectNext();
      expect(listTexts()).toEqual(["a", "b", ""]);
    });

    it("always reports visible: true when the feature is off", () => {
      const seen = [];
      view = new SelectListView({
        items: ["x"],
        elementForItem: (item, { visible }) => {
          seen.push(visible);
          return document.createElement("li");
        },
      });
      expect(seen).toEqual([true]);
    });
  });

  describe("update()", () => {
    it("replaces items, query and messages", async () => {
      view = textItemView();

      await view.update({ items: ["four", "five"] });
      expect(listTexts()).toEqual(["four", "five"]);

      await view.update({ query: "fi" });
      expect(listTexts()).toEqual(["five"]);

      // One line, highest source wins: loading covers the status, which covers
      // the resting info line.
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
      expect(view.refs.infoMessage).toBeUndefined();

      await view.update({ status: null });
      expect(view.refs.infoMessage.textContent).toBe("fyi");
    });
  });

  describe("the message line", () => {
    it("colours a status by severity and marks an error as an alert", async () => {
      view = textItemView();

      await view.update({ status: { message: "plain" } });
      expect(view.refs.statusMessage.classList.contains("text-info")).toBe(true);
      expect(view.refs.statusMessage.getAttribute("role")).toBe("status");

      await view.update({ status: { type: "warning", message: "careful" } });
      expect(view.refs.statusMessage.classList.contains("text-warning")).toBe(true);

      await view.update({ status: { type: "error", message: "broken" } });
      expect(view.refs.statusMessage.classList.contains("text-error")).toBe(true);
      expect(view.refs.statusMessage.getAttribute("role")).toBe("alert");
    });

    it("renders a spinner beside every loading message", async () => {
      view = textItemView();
      await view.update({ loadingMessage: "Indexing…", loadingBadge: 7 });
      expect(view.element.querySelector(".loading .loading-spinner-tiny")).not.toBeNull();
      expect(view.refs.loadingBadge.textContent).toBe("7");
    });

    it("clears a status on the next query change, but keeps a sticky one", async () => {
      view = textItemView({ infoMessage: "resting" });

      await view.update({ status: { type: "error", message: "Enter a value." } });
      view.refs.queryEditor.setText("o");
      // Polled rather than awaiting the next update: the render may already
      // have flushed by the time we ask, leaving no next update to wait for.
      await conditionPromise(() => !view.refs.statusMessage);
      // Clearing the overlay uncovers the resting line; nothing had to save it.
      expect(view.refs.infoMessage.textContent).toBe("resting");

      await view.update({ status: { type: "error", message: "background", sticky: true } });
      view.refs.queryEditor.setText("on");
      // A sticky status is expected not to move, so there is nothing to poll
      // for; flush with an update of our own instead.
      await view.update({});
      expect(view.refs.statusMessage.textContent).toBe("background");
    });

    it("expires a status after its duration", async () => {
      view = textItemView({ infoMessage: "resting" });

      await view.update({ status: { message: "Copied", duration: 2000 } });
      expect(view.refs.statusMessage.textContent).toBe("Copied");

      advanceClock(2000);
      expect(view.props.status).toBeNull();
      await conditionPromise(() => Boolean(view.refs.infoMessage));
      expect(view.refs.statusMessage).toBeUndefined();
    });

    it("cancels a pending expiry when the status is superseded", async () => {
      view = textItemView();

      await view.update({ status: { message: "first", duration: 2000 } });
      await view.update({ status: { message: "second" } });

      // The first message's timer must not wipe the one that replaced it.
      advanceClock(2000);
      expect(view.props.status.message).toBe("second");
      expect(view.refs.statusMessage.textContent).toBe("second");
    });

    it("cancels a pending expiry when the view is destroyed", async () => {
      view = textItemView();
      await view.update({ status: { message: "Copied", duration: 2000 } });
      await view.destroy();
      view = null;
      // Updating a destroyed etch component throws, so a surviving timer would
      // fail the spec here.
      advanceClock(2000);
    });

    it("stands the empty message down while a message is showing", async () => {
      view = textItemView({ emptyMessage: "nothing here" });
      view.refs.queryEditor.setText("zzz");
      await nextUpdate();
      expect(view.refs.emptyMessage.textContent).toBe("nothing here");

      // A failure and an empty result are the same fact; reporting both twice
      // is what stacking used to do.
      await view.update({ status: { type: "error", message: "Load failed." } });
      expect(view.refs.emptyMessage).toBeUndefined();

      await view.update({ status: null, loadingMessage: "Reloading…" });
      expect(view.refs.emptyMessage).toBeUndefined();

      await view.update({ loadingMessage: null });
      expect(view.refs.emptyMessage.textContent).toBe("nothing here");
    });

    it("keeps the resting info line alongside an empty list", async () => {
      // A stat line and "no matches" are two different statements.
      view = textItemView({ emptyMessage: "nothing here", infoMessage: "3 items" });
      view.refs.queryEditor.setText("zzz");
      await nextUpdate();
      expect(view.refs.infoMessage.textContent).toBe("3 items");
      expect(view.refs.emptyMessage.textContent).toBe("nothing here");
    });
  });

  describe("contentElement", () => {
    it("renders the content element inside the panel and preserves it across updates", async () => {
      const content = document.createElement("div");
      content.className = "custom-content";
      view = textItemView({ contentElement: content });
      expect(view.element.contains(content)).toBe(true);

      view.refs.queryEditor.setText("tw");
      await nextUpdate();
      expect(view.element.contains(content)).toBe(true);

      const replacement = document.createElement("div");
      await view.update({ contentElement: replacement });
      expect(view.element.contains(content)).toBe(false);
      expect(view.element.contains(replacement)).toBe(true);
    });

    it("supports dialog-style views with no items", () => {
      const content = document.createElement("div");
      content.textContent = "dialog body";
      let confirmedEmpty = false;
      view = new SelectListView({
        items: [],
        contentElement: content,
        didConfirmEmptySelection: () => (confirmedEmpty = true),
      });
      expect(view.element.contains(content)).toBe(true);
      expect(view.element.querySelector("li")).toBeNull();

      view.confirmSelection();
      expect(confirmedEmpty).toBe(true);
    });
  });

  describe("show more", () => {
    function bigListView(count = 250, props = {}) {
      return textItemView({
        items: Array.from({ length: count }, (_, i) => `item-${String(i).padStart(3, "0")}`),
        ...props,
      });
    }

    it("caps the list at 99 by default and ends it with the Show more row", () => {
      view = bigListView();
      const rows = view.element.querySelectorAll("li");
      expect(rows.length).toBe(100);
      expect(rows[99].textContent).toBe("Show more…");
      expect(rows[99].classList.contains("show-more-item")).toBe(true);
    });

    it("renders no Show more row when everything fits", () => {
      view = bigListView(99);
      const rows = view.element.querySelectorAll("li");
      expect(rows.length).toBe(99);
      expect(view.element.querySelector(".show-more-item")).toBeNull();
    });

    it("treats maxResults as the batch size, not a hard drop", async () => {
      view = bigListView(12, { maxResults: 5 });
      expect(view.element.querySelectorAll("li").length).toBe(6);

      await view.showMore();
      expect(view.element.querySelectorAll("li").length).toBe(11);

      await view.showMore();
      const rows = view.element.querySelectorAll("li");
      expect(rows.length).toBe(12);
      expect(view.element.querySelector(".show-more-item")).toBeNull();
    });

    it("expands on confirm and selects the first newly revealed item", async () => {
      const confirmed = [];
      view = bigListView(12, {
        maxResults: 5,
        didConfirmSelection: (item) => confirmed.push(item),
      });
      // selectIndex is the raw path a mouse click takes — no auto-expand.
      await view.selectIndex(5);
      expect(view.getSelectedItem()).toBeNull();

      view.confirmSelection();
      await view.constructor.getScheduler().getNextUpdatePromise();

      expect(confirmed).toEqual([]);
      expect(view.getSelectedItem()).toBe("item-005");
    });

    it("reports null selection while the Show more row is highlighted", async () => {
      const selections = [];
      view = bigListView(200, { didChangeSelection: (item) => selections.push(item) });
      await view.selectIndex(view.items.length - 1);
      expect(selections[selections.length - 1]).toBeNull();
    });

    it("auto-expands when keyboard navigation touches the row", async () => {
      const confirmed = [];
      view = bigListView(12, {
        maxResults: 5,
        didConfirmSelection: (item) => confirmed.push(item),
      });
      await view.selectIndex(4);

      await view.selectNext();

      expect(confirmed).toEqual([]);
      expect(view.element.querySelectorAll("li").length).toBe(11);
      expect(view.getSelectedItem()).toBe("item-005");
    });

    it("auto-expands on the wrap-around and on select-last, one batch at a time", async () => {
      view = bigListView(12, { maxResults: 5 });

      // Wrapping upward from the first item lands on the row: expand instead.
      await view.selectPrevious();
      expect(view.getSelectedItem()).toBe("item-005");
      expect(view.element.querySelectorAll("li").length).toBe(11);

      // Select-last touches the new row: one more batch, no chain.
      await view.selectLast();
      expect(view.getSelectedItem()).toBe("item-010");
      expect(view.element.querySelectorAll("li").length).toBe(12);
      expect(view.element.querySelector(".show-more-item")).toBeNull();
    });

    it("expands the rest of the matches before it empties the selection", async () => {
      view = bigListView(12, { maxResults: 5, allowEmptySelection: true });
      await view.selectIndex(4);

      // The bottom of the list is the Show more row, not the end of the
      // matches, so stepping down reveals them rather than leaving the list.
      await view.selectNext();
      expect(view.getSelectedItem()).toBe("item-005");

      await view.selectLast();
      expect(view.getSelectedItem()).toBe("item-010");
      await view.selectNext();
      expect(view.getSelectedItem()).toBe("item-011");

      // Now the end of the list really is the end of the matches.
      await view.selectNext();
      expect(view.getSelectedItem()).toBeNull();
    });

    it("starts from the base cap again when the query changes", async () => {
      view = bigListView();
      await view.showMore();
      expect(view.element.querySelectorAll("li").length).toBe(199);

      view.refs.queryEditor.setText("item-0");
      await nextUpdate();

      // 100 matches (item-000 … item-099) cap back to 99 plus the row.
      expect(view.element.querySelectorAll("li").length).toBe(100);
      expect(view.element.querySelector(".show-more-item")).not.toBeNull();
    });

    it("keeps the scroll position when the row is clicked", async () => {
      view = bigListView();
      view.show();
      const scroller = view.refs.items;
      scroller.style.maxHeight = "100px";
      scroller.style.overflowY = "auto";
      scroller.scrollTop = scroller.scrollHeight;
      const before = scroller.scrollTop;
      expect(before).toBeGreaterThan(0);

      view.didClickItem(view.items.length - 1);
      await view.constructor.getScheduler().getNextUpdatePromise();

      expect(view.refs.items).toBe(scroller);
      expect(scroller.scrollTop).toBe(before);
    });

    it("scrolls the viewport to the selection when keyboard navigation expands from afar", async () => {
      view = bigListView();
      view.show();
      const scroller = view.refs.items;
      scroller.style.maxHeight = "100px";
      scroller.style.overflowY = "auto";
      scroller.scrollTop = 0;
      await view.selectIndex(0);

      await view.selectLast();

      expect(view.getSelectedItem()).toBe("item-099");
      expect(scroller.scrollTop).toBeGreaterThan(0);
      const selected = view.element.querySelector("li.selected");
      const selRect = selected.getBoundingClientRect();
      const scrRect = scroller.getBoundingClientRect();
      expect(selRect.top).not.toBeLessThan(scrRect.top - 1);
      expect(selRect.bottom).not.toBeGreaterThan(scrRect.bottom + 1);
    });

    it("never hands the sentinel to the consumer's renderer or filter key", () => {
      const rendered = [];
      const keyed = [];
      view = new SelectListView({
        items: Array.from({ length: 150 }, (_, i) => ({ name: `n${i}` })),
        filterKeyForItem: (item) => {
          keyed.push(item);
          return item.name;
        },
        elementForItem: (item) => {
          rendered.push(item);
          const li = document.createElement("li");
          li.textContent = item.name;
          return li;
        },
      });

      expect(rendered.some((item) => item.showMoreSentinel)).toBe(false);
      expect(keyed.some((item) => item.showMoreSentinel)).toBe(false);
      expect(view.element.querySelector(".show-more-item")).not.toBeNull();
    });
  });

  describe("the query", () => {
    it("clears the query on every show, and remembers what it cleared", () => {
      view = textItemView();
      view.show();
      view.refs.queryEditor.setText("tw");
      view.hide();

      view.show();
      expect(view.getQuery()).toBe("");

      expect(view.restoreQuery()).toBe(true);
      expect(view.getQuery()).toBe("tw");
      // Selected, so the next keystroke replaces it rather than appending.
      expect(view.refs.queryEditor.getSelectedText()).toBe("tw");
    });

    it("has nothing to restore before the first close", () => {
      view = textItemView();
      view.show();
      view.refs.queryEditor.setText("tw");

      expect(view.restoreQuery()).toBe(false);
      expect(view.getQuery()).toBe("tw");
    });

    it("keeps the query when preserveQuery is set", () => {
      view = textItemView({ preserveQuery: true });
      view.show();
      view.refs.queryEditor.setText("tw");
      view.hide();

      view.show();
      expect(view.getQuery()).toBe("tw");
      expect(view.refs.queryEditor.getSelectedText()).toBe("tw");
    });

    it("clears before willShow runs, so a reload sees the empty query", () => {
      const queries = [];
      view = textItemView({ willShow: () => queries.push(view.getQuery()) });
      view.show();
      view.refs.queryEditor.setText("tw");
      view.hide();
      view.show();

      expect(queries).toEqual(["", ""]);
    });

    it("keeps the query across a flow round trip rather than treating it as an open", async () => {
      view = textItemView({ className: "spec-query", crumb: "Files" });
      const disposable = lumine.commands.add(view.element, {
        "spec:some-action": () => {},
      });
      view.show();
      view.refs.queryEditor.setText("tw");

      await view.showItemActions();
      expect(view.isVisible()).toBe(false);
      lumine.workspace.popModal();

      // Returning from the actions list is a resume: the query the action was
      // chosen under is still there.
      expect(view.isVisible()).toBe(true);
      expect(view.getQuery()).toBe("tw");
      disposable.dispose();
    });

    it("does not carry an abandoned suspension into the next open", async () => {
      view = textItemView({ className: "spec-query", crumb: "Files" });
      const disposable = lumine.commands.add(view.element, {
        "spec:some-action": () => {},
      });
      view.show();
      view.refs.queryEditor.setText("tw");

      // Shift-F10, then dismiss the actions list instead of coming back: the master
      // is left suspended with nothing on screen, and the next open is an
      // open, not a resume.
      await view.showItemActions();
      view.itemActionsList.hide();
      view.show();

      expect(view.getQuery()).toBe("");
      disposable.dispose();
    });
  });

  describe("recent items", () => {
    function recentView(props = {}) {
      return new SelectListView({
        items: ["one", "two", "three", "four"],
        elementForItem: (item) => {
          const li = document.createElement("li");
          li.textContent = item;
          return li;
        },
        ...props,
      });
    }

    it("hoists the recent items in order and rules them off", () => {
      view = recentView({ recentIds: ["three", "one"] });

      expect(view.items).toEqual(["three", "one", "two", "four"]);
      const separator = view.element.querySelector(".select-list-separator");
      expect(separator.previousElementSibling.textContent).toBe("one");
      expect(separator.nextElementSibling.textContent).toBe("two");
    });

    it("ignores recent ids that no longer match an item", () => {
      view = recentView({ recentIds: ["gone", "four"] });

      expect(view.items).toEqual(["four", "one", "two", "three"]);
      expect(view.element.querySelectorAll(".select-list-separator").length).toBe(1);
    });

    it("stands down under a query, where the ranking is the answer", async () => {
      view = recentView({ recentIds: ["three", "one"] });

      view.refs.queryEditor.setText("o");
      await nextUpdate();
      expect(view.element.querySelector(".select-list-separator")).toBeNull();

      view.refs.queryEditor.setText("");
      await nextUpdate();
      expect(view.items[0]).toBe("three");
      expect(view.element.querySelector(".select-list-separator")).not.toBeNull();
    });

    it("draws no rule when every item is recent, or none is", async () => {
      view = recentView({ recentIds: ["one", "two", "three", "four"] });
      expect(view.element.querySelector(".select-list-separator")).toBeNull();

      await view.update({ recentIds: [] });
      expect(view.element.querySelector(".select-list-separator")).toBeNull();
      expect(view.items).toEqual(["one", "two", "three", "four"]);
    });

    it("resolves recent ids through idForItem", () => {
      view = new SelectListView({
        items: [{ name: "alpha" }, { name: "beta" }],
        recentIds: ["BETA"],
        idForItem: (item) => item.name.toUpperCase(),
        filterKeyForItem: (item) => item.name,
        elementForItem: (item) => ({ primary: item.name }),
      });

      expect(view.items.map((item) => item.name)).toEqual(["beta", "alpha"]);
    });

    it("applies the caller's order among the items that are not recent", () => {
      view = recentView({
        recentIds: ["four"],
        order: (a, b) => a.localeCompare(b),
      });

      expect(view.items).toEqual(["four", "one", "three", "two"]);
    });
  });

  describe("item actions", () => {
    let dispatched, disposables;

    beforeEach(() => {
      dispatched = [];
      // A package-shaped setup: commands in the package's own namespace,
      // registered on the list's element, a keybinding scoped to the
      // package's own class.
      view = textItemView({ className: "spec-master", crumb: "Files" });
      disposables = new CompositeDisposable(
        lumine.commands.add(view.element, {
          "spec:test-action": {
            description: "Does the test thing",
            didDispatch: () => dispatched.push("spec:test-action"),
          },
          "spec:other-action": () => dispatched.push("spec:other-action"),
        }),
        lumine.commands.add("lumine-workspace", "spec:global-action", () => {}),
        lumine.keymaps.add("item-actions-spec", {
          ".spec-master lumine-text-editor[mini]": { "alt-x": "spec:test-action" },
        }),
      );
    });

    afterEach(() => {
      disposables.dispose();
    });

    it("signals available actions beside the query editor", async () => {
      disposables.add(
        lumine.commands.add(view.element, {
          "spec:list-action": {
            description: "Does the test thing to the whole list",
            actionScope: "list",
            didDispatch: () => {},
          },
        }),
      );
      view.show();
      view.refs.queryEditor.setText("a".repeat(200));
      view.refs.queryEditor.setCursorBufferPosition([0, 200]);
      await nextUpdate();

      const indicator = view.refs.itemActionsIndicator;
      expect(indicator.hidden).toBe(false);
      expect(indicator.classList.contains("icon-ellipsis")).toBe(true);
      expect(indicator.getAttribute("aria-label")).toBe("Actions");
      expect(view.refs.queryRow.classList.contains("has-item-actions")).toBe(true);

      const [tooltip] = lumine.tooltips.tooltips.get(indicator);
      expect(tooltip.options.keyBindingCommand).toBe("select-list:actions");
      expect(tooltip.options.keyBindingTarget).toBe(view.refs.queryEditor.element);

      // The editor adds one base character after the visible end-of-line
      // cursor. Account for it: the caret itself should stop at the button,
      // leaving the centred glyph equal optical space on either side.
      const component = view.refs.queryEditor.element.component;
      const textRight =
        component.refs.clientContainer.getBoundingClientRect().right -
        component.getBaseCharacterWidth();
      const buttonLeft = indicator.getBoundingClientRect().left;
      expect(textRight).toBeNear(buttonLeft);
    });

    it("opens the actions list from the query-editor indicator", async () => {
      view.show();
      const indicator = view.refs.itemActionsIndicator;
      const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });

      indicator.dispatchEvent(mouseDown);
      indicator.dispatchEvent(click);
      await conditionPromise(() => view.itemActionsList?.isVisible());

      expect(mouseDown.defaultPrevented).toBe(true);
      expect(click.defaultPrevented).toBe(true);
      expect(lumine.workspace.getModalTrail()).toEqual(["Files", "Actions"]);
      expect(view.itemActionsList.props.infoMessage).toBe("one");
    });

    it("updates the indicator when actionsFilter follows the selection", async () => {
      view.props.actionsFilter = () => view.getSelectedItem() === "two";
      view.show();

      expect(view.refs.itemActionsIndicator.hidden).toBe(true);
      expect(view.refs.queryRow.classList.contains("has-item-actions")).toBe(false);

      await view.selectItem("two");
      expect(view.refs.itemActionsIndicator.hidden).toBe(false);
      expect(view.refs.queryRow.classList.contains("has-item-actions")).toBe(true);

      await view.selectItem("one");
      expect(view.refs.itemActionsIndicator.hidden).toBe(true);
      expect(view.refs.queryRow.classList.contains("has-item-actions")).toBe(false);
    });

    it("derives the rows from the dialog's own commands and keymaps", async () => {
      view.show();
      await view.showItemActions();

      const actions = view.itemActionsList.props.items;
      const test = actions.find((action) => action.command === "spec:test-action");
      expect(test.name).toBe("Test Action");
      expect(test.description).toBe("Does the test thing");
      expect(test.keystrokes).toEqual(["alt-x"]);
      expect(actions.some((action) => action.command === "spec:other-action")).toBe(true);
      // Commands from outside the dialog and its own chrome stay out.
      expect(actions.some((action) => action.command === "spec:global-action")).toBe(false);
      expect(actions.some((action) => action.command === "core:confirm")).toBe(false);
      expect(actions.some((action) => action.command === "select-list:actions")).toBe(false);
      expect(lumine.workspace.getModalTrail()).toEqual(["Files", "Actions"]);
      expect(view.itemActionsList.props.infoMessage).toBe("one");
    });

    it("shows core:confirm on the semantic confirm action without listing the chrome", () => {
      view.props.confirmAction = "spec:test-action";

      const actions = view.itemActions();
      const test = actions.find((action) => action.command === "spec:test-action");
      // core binds Enter both globally and on select lists; the chip is one
      // interaction, so identical raw keystrokes collapse before rendering.
      expect(test.keystrokes).toEqual(["enter", "alt-x"]);
      expect(actions.some((action) => action.command === "core:confirm")).toBe(false);
    });

    it("resolves a dynamic confirm action once for the selected item", async () => {
      const seen = [];
      view.props.confirmAction = (item) => {
        seen.push(item);
        return item === "two" ? "spec:other-action" : "spec:test-action";
      };

      let byCommand = new Map(view.itemActions().map((action) => [action.command, action]));
      expect(byCommand.get("spec:test-action").keystrokes).toEqual(["enter", "alt-x"]);
      expect(byCommand.get("spec:other-action").keystrokes).toEqual([]);
      expect(seen).toEqual(["one"]);

      seen.length = 0;
      await view.selectItem("two");
      byCommand = new Map(view.itemActions().map((action) => [action.command, action]));
      expect(byCommand.get("spec:test-action").keystrokes).toEqual(["alt-x"]);
      expect(byCommand.get("spec:other-action").keystrokes).toEqual(["enter"]);
      expect(seen).toEqual(["two"]);
    });

    it("hides item actions without a selection and keeps list actions", async () => {
      const resolver = jasmine.createSpy("confirmAction").and.returnValue(null);
      view.props.confirmAction = resolver;
      disposables.add(
        lumine.commands.add(view.element, {
          "spec:list-action": {
            description: "Does the test thing to the whole list",
            actionScope: "list",
            didDispatch: () => {},
          },
        }),
      );

      await view.selectNone();
      expect(view.itemActions().map((action) => action.command)).toEqual(["spec:list-action"]);
      expect(resolver).toHaveBeenCalledWith(null);
    });

    it("does not resolve confirmAction for the Show more row", async () => {
      const resolver = jasmine.createSpy("confirmAction").and.returnValue("spec:test-action");
      view.props.confirmAction = resolver;
      disposables.add(
        lumine.commands.add(view.element, {
          "spec:list-action": {
            description: "Does the test thing to the whole list",
            actionScope: "list",
            didDispatch: () => {},
          },
        }),
      );
      await view.update({ maxResults: 2 });
      await view.selectIndex(2);

      expect(view.itemActions().map((action) => action.command)).toEqual(["spec:list-action"]);
      expect(resolver).not.toHaveBeenCalled();
    });

    it("includes named host commands once and applies actionsFilter to them", () => {
      disposables.add(
        lumine.commands.add("lumine-workspace", {
          "spec:included-global": {
            description: "Does the included global thing",
            actionScope: "list",
            didDispatch: () => dispatched.push("spec:included-global"),
          },
        }),
      );
      view.props.additionalActionCommands = [
        "spec:included-global",
        "spec:missing-global",
        "spec:included-global",
      ];

      let actions = view.itemActions();
      expect(actions.filter((action) => action.command === "spec:included-global").length).toBe(1);
      expect(actions.find((action) => action.command === "spec:included-global").scope).toBe(
        "list",
      );
      expect(actions.some((action) => action.command === "spec:missing-global")).toBe(false);

      view.props.actionsFilter = (descriptor) => descriptor.name !== "spec:included-global";
      actions = view.itemActions();
      expect(actions.some((action) => action.command === "spec:included-global")).toBe(false);
    });

    it("updates the action-source props while the list is alive", async () => {
      disposables.add(
        lumine.commands.add("lumine-workspace", {
          "spec:included-global": {
            description: "Does the included global thing",
            actionScope: "list",
            didDispatch: () => {},
          },
        }),
      );

      await view.update({
        confirmAction: "spec:test-action",
        additionalActionCommands: ["spec:included-global"],
      });
      const byCommand = new Map(view.itemActions().map((action) => [action.command, action]));
      expect(byCommand.get("spec:test-action").keystrokes).toEqual(["enter", "alt-x"]);
      expect(byCommand.get("spec:included-global").scope).toBe("list");
    });

    it("opens the actions for the right-clicked item", async () => {
      view.show();
      const secondItem = view.element.querySelectorAll("li")[1];
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        cancelable: true,
      });

      secondItem.dispatchEvent(event);
      await conditionPromise(() => view.itemActionsList?.isVisible());

      expect(event.defaultPrevented).toBe(true);
      expect(view.getSelectedItem()).toBe("two");
      expect(lumine.workspace.getModalTrail()).toEqual(["Files", "Actions"]);
      expect(view.itemActionsList.props.infoMessage).toBe("two");
    });

    it("toggles the actions list with Shift-F10", async () => {
      view.show();
      const openEvent = new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });

      view.refs.queryEditor.element.dispatchEvent(openEvent);
      await conditionPromise(() => view.itemActionsList?.isVisible());

      expect(openEvent.defaultPrevented).toBe(true);
      expect(lumine.workspace.getModalTrail()).toEqual(["Files", "Actions"]);

      const closeEvent = new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      view.itemActionsList.refs.queryEditor.element.dispatchEvent(closeEvent);

      expect(closeEvent.defaultPrevented).toBe(true);
      expect(view.isVisible()).toBeTruthy();
      expect(view.itemActionsList.isVisible()).toBeFalsy();
      expect(lumine.workspace.getModalTrail()).toEqual(["Files"]);
    });

    it("groups the row actions ahead of the list actions and rules between them", async () => {
      disposables.add(
        lumine.commands.add(view.element, {
          "spec:list-action": {
            description: "Does the test thing to the whole list",
            actionScope: "list",
            didDispatch: () => dispatched.push("spec:list-action"),
          },
        }),
      );

      view.show();
      await view.showItemActions();

      const actions = view.itemActionsList.props.items;
      expect(actions.at(-1).command).toBe("spec:list-action");
      expect(actions.at(-1).scope).toBe("list");
      // Anything that did not say otherwise is about the selected row.
      expect(actions.slice(0, -1).every((action) => action.scope === "item")).toBe(true);
      expect(view.itemActionsList.props.separatorIds).toEqual(["spec:list-action"]);

      await conditionPromise(() =>
        Boolean(view.itemActionsList.element.querySelector(".select-list-separator")),
      );
      const separator = view.itemActionsList.element.querySelector(".select-list-separator");
      expect(separator.nextElementSibling.textContent).toContain("List Action");
    });

    it("draws no group rule when the query has reordered the rows", async () => {
      disposables.add(
        lumine.commands.add(view.element, {
          "spec:list-action": {
            description: "Does the test thing to the whole list",
            actionScope: "list",
            didDispatch: () => {},
          },
        }),
      );

      view.show();
      await view.showItemActions();
      view.itemActionsList.refs.queryEditor.setText("action");
      await nextUpdate();

      expect(view.itemActionsList.element.querySelector(".select-list-separator")).toBeNull();
    });

    it("narrows the rows with actionsFilter without letting the chrome back in", async () => {
      // The predicate runs with the selection already made, which is how an
      // action that applies to only some rows is listed only for those.
      view.props.actionsFilter = (descriptor) =>
        descriptor.name !== "spec:other-action" || view.getSelectedItem() === "two";

      view.show();
      await view.showItemActions();

      let actions = view.itemActionsList.props.items.map((action) => action.command);
      expect(actions).toContain("spec:test-action");
      expect(actions).not.toContain("spec:other-action");
      // The filter said nothing about the chrome, and it is still excluded.
      expect(actions).not.toContain("core:confirm");
      expect(actions).not.toContain("select-list:actions");

      lumine.workspace.popModal();
      await view.selectItem("two");
      await view.showItemActions();

      actions = view.itemActionsList.props.items.map((action) => action.command);
      expect(actions).toContain("spec:other-action");
    });

    it("rules nothing off when every action is about the list", async () => {
      view.props.actionsFilter = (descriptor) => descriptor.name === "spec:only-list-action";
      disposables.add(
        lumine.commands.add(view.element, {
          "spec:only-list-action": {
            description: "Does the test thing to the whole list",
            actionScope: "list",
            didDispatch: () => {},
          },
        }),
      );

      view.show();
      await view.showItemActions();

      expect(view.itemActionsList.props.items.length).toBe(1);
      expect(view.itemActionsList.props.separatorIds).toEqual([]);
    });

    it("renders name, description, and keybinding like the command palette", async () => {
      view.show();
      await view.showItemActions();

      const findRow = () =>
        Array.from(view.itemActionsList.element.querySelectorAll("li")).find((li) =>
          li.textContent.includes("Test Action"),
        );
      // Polled rather than awaiting a next update, which resolves only while
      // one is still pending.
      await conditionPromise(() => Boolean(findRow()));

      const row = findRow();
      expect(row.querySelector(".secondary-line").textContent).toBe("Does the test thing");
      // Keystrokes render humanized, the way the command palette writes them.
      // Derived rather than spelled out: humanizeKeystroke writes "Alt+X" on
      // win32 and linux and "⌥X" on darwin, and the claim here is that the row
      // agrees with it, not which of the two it produces.
      expect(row.querySelector(".key-binding").textContent).toBe(humanizeKeystroke("alt-x"));
    });

    it("runs a confirmed action against the re-shown master list", async () => {
      view.show();
      await view.showItemActions();

      const index = view.itemActionsList.items.findIndex(
        (item) => item.command === "spec:test-action",
      );
      view.itemActionsList.selectIndex(index);
      view.itemActionsList.confirmSelection();

      expect(dispatched).toEqual(["spec:test-action"]);
      expect(view.isVisible()).toBeTruthy();
      expect(view.itemActionsList.isVisible()).toBeFalsy();
      expect(lumine.workspace.getModalTrail()).toEqual(["Files"]);
    });

    it("keeps Enter in the actions list on the highlighted action", async () => {
      view.props.confirmAction = "spec:test-action";
      view.show();
      await view.showItemActions();
      const index = view.itemActionsList.items.findIndex(
        (item) => item.command === "spec:other-action",
      );
      await view.itemActionsList.selectIndex(index);

      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      view.itemActionsList.refs.queryEditor.element.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(dispatched).toEqual(["spec:other-action"]);
      expect(view.isVisible()).toBeTruthy();
    });

    it("hands the action the selection it was chosen for, past a reloading willShow", async () => {
      // The shape that breaks it: a list that reseeds its items every time it
      // is shown. Returning from the actions list shows it again, and the
      // reseed resets the selection to the top — so the action would act on
      // the wrong item, and on a real one, which is what makes it silent.
      const selections = [];
      view.props.willShow = () => view.update({ items: ["one", "two", "three"] });
      disposables.add(
        lumine.commands.add(view.element, {
          "spec:read-selection": () => selections.push(view.getSelectedItem()),
        }),
      );

      view.show();
      await view.selectIndex(2);
      await view.showItemActions();

      const index = view.itemActionsList.items.findIndex(
        (item) => item.command === "spec:read-selection",
      );
      view.itemActionsList.selectIndex(index);
      view.itemActionsList.confirmSelection();

      expect(selections).toEqual(["three"]);
    });

    it("restores a rebuilt selection by its stable item id", async () => {
      await view.destroy();
      const selections = [];
      const items = () => [
        { id: "one", label: "one" },
        { id: "two", label: "two" },
      ];
      view = new SelectListView({
        items: items(),
        idForItem: (item) => item.id,
        filterKeyForItem: (item) => item.label,
        elementForItem: (item) => ({ primary: item.label }),
        willShow: () => view.update({ items: items() }),
      });
      disposables.add(
        lumine.commands.add(view.element, {
          "spec:read-selection": () => selections.push(view.getSelectedItem()?.id),
        }),
      );

      view.show();
      await view.selectIndex(1);
      await view.showItemActions();
      const index = view.itemActionsList.items.findIndex(
        (item) => item.command === "spec:read-selection",
      );
      view.itemActionsList.selectIndex(index);
      view.itemActionsList.confirmSelection();

      expect(selections).toEqual(["two"]);
      expect(view.getSelectedItem().id).toBe("two");
    });

    it("lets the reload's own selection stand when it dropped the selected item", async () => {
      const selections = [];
      view.props.willShow = () => view.update({ items: ["one", "two"] });
      disposables.add(
        lumine.commands.add(view.element, {
          "spec:read-selection": () => selections.push(view.getSelectedItem()),
        }),
      );

      view.show();
      await view.selectIndex(2);
      await view.showItemActions();

      const index = view.itemActionsList.items.findIndex(
        (item) => item.command === "spec:read-selection",
      );
      view.itemActionsList.selectIndex(index);
      view.itemActionsList.confirmSelection();

      // "three" is gone, so there is nothing to put back: the reload really
      // did unselect it, and restoring whichever row took its index would be
      // the same silent swap this guards against.
      expect(selections).toEqual(["one"]);
    });

    it("keeps the action keybinding working inside the actions list", async () => {
      view.show();
      await view.showItemActions();

      // The dynamic keymap carries the binding into the actions context...
      const bindings = lumine.keymaps.findKeyBindings({
        command: "spec:test-action",
        target: view.itemActionsList.refs.queryEditor.element,
      });
      expect(bindings.some((binding) => binding.keystrokes === "alt-x")).toBe(true);

      // ...and the forwarder runs the action against the master list.
      lumine.commands.dispatch(view.itemActionsList.element, "spec:test-action");
      expect(dispatched).toEqual(["spec:test-action"]);
      expect(view.isVisible()).toBeTruthy();
    });

    it("toggles back to the master when the actions command fires in the actions list", async () => {
      view.show();
      await view.showItemActions();
      expect(view.itemActionsList.isVisible()).toBeTruthy();
      expect(view.itemActionsList.refs.itemActionsIndicator).toBeUndefined();

      lumine.commands.dispatch(view.itemActionsList.element, "select-list:actions");

      expect(view.isVisible()).toBeTruthy();
      expect(view.itemActionsList.isVisible()).toBeFalsy();
      expect(lumine.workspace.getModalTrail()).toEqual(["Files"]);
    });

    it("stops forwarding an action after the actions list hides", async () => {
      view.show();
      await view.showItemActions();

      view.itemActionsList.hide();
      lumine.commands.dispatch(view.itemActionsList.element, "spec:test-action");

      expect(dispatched).toEqual([]);
    });

    it("does nothing when the list offers no actions", async () => {
      disposables.dispose();
      view.show();
      await view.showItemActions();
      expect(view.itemActionsList).toBeUndefined();
      expect(view.refs.itemActionsIndicator.hidden).toBe(true);
      expect(view.refs.queryRow.classList.contains("has-item-actions")).toBe(false);
    });
  });
});
