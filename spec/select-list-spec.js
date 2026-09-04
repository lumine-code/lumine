const etch = require("@lumine-code/etch");
const { Disposable } = require("@lumine-code/event-kit");
const SelectList = require("../src/select-list");

describe("SelectList", () => {
  let view, host;

  function createSelectList(props) {
    const list = lumine.workspace.buildSelectList(props);
    list.getElement();
    return list;
  }

  function addHost(options = {}) {
    host = lumine.workspace.addSelectList(view, options);
    return host;
  }

  function listElement() {
    return view.getElement();
  }

  function find(selector) {
    return listElement().querySelector(selector);
  }

  function textItemView(props = {}) {
    return createSelectList({
      items: ["one", "two", "three"],
      renderItem: (item) => {
        const li = document.createElement("li");
        li.textContent = item;
        return li;
      },
      ...props,
    });
  }

  function listTexts() {
    return Array.from(listElement().querySelectorAll("li"), (li) => li.textContent);
  }

  async function nextUpdate() {
    await etch.getScheduler().getNextUpdatePromise();
  }

  beforeEach(() => {
    host = null;
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
  });

  describe("public model API", () => {
    it("materializes its DOM lazily and stays out of the editor registry while detached", () => {
      view = lumine.workspace.buildSelectList({
        items: ["one"],
        renderItem: (item) => ({ primary: item }),
      });
      const queryEditor = view.getQueryEditor();

      expect(view.component).toBeNull();
      expect(lumine.textEditors.roleFor(queryEditor)).toBeNull();

      const element = view.getElement();

      expect(element.getModel()).toBe(view);
      expect(element.isConnected).toBe(false);
      expect(view.component).not.toBeNull();
      expect(lumine.textEditors.roleFor(queryEditor)).toBeNull();
    });

    it("exposes source, filtered, displayed, and selected state through methods", async () => {
      view = textItemView();

      expect(view.getElement().getModel()).toBe(view);
      expect(view.getItems()).toEqual(["one", "two", "three"]);
      expect(view.getFilteredItems()).toEqual(["one", "two", "three"]);
      expect(view.getDisplayedItems()).toEqual(["one", "two", "three"]);
      expect(view.getItemCount()).toBe(3);
      expect(view.getMatchCount()).toBe(3);
      expect(view.getSelectedItem()).toBe("one");
      expect(view.getSelectedItemId()).toBe("one");
      expect(view.getSelectedIndex()).toBe(0);
      const listbox = view.getElement().querySelector('[role="listbox"]');
      const selected = listbox.querySelector('[role="option"]');
      expect(view.getQueryEditor().getElement().getAttribute("aria-controls")).toBe(listbox.id);
      expect(view.getQueryEditor().getElement().getAttribute("aria-expanded")).toBe("false");
      expect(view.getQueryEditor().getElement().getAttribute("aria-activedescendant")).toBe(
        selected.id,
      );
      expect(selected.getAttribute("aria-selected")).toBe("true");

      view.getQueryEditor().setText("tw");
      await nextUpdate();
      expect(view.getFilteredItems()).toEqual(["two"]);
      expect(view.getDisplayedItems()).toEqual(["two"]);
    });

    it("keeps combobox relationships aligned with an empty or visible listbox", async () => {
      view = textItemView({ items: [], emptyMessage: "Nothing" });
      const editorElement = view.getQueryEditor().getElement();
      expect(editorElement.getAttribute("aria-controls")).toBeNull();
      expect(editorElement.getAttribute("aria-expanded")).toBe("false");

      addHost().show();
      await view.setItems(["one"]);
      expect(editorElement.getAttribute("aria-controls")).toBe(
        view.getElement().querySelector('[role="listbox"]').id,
      );
      expect(editorElement.getAttribute("aria-expanded")).toBe("true");

      await view.setItems([]);
      expect(editorElement.getAttribute("aria-controls")).toBeNull();
      expect(editorElement.getAttribute("aria-expanded")).toBe("false");
    });

    it("publishes item, selection, and recent changes", async () => {
      view = textItemView();
      const itemChanges = [];
      const selectionChanges = [];
      const recentChanges = [];
      view.onDidChangeItems((event) => itemChanges.push(event.items));
      view.onDidChangeSelection((event) => selectionChanges.push(event));
      view.onDidChangeRecentItemIds((event) => recentChanges.push(event.recentItemIds));

      await view.setItems(["one", "four"]);
      await view.selectItemById("four");
      await view.recordRecentItem("four");

      expect(itemChanges).toEqual([["one", "four"]]);
      expect(selectionChanges.at(-1).item).toBe("four");
      expect(selectionChanges.at(-1).itemId).toBe("four");
      expect(recentChanges).toEqual([["four"]]);
    });

    it("exposes pagination without leaking the Show more row as an item", async () => {
      view = textItemView({ items: Array.from({ length: 101 }, (_, index) => `item-${index}`) });

      expect(view.hasMoreItems()).toBe(true);
      expect(view.getItems().length).toBe(101);
      expect(view.getDisplayedItems().length).toBe(99);
      expect(view.getRemainingItemCount()).toBe(2);
      expect(view.getItems().some((item) => item?.showMoreSentinel)).toBe(false);
      expect(view.getFilteredItems().some((item) => item?.showMoreSentinel)).toBe(false);
      expect(view.getDisplayedItems().some((item) => item?.showMoreSentinel)).toBe(false);

      // The UI may select its private row, but no public model or action API
      // can mistake that chrome for a package item.
      await view.selectIndex(99);
      expect(view.getSelectedItem()).toBeNull();
      expect(view.getSelectedItemId()).toBeNull();
      expect(view.getSelectedIndex()).toBeNull();
      expect(view.getActionContext("spec").item).toBeNull();

      await view.showMore();
      expect(view.hasMoreItems()).toBe(false);
      expect(view.getDisplayedItems().length).toBe(101);
      expect(view.getSelectedItem()).toBe("item-99");
    });

    it("preserves selection by stable ID when source objects are replaced", async () => {
      const original = [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
      ];
      view = createSelectList({
        items: original,
        search: { getFilterText: (item) => item.label },
        renderItem: (item, { highlight }) => ({ primary: highlight(item.label) }),
      });
      await view.selectItemById("two");

      const replacement = { id: "two", label: "Two, refreshed" };
      await view.update({ items: [replacement, { id: "one", label: "One, refreshed" }] });

      expect(view.getSelectedItem()).toBe(replacement);
      expect(view.getSelectedItemId()).toBe("two");
      expect(view.getSelectedIndex()).toBe(0);
      expect(find("li.selected").textContent).toBe("Two, refreshed");
    });

    it("uses the new getItemId, search, and renderItem contract", async () => {
      const items = [
        { key: "alpha", title: "Alpha" },
        { key: "beta", title: "Beta" },
      ];
      view = createSelectList({
        items,
        getItemId: (item) => item.key,
        search: { getFilterText: (item) => item.title },
        renderItem: (item, { highlight }) => ({ primary: highlight(item.title) }),
      });

      await view.selectItemById("beta");
      expect(view.getSelectedItem()).toBe(items[1]);
      expect(view.getSelectedItemId()).toBe("beta");

      view.getQueryEditor().setText("alp");
      await nextUpdate();
      expect(view.getFilteredItems()).toEqual([items[0]]);
      expect(find(".character-match").textContent).toBe("Alp");
    });

    it("keeps an initial query consistent across the editor, model, and rows", async () => {
      view = textItemView({ query: "tw" });

      expect(view.getQuery()).toBe("tw");
      expect(view.getDisplayedItems()).toEqual(["two"]);
      expect(listTexts()).toEqual(["two"]);

      await addHost().show();
      expect(view.getQuery()).toBe("");
      expect(view.getDisplayedItems()).toEqual(["one", "two", "three"]);
    });

    it("keeps selection modes distinct from stable IDs named first or none", async () => {
      view = textItemView({
        items: ["later", "first", "none"],
        selection: { initial: { id: "none" } },
      });
      expect(view.getSelectedItem()).toBe("none");

      await view.update({ selection: { initial: { id: "first" } } });
      expect(view.getSelectedItem()).toBe("first");
    });

    it("renders sections at rest and flattens them into one queried result set", async () => {
      view = createSelectList({
        sections: [
          {
            id: "first",
            items: [
              { id: "z", label: "Zulu" },
              { id: "a", label: "Alpha" },
            ],
          },
          {
            id: "second",
            items: [
              { id: "b", label: "Bravo" },
              { id: "m", label: "Mike" },
            ],
          },
        ],
        search: {
          getFilterText: (item) => item.label,
          filter: (items, query, { getFilterText }) =>
            items.filter((item) => getFilterText(item).toLowerCase().includes(query)),
          sort: (left, right) => left.label.localeCompare(right.label),
        },
        renderItem: (item, { highlight }) => ({ primary: highlight(item.label) }),
      });

      expect(view.getItems().map(({ id }) => id)).toEqual(["z", "a", "b", "m"]);
      expect(view.getFilteredItems().map(({ id }) => id)).toEqual(["a", "z", "b", "m"]);
      expect(listElement().querySelectorAll(".select-list-separator").length).toBe(1);

      view.getQueryEditor().setText("a");
      await nextUpdate();

      expect(view.getFilteredItems().map(({ id }) => id)).toEqual(["a", "b"]);
      expect(view.getDisplayedItems().map(({ id }) => id)).toEqual(["a", "b"]);
      expect(find(".select-list-separator")).toBeNull();
    });

    it("runs the applicable primary action with a stable item context", async () => {
      const contexts = [];
      view = createSelectList({
        items: [{ id: "one", label: "One" }],
        getItemId: (item) => item.id,
        search: { getFilterText: (item) => item.label },
        renderItem: (item) => ({ primary: item.label }),
        commands: {
          "spec:open-item": {
            description: "Open the selected item.",
            didDispatch: (event) => contexts.push(event.detail),
          },
        },
        actions: [
          {
            command: "spec:open-item",
            context: "item",
            primary: true,
            disposition: "stay",
          },
        ],
      });

      const result = await view.confirm();

      expect(result.status).toBe("success");
      expect(contexts.length).toBe(1);
      expect(contexts[0].item.id).toBe("one");
      expect(contexts[0].itemId).toBe("one");
      expect(view.getAvailableActions()[0].description).toBe("Open the selected item.");
    });

    it("revalidates action snapshots by ID and never retargets a missing item", async () => {
      const selected = { id: "same", version: 1 };
      const replacement = { id: "same", version: 2 };
      const seen = [];
      view = createSelectList({
        items: [selected],
        getItemId: (item) => item.id,
        search: { getFilterText: (item) => item.id },
        renderItem: (item) => ({ primary: item.id }),
        commands: {
          "spec:inspect-item": (event) => seen.push(event.detail.item),
        },
        actions: [
          {
            command: "spec:inspect-item",
            context: "item",
            disposition: "stay",
          },
        ],
      });
      const context = view.getActionContext("spec");

      await view.update({ items: [replacement] });
      await view.runAction("spec:inspect-item", { context });
      expect(seen).toEqual([replacement]);

      const missingContext = view.getActionContext("spec");
      await view.update({ items: [] });
      const result = await view.runAction("spec:inspect-item", { context: missingContext });
      expect(result.status).toBe("unavailable");
      expect(view.getStatus()).toEqual({
        type: "warning",
        message: "This action is no longer available.",
      });
      expect(seen).toEqual([replacement]);
    });

    it("lets a query source own filtering and receives parsed query metadata", async () => {
      const requests = [];
      view = createSelectList({
        items: [],
        getItemId: (item) => item.id,
        search: {
          getFilterText: (item) => item.label,
          parseQuery: (query) => ({
            text: query.split(":")[0],
            data: { suffix: query.split(":")[1] },
          }),
        },
        renderItem: (item) => ({ primary: item.label }),
        source: {
          mode: "query",
          debounceMs: 0,
          load({ query, parsedQuery }) {
            requests.push({ query, parsedQuery });
            return [{ id: query, label: `Provider result for ${query}` }];
          },
        },
      });

      await addHost().show({ query: "alpha:12" });

      expect(requests).toEqual([
        {
          query: "alpha:12",
          parsedQuery: { text: "alpha", data: { suffix: "12" } },
        },
      ]);
      expect(view.getDisplayedItems().map(({ id }) => id)).toEqual(["alpha:12"]);
      expect(view.getParsedQuery()).toEqual({ text: "alpha", data: { suffix: "12" } });
    });

    it("keeps filtering aligned when setSource changes the source mode", async () => {
      view = textItemView();
      await view.setQuery("tw");
      expect(view.getDisplayedItems()).toEqual(["two"]);

      await view.setSource({
        mode: "query",
        load: () => ["one", "two", "three"],
      });
      expect(view.getDisplayedItems()).toEqual(["one", "two", "three"]);

      await view.setSource(null);
      expect(view.getDisplayedItems()).toEqual(["two"]);
    });

    it("owns recents ordering, persistence, limits, and standard actions", async () => {
      const save = jasmine.createSpy("save").and.resolveTo();
      view = textItemView({
        recents: {
          limit: 2,
          adapter: {
            load: () => ["three", "one"],
            save,
          },
        },
      });

      expect(view.getRecentItemIds()).toEqual(["three", "one"]);
      expect(view.getFilteredItems()).toEqual(["three", "one", "two"]);
      expect(view.getActions().map(({ command }) => command)).toEqual([
        "select-list:remove-recent",
        "select-list:clear-recents",
      ]);

      await view.recordRecentItem("two");
      expect(view.getRecentItemIds()).toEqual(["two", "three"]);
      expect(save).toHaveBeenCalledWith(["two", "three"]);

      await view.selectItemById("two");
      await view.runAction("select-list:remove-recent");
      expect(view.getRecentItemIds()).toEqual(["three"]);
      expect(view.getSelectedItem()).toBe("two");
    });

    it("keeps standard recent actions across command maps and command updates", async () => {
      const open = jasmine.createSpy("open");
      view = textItemView({
        recents: { adapter: { load: () => ["one"], save: () => {} } },
        commands: { "spec:open": open },
        actions: {
          "spec:open": { context: "item", disposition: "stay" },
        },
      });

      expect(view.getActions().map(({ command }) => command)).toEqual([
        "spec:open",
        "select-list:remove-recent",
        "select-list:clear-recents",
      ]);
      expect(() => view.setActions(view.getActions())).not.toThrow();
      await view.update({ commands: { "spec:open": open } });
      await view.runAction("select-list:remove-recent");

      expect(view.getRecentItemIds()).toEqual([]);
      expect(view.getStatus()).toBeNull();
    });

    it("does not let a late initial recent load overwrite newer state", async () => {
      let finishLoad;
      view = textItemView({
        recents: {
          adapter: {
            load: () => new Promise((resolve) => (finishLoad = resolve)),
            save: () => {},
          },
        },
      });

      await view.update({ recentItemIds: ["two"] });
      finishLoad(["one"]);
      await view.recentsReady;

      expect(view.getRecentItemIds()).toEqual(["two"]);
    });

    it("applies only the newest adapter reload", async () => {
      let notify;
      let loadCount = 0;
      const pendingLoads = [];
      view = textItemView({
        recents: {
          adapter: {
            load() {
              if (loadCount++ === 0) return [];
              return new Promise((resolve) => pendingLoads.push(resolve));
            },
            save() {},
            onDidChange(callback) {
              notify = callback;
              return new Disposable();
            },
          },
        },
      });

      notify();
      notify();
      pendingLoads[1](["two"]);
      await conditionPromise(() => view.getRecentItemIds()[0] === "two");
      pendingLoads[0](["one"]);
      await Promise.resolve();

      expect(view.getRecentItemIds()).toEqual(["two"]);
    });

    it("settles a failed recent load safely after destruction", async () => {
      let failLoad;
      view = textItemView({
        recents: {
          adapter: {
            load: () => new Promise((resolve, reject) => (failLoad = reject)),
            save() {},
          },
        },
      });
      const ready = view.recentsReady;
      await view.destroy();
      view = null;

      failLoad(new Error("offline"));

      await expectAsync(ready).toBeResolved();
    });

    it("serializes asynchronous recent persistence in call order", async () => {
      const saves = [];
      const finishSaves = [];
      view = textItemView({
        recents: {
          adapter: {
            load: () => [],
            save(ids) {
              saves.push(ids);
              return new Promise((resolve) => finishSaves.push(resolve));
            },
          },
        },
      });

      const first = view.setRecentItemIds(["one"]);
      await conditionPromise(() => saves.length === 1);
      const second = view.setRecentItemIds(["two"]);
      await Promise.resolve();
      expect(saves).toEqual([["one"]]);

      finishSaves.shift()();
      await conditionPromise(() => saves.length === 2);
      finishSaves.shift()();
      await Promise.all([first, second]);
      expect(saves).toEqual([["one"], ["two"]]);
    });

    it("does not turn a completed action into a failure when recent persistence fails", async () => {
      const opened = jasmine.createSpy("opened");
      view = textItemView({
        recents: {
          adapter: {
            load: () => [],
            save: () => Promise.reject(new Error("History is read-only")),
          },
        },
        commands: { "spec:open": opened },
        actions: [
          {
            command: "spec:open",
            context: "item",
            disposition: "close",
            primary: true,
            recordsRecent: true,
          },
        ],
      });
      addHost().show();

      const result = await view.confirm();

      expect(result.status).toBe("success");
      expect(opened).toHaveBeenCalled();
      expect(host.isVisible()).toBe(false);
      expect(view.getStatus()).toEqual({ type: "error", message: "History is read-only" });
    });
  });

  afterEach(async () => {
    if (host) {
      await host.destroy();
      host = null;
    }
    if (view) {
      await view.destroy();
      view = null;
    }
  });

  describe("rendering and filtering", () => {
    it("renders all items initially and filters them as the query changes", async () => {
      view = textItemView();
      expect(listTexts()).toEqual(["one", "two", "three"]);

      view.getQueryEditor().setText("tw");
      await nextUpdate();
      expect(listTexts()).toEqual(["two"]);

      view.getQueryEditor().setText("");
      await nextUpdate();
      expect(listTexts()).toEqual(["one", "two", "three"]);
    });

    it("filters via search.getFilterText for object items", async () => {
      view = createSelectList({
        items: [
          { id: "alpha", name: "alpha" },
          { id: "beta", name: "beta" },
        ],
        search: { getFilterText: (item) => item.name },
        renderItem: (item) => {
          const li = document.createElement("li");
          li.textContent = item.name;
          return li;
        },
      });

      view.getQueryEditor().setText("bet");
      await nextUpdate();
      expect(listTexts()).toEqual(["beta"]);
    });

    it("renders separators between declared sections", async () => {
      view = textItemView({
        items: undefined,
        sections: [
          { id: "first", items: ["one"] },
          { id: "second", items: ["two", "three"] },
        ],
      });

      let separator = find(".select-list-separator");
      expect(separator.tagName).toBe("LI");
      expect(separator.getAttribute("role")).toBe("separator");
      expect(separator.previousElementSibling.textContent).toBe("one");
      expect(separator.nextElementSibling.textContent).toBe("two");
      expect(view.getDisplayedItems()).toEqual(["one", "two", "three"]);

      await view.selectNext();
      expect(view.getSelectedItem()).toBe("two");
      expect(find("li.selected").textContent).toBe("two");

      await view.setSections([
        { id: "first", items: ["one", "two"] },
        { id: "second", items: ["three"] },
      ]);
      separator = find(".select-list-separator");
      expect(separator.previousElementSibling.textContent).toBe("two");
      expect(separator.nextElementSibling.textContent).toBe("three");
    });

    it("supports custom stable item identifiers inside sections", () => {
      const items = [{ name: "alpha" }, { name: "beta" }];
      view = createSelectList({
        sections: [
          { id: "first", items: [items[0]] },
          { id: "second", items: [items[1]] },
        ],
        getItemId: (item) => item.name.toUpperCase(),
        search: { getFilterText: (item) => item.name },
        renderItem: (item) => ({ primary: item.name }),
      });

      const separator = find(".select-list-separator");
      expect(separator.previousElementSibling.textContent).toBe("alpha");
      expect(separator.nextElementSibling.textContent).toBe("beta");
    });

    it("limits rendering to the core page behind the Show more row", () => {
      view = textItemView({
        items: Array.from({ length: 101 }, (_, index) => `item-${index}`),
      });
      expect(listTexts().length).toBe(100);
      expect(listTexts().at(-1)).toBe("Show more…");
    });

    it("renders emptyMessage when no items match", async () => {
      view = textItemView({ emptyMessage: "nothing here" });
      view.getQueryEditor().setText("zzz");
      await nextUpdate();
      expect(find(".empty-message").textContent).toBe("nothing here");
    });

    it("renders two-line items from {primary, secondary} descriptors", () => {
      view = createSelectList({
        items: ["item"],
        renderItem: (item) => ({ primary: item, secondary: "detail" }),
      });
      const li = find("li");
      expect(li.classList.contains("two-lines")).toBe(true);
      expect(li.querySelector(".primary-line").textContent).toBe("item");
      expect(li.querySelector(".secondary-line").textContent).toBe("detail");
    });

    it("aligns a descriptor's secondary line with primary text after an icon", () => {
      view = createSelectList({
        items: ["item"],
        renderItem: (item) => ({
          icon: ["icon-file-text"],
          primary: item,
          secondary: "detail",
        }),
      });
      addHost().show();

      const primaryText = find(".primary-text").getBoundingClientRect();
      const secondaryText = document.createRange();
      secondaryText.selectNodeContents(find(".secondary-line"));
      expect(
        Math.abs(secondaryText.getBoundingClientRect().left - primaryText.left),
      ).toBeLessThanOrEqual(1);
    });

    it("passes matchIndices aligned with the filter key to renderItem", async () => {
      view = createSelectList({
        items: ["abc", "xyz"],
        renderItem: (item, { filterKey, matchIndices, highlight }) => {
          const li = document.createElement("li");
          // Handed back explicitly rather than defaulted, so the assertion is
          // about the indices lining up with the filter key.
          li.appendChild(highlight(filterKey, matchIndices));
          return li;
        },
      });

      view.getQueryEditor().setText("ac");
      await nextUpdate();
      const matches = listElement().querySelectorAll(".character-match");
      expect(Array.from(matches, (m) => m.textContent)).toEqual(["a", "c"]);
    });

    it("hands a descriptor's didRender the finished element", async () => {
      const rendered = [];
      view = createSelectList({
        items: ["one", "two"],
        renderItem: (item) => ({
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
      expect(Array.from(listElement().querySelectorAll("li"), (li) => li.dataset.item)).toEqual([
        "one",
        "two",
      ]);
    });

    it("disposes descriptor decorations and custom row views when rows are replaced", async () => {
      const descriptorDispose = jasmine.createSpy("descriptorDispose");
      const rowDestroy = jasmine.createSpy("rowDestroy");
      view = createSelectList({
        items: ["descriptor"],
        renderItem: (item) => {
          if (item === "descriptor") {
            return {
              primary: item,
              didRender: () => ({ dispose: descriptorDispose }),
            };
          }
          const element = document.createElement("li");
          element.textContent = item;
          return { element, destroy: rowDestroy };
        },
      });

      await view.setItems(["custom"]);
      expect(descriptorDispose).toHaveBeenCalledTimes(1);

      await view.destroy();
      view = null;
      expect(rowDestroy).toHaveBeenCalledTimes(1);
    });

    it("keeps managed row views mounted when a selection rerenders them", async () => {
      view = createSelectList({
        items: ["one", "two"],
        renderItem: (item) => {
          const element = document.createElement("li");
          element.textContent = item;
          return {
            element,
            destroy() {
              element.remove();
            },
          };
        },
      });
      await nextUpdate();

      await view.selectNext();

      expect(Array.from(listElement().querySelectorAll("li"), (item) => item.textContent)).toEqual([
        "one",
        "two",
      ]);
      expect(find("li.selected").textContent).toBe("two");
    });

    it("passes a highlight function bound to the item's own match indices", async () => {
      view = createSelectList({
        items: ["abc", "xyz"],
        renderItem: (item, { filterKey, highlight }) => {
          const li = document.createElement("li");
          li.appendChild(highlight(filterKey));
          return li;
        },
      });

      view.getQueryEditor().setText("ac");
      await nextUpdate();
      const matches = listElement().querySelectorAll(".character-match");
      expect(Array.from(matches, (m) => m.textContent)).toEqual(["a", "c"]);
    });

    it("lets highlight take explicit indices, for callers that shift offsets", async () => {
      view = createSelectList({
        items: ["abc"],
        renderItem: (item, { highlight }) => {
          const li = document.createElement("li");
          li.appendChild(highlight(`>${item}`, [1, 3]));
          return li;
        },
      });

      await nextUpdate();
      const matches = listElement().querySelectorAll(".character-match");
      expect(Array.from(matches, (m) => m.textContent)).toEqual(["a", "c"]);
    });

    it("does not compute match indices unless highlight is called without them", async () => {
      const getMatchIndicesSpy = spyOn(SelectList.prototype, "getMatchIndices").and.callThrough();

      view = createSelectList({
        items: ["abc"],
        renderItem: (item, { highlight }) => {
          const li = document.createElement("li");
          li.appendChild(highlight(item, [0]));
          return li;
        },
      });

      await nextUpdate();
      expect(getMatchIndicesSpy).not.toHaveBeenCalled();
    });

    it("provides highlight on the re-render path as well", async () => {
      view = createSelectList({
        items: ["abc", "abd"],
        renderItem: (item, { highlight }) => {
          const li = document.createElement("li");
          li.appendChild(highlight(item));
          return li;
        },
      });

      view.getQueryEditor().setText("ab");
      await nextUpdate();
      await view.selectIndex(1);
      const matches = listElement().querySelectorAll("li .character-match");
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
      view = textItemView({ selection: { allowEmpty: true, initial: { mode: "none" } } });
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
      view = textItemView({ selection: { allowEmpty: true, initial: { mode: "first" } } });
      expect(view.getSelectedItem()).toBe("one");

      await view.selectPrevious();
      expect(view.getSelectedItem()).toBeNull();
    });

    it("names an end rather than emptying the selection when asked for one", async () => {
      view = textItemView({ selection: { allowEmpty: true, initial: { mode: "none" } } });

      await view.selectLast();
      expect(view.getSelectedItem()).toBe("three");
      await view.selectFirst();
      expect(view.getSelectedItem()).toBe("one");
    });

    it("marks the selected item's element and reports selection changes", async () => {
      const selections = [];
      view = textItemView();
      view.onDidChangeSelection(({ item }) => selections.push(item));

      await view.selectNext();
      expect(find("li.selected").textContent).toBe("two");
      expect(selections[selections.length - 1]).toBe("two");
    });

    it("selects an item with the middle mouse button without confirming it", async () => {
      const confirmed = [];
      view = textItemView();
      view.onDidConfirmSelection(({ item }) => confirmed.push(item));
      const secondItem = listElement().querySelectorAll("li")[1];
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
      view = textItemView();
      view.onDidConfirmSelection(({ item }) => confirmed.push(item));
      view.onDidConfirmEmptySelection(() => (confirmedEmpty = true));

      view.confirmSelection();
      expect(confirmed).toEqual(["one"]);

      view.getQueryEditor().setText("zzz");
      await nextUpdate();
      view.confirmSelection();
      expect(confirmedEmpty).toBe(true);
    });

    it("lets its host publish cancellation", () => {
      let cancelled = false;
      view = textItemView();
      addHost().onDidCancel(() => (cancelled = true));
      host.show();
      host.cancel();
      expect(cancelled).toBe(true);
    });
  });

  describe("panel management", () => {
    it("registers the query editor only after the lazy host materializes its panel", async () => {
      view = textItemView();
      const queryEditor = view.getQueryEditor();
      addHost();

      expect(lumine.textEditors.roleFor(queryEditor)).toBeNull();

      host.getPanel();
      expect(lumine.textEditors.roleFor(queryEditor)).toBe("fragment");

      await host.destroy();
      host = null;
      expect(lumine.textEditors.roleFor(queryEditor)).toBeNull();
    });

    it("shows and hides a modal panel and focuses the query editor", () => {
      view = textItemView();
      addHost();
      expect(host.isVisible()).toBe(false);

      host.show();
      expect(host.isVisible()).toBe(true);
      expect(lumine.workspace.getModalPanels()).toContain(host.getPanel());
      expect(listElement().contains(document.activeElement)).toBe(true);

      host.hide();
      expect(host.isVisible()).toBe(false);

      host.toggle();
      expect(host.isVisible()).toBe(true);
    });

    it("resets selection to the first item on every fresh show", async () => {
      view = textItemView();
      addHost().show();
      await view.selectLast();
      expect(view.getSelectedItem()).toBe("three");
      host.hide();

      host.show();

      expect(view.getQuery()).toBe("");
      expect(view.getSelectedItem()).toBe("one");
      expect(view.getSelectedIndex()).toBe(0);
    });

    it("resets selection when a fresh show supplies the same query", async () => {
      view = textItemView();
      addHost().show({ query: "t" });
      await view.selectLast();
      expect(view.getSelectedItem()).toBe("three");
      host.hide();

      host.show({ query: "t" });

      expect(view.getSelectedItem()).toBe("two");
      expect(view.getSelectedIndex()).toBe(0);
    });

    it("reapplies an explicit initial selection on a fresh show", async () => {
      view = textItemView({ selection: { initial: { id: "two" } } });
      addHost().show();
      await view.selectLast();
      expect(view.getSelectedItem()).toBe("three");
      host.hide();

      host.show();

      expect(view.getSelectedItem()).toBe("two");
    });

    it("keeps an explicitly empty initial selection on a fresh show", async () => {
      view = textItemView({ selection: { allowEmpty: true, initial: { mode: "none" } } });
      addHost().show();
      await view.selectLast();
      expect(view.getSelectedItem()).toBe("three");
      host.hide();

      host.show();

      expect(view.getSelectedItem()).toBeNull();
    });

    it("selects the first item from a reordered snapshot source on fresh show", async () => {
      const snapshots = [
        ["one", "two", "three"],
        ["three", "one", "two"],
      ];
      view = textItemView({
        source: {
          mode: "snapshot",
          load: () => Promise.resolve(snapshots.shift()),
        },
      });
      addHost();
      await host.show();
      await view.selectItemById("two");
      host.hide();

      await host.show();

      expect(view.getItems()).toEqual(["three", "one", "two"]);
      expect(view.getSelectedItem()).toBe("three");
      expect(view.getSelectedIndex()).toBe(0);
    });

    it("lets a source publication override the fresh-session selection", async () => {
      view = textItemView({
        source: {
          mode: "snapshot",
          load: () => ({
            items: ["three", "two", "one"],
            selection: { initial: { id: "two" } },
          }),
        },
      });
      addHost();

      await host.show();

      expect(view.getItems()).toEqual(["three", "two", "one"]);
      expect(view.getSelectedItem()).toBe("two");
    });

    it("waits through an empty progressive publication for the first source item", async () => {
      view = textItemView({
        source: {
          mode: "snapshot",
          async load({ publish }) {
            await publish([]);
            return ["three", "one", "two"];
          },
        },
      });
      addHost();

      await host.show();

      expect(view.getSelectedItem()).toBe("three");
      expect(view.getSelectedIndex()).toBe(0);
    });

    it("creates the panel hidden on getPanel() and reuses it on show()", () => {
      view = textItemView();
      addHost();
      const panel = host.getPanel();
      expect(panel.isVisible()).toBe(false);
      expect(lumine.workspace.getModalPanels()).toContain(panel);

      host.show();
      expect(host.getPanel()).toBe(panel);
      expect(panel.isVisible()).toBe(true);
    });

    it("uses the full list model as the panel item", () => {
      view = textItemView();
      addHost();
      expect(host.getPanel().getItem()).toBe(view);
    });

    it("emits a fresh-open event whenever a hidden panel is shown", async () => {
      let openCalls = 0;
      view = textItemView();
      addHost().onDidOpen(() => openCalls++);
      host.show();
      expect(openCalls).toBe(1);

      // Showing while already visible does not re-run it.
      host.show();
      expect(openCalls).toBe(1);

      // The panel being shown from outside the model is still a fresh open.
      await view.selectLast();
      expect(view.getSelectedItem()).toBe("three");
      host.hide();
      host.getPanel().show();
      expect(openCalls).toBe(2);
      expect(view.getSelectedItem()).toBe("one");
    });

    it("destroys its panel when the host is destroyed", async () => {
      view = textItemView();
      addHost();
      const panel = host.getPanel();
      await host.destroy();
      host = null;
      expect(lumine.workspace.getModalPanels()).not.toContain(panel);
      expect(view.isDestroyed()).toBe(false);
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
      expect(find(".loading-message").textContent).toBe("wait");
      expect(find(".status-message")).toBeNull();
      expect(find(".info-message")).toBeNull();

      await view.update({ loadingMessage: null });
      expect(find(".status-message").textContent).toBe("boom");
      expect(find(".info-message")).toBeNull();

      await view.update({ status: null });
      expect(find(".info-message").textContent).toBe("fyi");
    });

    it("leaves model, query, DOM, and events unchanged when an atomic update fails", async () => {
      view = createSelectList({
        items: [
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
        ],
        search: { getFilterText: (item) => item.label },
        renderItem: (item) => ({ primary: item.label }),
      });
      await view.selectItemById("two");
      const itemChanges = jasmine.createSpy("itemChanges");
      const selectionChanges = jasmine.createSpy("selectionChanges");
      view.onDidChangeItems(itemChanges);
      view.onDidChangeSelection(selectionChanges);

      expect(() =>
        view.update({
          items: [
            { id: "duplicate", label: "First" },
            { id: "duplicate", label: "Second" },
          ],
          query: "broken",
          recentItemIds: ["duplicate"],
        }),
      ).toThrowError(/Duplicate item ID/);

      expect(view.getQuery()).toBe("");
      expect(view.getItems().map(({ id }) => id)).toEqual(["one", "two"]);
      expect(view.getSelectedItemId()).toBe("two");
      expect(view.getRecentItemIds()).toEqual([]);
      expect(Array.from(listElement().querySelectorAll("li"), (row) => row.textContent)).toEqual([
        "One",
        "Two",
      ]);
      expect(itemChanges).not.toHaveBeenCalled();
      expect(selectionChanges).not.toHaveBeenCalled();
    });

    it("validates common options before committing a list update", async () => {
      const oldCommand = jasmine.createSpy("oldCommand");
      view = textItemView({ commands: { "spec:old": oldCommand } });

      expect(() =>
        view.update({
          items: ["replacement"],
          commands: { "spec:broken": {} },
        }),
      ).toThrowError(/didDispatch/);

      expect(view.getItems()).toEqual(["one", "two", "three"]);
      expect(listTexts()).toEqual(["one", "two", "three"]);
      await lumine.commands.dispatch(view.getElement(), "spec:old");
      expect(oldCommand).toHaveBeenCalled();
    });

    it("validates an initial selection in the same model transaction", () => {
      view = textItemView();

      expect(() =>
        view.update({
          items: ["replacement"],
          selection: { initial: { id: "missing" } },
        }),
      ).toThrowError(/No filtered item has ID missing/);

      expect(view.getItems()).toEqual(["one", "two", "three"]);
      expect(view.getSelectedItem()).toBe("one");
      expect(listTexts()).toEqual(["one", "two", "three"]);
    });
  });

  describe("the message line", () => {
    it("colours a status by severity and marks an error as an alert", async () => {
      view = textItemView();

      await view.update({ status: { message: "plain" } });
      expect(find(".status-message").classList.contains("text-info")).toBe(true);
      expect(find(".status-message").getAttribute("role")).toBe("status");

      await view.update({ status: { type: "warning", message: "careful" } });
      expect(find(".status-message").classList.contains("text-warning")).toBe(true);

      await view.update({ status: { type: "error", message: "broken" } });
      expect(find(".status-message").classList.contains("text-error")).toBe(true);
      expect(find(".status-message").getAttribute("role")).toBe("alert");
    });

    it("renders a spinner beside every loading message", async () => {
      view = textItemView();
      await view.update({ loadingMessage: "Indexing…", loadingBadge: 7 });
      expect(find(".loading .loading-spinner-tiny")).not.toBeNull();
      expect(find(".loading .badge").textContent).toBe("7");
    });

    it("clears a status on the next query change, but keeps a sticky one", async () => {
      view = textItemView({ infoMessage: "resting" });

      await view.update({ status: { type: "error", message: "Enter a value." } });
      view.getQueryEditor().setText("o");
      // Polled rather than awaiting the next update: the render may already
      // have flushed by the time we ask, leaving no next update to wait for.
      await conditionPromise(() => !find(".status-message"));
      // Clearing the overlay uncovers the resting line; nothing had to save it.
      expect(find(".info-message").textContent).toBe("resting");

      await view.update({ status: { type: "error", message: "background", sticky: true } });
      view.getQueryEditor().setText("on");
      // A sticky status is expected not to move, so there is nothing to poll
      // for; flush with an update of our own instead.
      await view.update({});
      expect(find(".status-message").textContent).toBe("background");
    });

    it("expires a status after its duration", async () => {
      view = textItemView({ infoMessage: "resting" });

      await view.update({ status: { message: "Copied", duration: 2000 } });
      expect(find(".status-message").textContent).toBe("Copied");

      advanceClock(2000);
      expect(view.getStatus()).toBeNull();
      await conditionPromise(() => Boolean(find(".info-message")));
      expect(find(".status-message")).toBeNull();
    });

    it("cancels a pending expiry when the status is superseded", async () => {
      view = textItemView();

      await view.update({ status: { message: "first", duration: 2000 } });
      await view.update({ status: { message: "second" } });

      // The first message's timer must not wipe the one that replaced it.
      advanceClock(2000);
      expect(view.getStatus().message).toBe("second");
      expect(find(".status-message").textContent).toBe("second");
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
      view.getQueryEditor().setText("zzz");
      await nextUpdate();
      expect(find(".empty-message").textContent).toBe("nothing here");

      // A failure and an empty result are the same fact; reporting both twice
      // is what stacking used to do.
      await view.update({ status: { type: "error", message: "Load failed." } });
      expect(find(".empty-message")).toBeNull();

      await view.update({ status: null, loadingMessage: "Reloading…" });
      expect(find(".empty-message")).toBeNull();

      await view.update({ loadingMessage: null });
      expect(find(".empty-message").textContent).toBe("nothing here");
    });

    it("keeps the resting info line alongside an empty list", async () => {
      // A stat line and "no matches" are two different statements.
      view = textItemView({ emptyMessage: "nothing here", infoMessage: "3 items" });
      view.getQueryEditor().setText("zzz");
      await nextUpdate();
      expect(find(".info-message").textContent).toBe("3 items");
      expect(find(".empty-message").textContent).toBe("nothing here");
    });
  });

  describe("contentElement", () => {
    it("renders the content element inside the panel and preserves it across updates", async () => {
      const content = document.createElement("div");
      content.className = "custom-content";
      view = textItemView({ contentElement: content });
      expect(listElement().contains(content)).toBe(true);

      view.getQueryEditor().setText("tw");
      await nextUpdate();
      expect(listElement().contains(content)).toBe(true);

      const replacement = document.createElement("div");
      await view.update({ contentElement: replacement });
      expect(listElement().contains(content)).toBe(false);
      expect(listElement().contains(replacement)).toBe(true);
    });

    it("supports dialog-style views with no items", () => {
      const content = document.createElement("div");
      content.textContent = "dialog body";
      let confirmedEmpty = false;
      view = createSelectList({
        items: [],
        contentElement: content,
      });
      view.onDidConfirmEmptySelection(() => (confirmedEmpty = true));
      expect(listElement().contains(content)).toBe(true);
      expect(find("li")).toBeNull();

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
      const rows = listElement().querySelectorAll("li");
      expect(rows.length).toBe(100);
      expect(rows[99].textContent).toBe("Show more…");
      expect(rows[99].classList.contains("show-more-item")).toBe(true);
    });

    it("keeps raw rows and Show more to one line when reserving an active marker", () => {
      view = bigListView(250, { itemsClassList: ["mark-active"] });
      addHost().show();

      const item = find("li:not(.show-more-item)");
      const showMore = find("li.show-more-item");
      expect(showMore.offsetHeight).toBe(item.offsetHeight);
    });

    it("keeps descriptor rows to one line when reserving an active marker", async () => {
      view = bigListView(250, {
        itemsClassList: ["mark-active"],
        renderItem: (item) => ({
          className: item === "item-000" ? "active" : null,
          primary: item,
        }),
      });
      addHost().show();

      const activeItem = find("li.active");
      const inactiveItem = find("li:not(.active, .show-more-item)");
      const showMore = find("li.show-more-item");
      expect(activeItem.querySelector(".primary-line").textContent).toBe("item-000");
      expect(activeItem.offsetHeight).toBe(showMore.offsetHeight);
      expect(inactiveItem.offsetHeight).toBe(showMore.offsetHeight);

      await view.selectIndex(1);
      const rerenderedShowMore = find("li.show-more-item");
      expect(find("li.active:not(.selected)").offsetHeight).toBe(rerenderedShowMore.offsetHeight);
      expect(find("li.selected:not(.active)").offsetHeight).toBe(rerenderedShowMore.offsetHeight);
    });

    it("renders no Show more row when everything fits", () => {
      view = bigListView(99);
      const rows = listElement().querySelectorAll("li");
      expect(rows.length).toBe(99);
      expect(find(".show-more-item")).toBeNull();
    });

    it("reveals successive pages rather than dropping the remaining matches", async () => {
      view = bigListView(250);
      expect(listElement().querySelectorAll("li").length).toBe(100);

      await view.showMore();
      expect(listElement().querySelectorAll("li").length).toBe(199);

      await view.showMore();
      const rows = listElement().querySelectorAll("li");
      expect(rows.length).toBe(250);
      expect(find(".show-more-item")).toBeNull();
    });

    it("moves an off-page selection into view when results are collapsed", async () => {
      view = bigListView(200);
      await view.selectItemById("item-150");
      expect(view.getSelectedItem()).toBe("item-150");

      await view.resetDisplayedItemLimit();

      expect(view.getDisplayedItems().length).toBe(99);
      expect(view.getSelectedItem()).toBe("item-000");
      expect(view.getSelectedIndex()).toBe(0);
      expect(
        view.getQueryEditor().getElement().getAttribute("aria-activedescendant"),
      ).not.toBeNull();
    });

    it("expands on confirm and selects the first newly revealed item", async () => {
      const confirmed = [];
      view = bigListView(101);
      view.onDidConfirmSelection(({ item }) => confirmed.push(item));
      // selectIndex is the raw path a mouse click takes — no auto-expand.
      await view.selectIndex(99);
      expect(view.getSelectedItem()).toBeNull();

      view.confirmSelection();
      await etch.getScheduler().getNextUpdatePromise();

      expect(confirmed).toEqual([]);
      expect(view.getSelectedItem()).toBe("item-099");
    });

    it("reports null selection while the Show more row is highlighted", async () => {
      const selections = [];
      view = bigListView(200);
      view.onDidChangeSelection(({ item }) => selections.push(item));
      await view.selectIndex(view.getDisplayedItems().length);
      expect(selections[selections.length - 1]).toBeNull();
    });

    it("auto-expands when keyboard navigation touches the row", async () => {
      const confirmed = [];
      view = bigListView(101);
      view.onDidConfirmSelection(({ item }) => confirmed.push(item));
      await view.selectIndex(98);

      await view.selectNext();

      expect(confirmed).toEqual([]);
      expect(listElement().querySelectorAll("li").length).toBe(101);
      expect(view.getSelectedItem()).toBe("item-099");
    });

    it("expands a selected Show more row before entering an allowed empty state", async () => {
      view = bigListView(101, {
        selection: { allowEmpty: true, initial: { mode: "first" } },
      });
      await view.selectIndex(99);
      expect(view.getSelectedItem()).toBeNull();

      await view.selectNext();

      expect(view.getSelectedItem()).toBe("item-099");
      expect(view.hasMoreItems()).toBe(false);
    });

    it("auto-expands on the wrap-around and on select-last, one batch at a time", async () => {
      view = bigListView(250);

      // Wrapping upward from the first item lands on the row: expand instead.
      await view.selectPrevious();
      expect(view.getSelectedItem()).toBe("item-099");
      expect(listElement().querySelectorAll("li").length).toBe(199);

      // Select-last touches the new row: one more batch, no chain.
      await view.selectLast();
      expect(view.getSelectedItem()).toBe("item-198");
      expect(listElement().querySelectorAll("li").length).toBe(250);
      expect(find(".show-more-item")).toBeNull();
    });

    it("expands the rest of the matches before it empties the selection", async () => {
      view = bigListView(101, {
        selection: { allowEmpty: true, initial: { mode: "none" } },
      });
      await view.selectIndex(98);

      // The bottom of the list is the Show more row, not the end of the
      // matches, so stepping down reveals them rather than leaving the list.
      await view.selectNext();
      expect(view.getSelectedItem()).toBe("item-099");

      await view.selectLast();
      expect(view.getSelectedItem()).toBe("item-100");
      await view.selectNext();
      expect(view.getSelectedItem()).toBeNull();
    });

    it("starts from the base cap again when the query changes", async () => {
      view = bigListView();
      await view.showMore();
      expect(listElement().querySelectorAll("li").length).toBe(199);

      view.getQueryEditor().setText("item-0");
      await nextUpdate();

      // 100 matches (item-000 … item-099) cap back to 99 plus the row.
      expect(listElement().querySelectorAll("li").length).toBe(100);
      expect(find(".show-more-item")).not.toBeNull();
    });

    it("keeps the scroll position when the row is clicked", async () => {
      view = bigListView();
      addHost().show();
      const scroller = find("ol.list-group");
      scroller.style.maxHeight = "100px";
      scroller.style.overflowY = "auto";
      scroller.scrollTop = scroller.scrollHeight;
      const before = scroller.scrollTop;
      expect(before).toBeGreaterThan(0);

      view.didClickItem(view.getDisplayedItems().length);
      await etch.getScheduler().getNextUpdatePromise();

      expect(find("ol.list-group")).toBe(scroller);
      expect(scroller.scrollTop).toBe(before);
    });

    it("scrolls the viewport to the selection when keyboard navigation expands from afar", async () => {
      view = bigListView();
      addHost().show();
      const scroller = find("ol.list-group");
      scroller.style.maxHeight = "100px";
      scroller.style.overflowY = "auto";
      scroller.scrollTop = 0;
      await view.selectIndex(0);

      await view.selectLast();

      expect(view.getSelectedItem()).toBe("item-099");
      expect(scroller.scrollTop).toBeGreaterThan(0);
      const selected = find("li.selected");
      const selRect = selected.getBoundingClientRect();
      const scrRect = scroller.getBoundingClientRect();
      expect(selRect.top).not.toBeLessThan(scrRect.top - 1);
      expect(selRect.bottom).not.toBeGreaterThan(scrRect.bottom + 1);
    });

    it("never hands the sentinel to the consumer's renderer or filter key", () => {
      const rendered = [];
      const keyed = [];
      view = createSelectList({
        items: Array.from({ length: 150 }, (_, i) => ({ id: i, name: `n${i}` })),
        search: {
          getFilterText: (item) => {
            keyed.push(item);
            return item.name;
          },
        },
        renderItem: (item) => {
          rendered.push(item);
          const li = document.createElement("li");
          li.textContent = item.name;
          return li;
        },
      });

      expect(rendered.some((item) => item.showMoreSentinel)).toBe(false);
      expect(keyed.some((item) => item.showMoreSentinel)).toBe(false);
      expect(find(".show-more-item")).not.toBeNull();
    });
  });

  describe("hosted actions", () => {
    it("keeps a selected danger action in the error colour", async () => {
      view = textItemView({
        commands: {
          "spec:remove-item": {
            description: "Remove the selected item.",
            didDispatch() {},
          },
        },
        actions: [
          {
            command: "spec:remove-item",
            context: "item",
            disposition: "stay",
            tone: "danger",
          },
        ],
      });
      addHost({ crumb: "Items" }).show();

      await host.showActions();

      const selectedAction = lumine.workspace
        .getElement()
        .querySelector(".select-list-actions [role='option'].selected");
      expect(selectedAction.classList.contains("text-error")).toBe(true);

      const errorText = document.createElement("span");
      errorText.className = "text-error";
      lumine.workspace.getElement().appendChild(errorText);
      expect(getComputedStyle(selectedAction).color).toBe(getComputedStyle(errorText).color);
      errorText.remove();
    });
  });

  describe("the query", () => {
    it("clears the query on every show, and remembers what it cleared", () => {
      view = textItemView();
      addHost().show();
      view.getQueryEditor().setText("tw");
      host.hide();

      host.show();
      expect(view.getQuery()).toBe("");

      expect(host.restoreQuery()).toBe(true);
      expect(view.getQuery()).toBe("tw");
      // Selected, so the next keystroke replaces it rather than appending.
      expect(view.getQueryEditor().getSelectedText()).toBe("tw");
    });

    it("has nothing to restore before the first close", () => {
      view = textItemView();
      addHost().show();
      view.getQueryEditor().setText("tw");

      expect(host.restoreQuery()).toBe(false);
      expect(view.getQuery()).toBe("tw");
    });

    it("clears before the fresh-open event", () => {
      const queries = [];
      view = textItemView();
      addHost().onDidOpen(() => queries.push(view.getQuery()));
      host.show();
      view.getQueryEditor().setText("tw");
      host.hide();
      host.show();

      expect(queries).toEqual(["", ""]);
    });

    it("keeps the query across a flow round trip rather than treating it as an open", async () => {
      view = textItemView({
        commands: {
          "spec:some-action": { description: "Do something.", didDispatch() {} },
        },
        actions: [
          {
            command: "spec:some-action",
            context: "item",
            disposition: "stay",
          },
        ],
      });
      addHost({ crumb: "Files", className: "spec-query" }).show();
      view.getQueryEditor().setText("tw");

      await host.showActions();
      expect(host.isVisible()).toBe(false);
      lumine.workspace.popModal();

      // Returning from the actions list is a resume: the query the action was
      // chosen under is still there.
      expect(host.isVisible()).toBe(true);
      expect(view.getQuery()).toBe("tw");
    });

    it("keeps selection across a modal-flow resume", async () => {
      view = textItemView({
        commands: {
          "spec:some-action": { description: "Do something.", didDispatch() {} },
        },
        actions: [
          {
            command: "spec:some-action",
            context: "item",
            disposition: "stay",
          },
        ],
      });
      addHost({ crumb: "Files" }).show();
      await view.selectLast();

      await host.showActions();
      lumine.workspace.popModal();

      expect(host.isVisible()).toBe(true);
      expect(view.getSelectedItem()).toBe("three");
    });

    it("does not carry an abandoned suspension into the next open", async () => {
      view = textItemView({
        commands: {
          "spec:some-action": { description: "Do something.", didDispatch() {} },
        },
        actions: [
          {
            command: "spec:some-action",
            context: "item",
            disposition: "stay",
          },
        ],
      });
      addHost({ crumb: "Files", className: "spec-query" }).show();
      view.getQueryEditor().setText("tw");

      // Shift-F10, then cancel the owner instead of returning through the
      // breadcrumb: the next show is a fresh open, not a resume.
      await host.showActions();
      host.cancel("action-picker");
      host.show();

      expect(view.getQuery()).toBe("");
    });
  });

  describe("recent items", () => {
    function recentView(props = {}) {
      return createSelectList({
        items: ["one", "two", "three", "four"],
        renderItem: (item) => {
          const li = document.createElement("li");
          li.textContent = item;
          return li;
        },
        ...props,
      });
    }

    it("hoists the recent items in order and rules them off", () => {
      view = recentView({ recentItemIds: ["three", "one"] });

      expect(view.getDisplayedItems()).toEqual(["three", "one", "two", "four"]);
      const separator = view.getElement().querySelector(".select-list-separator");
      expect(separator.previousElementSibling.textContent).toBe("one");
      expect(separator.nextElementSibling.textContent).toBe("two");
    });

    it("ignores recent ids that no longer match an item", () => {
      view = recentView({ recentItemIds: ["gone", "four"] });

      expect(view.getDisplayedItems()).toEqual(["four", "one", "two", "three"]);
      expect(view.getElement().querySelectorAll(".select-list-separator").length).toBe(1);
    });

    it("stands down under a query, where the ranking is the answer", async () => {
      view = recentView({ recentItemIds: ["three", "one"] });

      view.getQueryEditor().setText("o");
      await nextUpdate();
      expect(view.getElement().querySelector(".select-list-separator")).toBeNull();

      view.getQueryEditor().setText("");
      await nextUpdate();
      expect(view.getDisplayedItems()[0]).toBe("three");
      expect(view.getElement().querySelector(".select-list-separator")).not.toBeNull();
    });

    it("draws no rule when every item is recent, or none is", async () => {
      view = recentView({ recentItemIds: ["one", "two", "three", "four"] });
      expect(view.getElement().querySelector(".select-list-separator")).toBeNull();

      await view.setRecentItemIds([]);
      expect(view.getElement().querySelector(".select-list-separator")).toBeNull();
      expect(view.getDisplayedItems()).toEqual(["one", "two", "three", "four"]);
    });

    it("resolves recent ids through getItemId", () => {
      view = createSelectList({
        items: [{ name: "alpha" }, { name: "beta" }],
        recentItemIds: ["BETA"],
        getItemId: (item) => item.name.toUpperCase(),
        search: { getFilterText: (item) => item.name },
        renderItem: (item) => ({ primary: item.name }),
      });

      expect(view.getDisplayedItems().map((item) => item.name)).toEqual(["beta", "alpha"]);
    });

    it("applies the caller's order among the items that are not recent", () => {
      view = recentView({
        recentItemIds: ["four"],
        search: { sort: (a, b) => a.localeCompare(b) },
      });

      expect(view.getDisplayedItems()).toEqual(["four", "one", "three", "two"]);
    });
  });
});
