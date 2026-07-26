const path = require("path");
const { Disposable } = require("atom");

const mruItemViewModule = require("../lib/mru-item-view");
const MRUItemView = mruItemViewModule.default || mruItemViewModule;

describe("tab icons", () => {
  let tab;

  beforeEach(() => {
    waitsForPromise(() => atom.workspace.open(path.join(__dirname, "fixtures", "sample.js")));

    waitsForPromise(() => atom.packages.activatePackage("tabs"));

    runs(() => {
      // The registry only repaints elements that are in the document, as they
      // are in a real window.
      jasmine.attachToDOM(atom.workspace.getElement());
      tab = atom.workspace.getElement().querySelector(".tab");
    });
  });

  const provide = (iconFor, extra = {}) =>
    atom.packages.serviceHub.provide("icons.provider", "1.0.0", { iconFor, ...extra });

  const tabFor = (item) => {
    const tabs = atom.workspace.getElement().querySelectorAll(".tab");
    return Array.from(tabs).find((candidate) => candidate.item === item);
  };

  const addItem = (item) => {
    const pane = atom.workspace.getActivePane();
    pane.addItem(item);
    pane.activateItem(item);
    return tabFor(item);
  };

  // The behaviour worth guarding above all others: without a provider, a plain
  // tab keeps its title unadorned. The built-in mapping always has an answer,
  // so only `skipFallback` stops every text tab growing an icon-file-text.
  it("shows no icon when nothing but the built-in mapping has an opinion", () => {
    expect(tab.itemTitle.className).toBe("title");
  });

  it("takes an icon from a provider", () => {
    const disposable = provide(() => "foo bar");
    expect(tab.itemTitle.className).toBe("title icon foo bar");

    disposable.dispose();
    expect(tab.itemTitle.className).toBe("title");
  });

  it("accepts an array of classes", () => {
    provide(() => ["foo", "bar"]);
    expect(tab.itemTitle.className).toBe("title icon foo bar");
  });

  it("repaints when a provider reports its answers changed", () => {
    let notify;
    let classes = "first";
    const disposable = provide(() => classes, {
      onDidChange(callback) {
        notify = callback;
        return new Disposable(() => (notify = null));
      },
    });
    expect(tab.itemTitle.className).toBe("title icon first");

    classes = "second";
    notify();
    expect(tab.itemTitle.className).toBe("title icon second");

    disposable.dispose();
    expect(notify).toBe(null);
  });

  // No provider stylesheet, no !important, no per-extension generated rules:
  // the data URL rides on the element itself.
  it("renders an image icon", () => {
    provide(() => ({ render: "image", source: "data:image/png;base64,AAAA" }));
    expect(tab.itemTitle.classList.contains("icon-image")).toBe(true);
    expect(tab.itemTitle.style.getPropertyValue("--icon-image")).toBe(
      'url("data:image/png;base64,AAAA")',
    );
  });

  describe("an item that names its own icon", () => {
    let item;
    let namedTab;

    beforeEach(() => {
      item = {
        element: document.createElement("div"),
        getElement() {
          return this.element;
        },
        getTitle: () => "Named",
        getIconName: () => "tools",
      };
      namedTab = addItem(item);
    });

    it("uses the name rather than any path icon", () => {
      expect(namedTab.itemTitle.classList.contains("icon-tools")).toBe(true);
    });

    // `getIconName()` is a target like any other now, so a provider can restyle
    // it — it is no longer a hard short circuit ahead of the chain.
    it("can still be overridden by a provider", () => {
      provide((target) => (target.type === "name" ? "named" : null));
      expect(namedTab.itemTitle.classList.contains("named")).toBe(true);
    });
  });

  describe("the MRU switcher", () => {
    const viewFor = (item) => {
      const view = new MRUItemView();
      view.initialize(null, item);
      return view;
    };

    // Unlike a tab, the switcher does want the built-in file icons.
    it("falls back to the built-in mapping", () => {
      const view = viewFor({
        getTitle: () => "foo.png",
        getPath: () => path.join(__dirname, "fixtures", "foo.png"),
      });
      expect(view.firstLineDiv.classList.contains("icon-file-media")).toBe(true);
    });

    it("keeps the item's title in data-name rather than the basename", () => {
      const view = viewFor({
        getTitle: () => "A Nice Title",
        getPath: () => path.join(__dirname, "fixtures", "sample.js"),
      });
      expect(view.firstLineDiv.dataset.name).toBe("A Nice Title");
    });

    it("shows a generic icon for an item with no path", () => {
      const view = viewFor({ getTitle: () => "untitled" });
      expect(view.firstLineDiv.classList.contains("icon-file-text")).toBe(true);
    });
  });
});
