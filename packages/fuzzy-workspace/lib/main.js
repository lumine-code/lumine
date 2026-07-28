const { CompositeDisposable } = require("atom");
const { clipboard } = require("electron");

const CONTAINERS = [
  { label: "Center", get: () => atom.workspace.getCenter() },
  { label: "Left Dock", get: () => atom.workspace.getLeftDock() },
  { label: "Right Dock", get: () => atom.workspace.getRightDock() },
  { label: "Bottom Dock", get: () => atom.workspace.getBottomDock() },
];

module.exports = {
  disposables: null,

  activate() {
    this.disposables = new CompositeDisposable(
      atom.commands.add("atom-workspace", {
        "fuzzy-workspace:toggle": () => this.toggle(),
      }),
    );
  },

  deactivate() {
    this.disposables.dispose();
  },

  buildItems() {
    const items = [];
    for (const { label, get } of CONTAINERS) {
      const container = get();
      if (!container) continue;
      for (const pane of container.getPanes()) {
        for (const paneItem of pane.getItems()) {
          const uri = this.uriFor(paneItem);
          items.push({
            paneItem,
            pane,
            container: label,
            active: paneItem === pane.getActiveItem(),
            title: this.titleFor(paneItem),
            uri,
          });
        }
      }
    }
    return items;
  },

  titleFor(paneItem) {
    if (paneItem && typeof paneItem.getTitle === "function") {
      const title = paneItem.getTitle();
      if (title) return title;
    }
    return "untitled";
  },

  uriFor(paneItem) {
    if (paneItem && typeof paneItem.getURI === "function") {
      return paneItem.getURI() || undefined;
    }
    if (paneItem && typeof paneItem.getPath === "function") {
      return paneItem.getPath() || undefined;
    }
    return undefined;
  },

  toggle() {
    return atom.modals.toggle({
      id: "fuzzy-workspace.open-items",
      className: "fuzzy-workspace",
      placeholder: "Find an open item",
      emptyMessage: "No open items found",
      source: () => this.buildItems(),
      matcher: atom.modals.matchers.fuzzy({ maxResults: 50 }),
      help: (session) => {
        const count = session.getItems().length;
        return (
          "Available commands:\n" +
          "- **Enter**: Focus item\n" +
          "- **Alt+Delete**: Close item\n" +
          "- **Alt+C**: Copy path\n" +
          "- **Alt+S**: Query from selection\n\n" +
          `**${count}** open item${count !== 1 ? "s" : ""}`
        );
      },
      renderer: {
        // Titles repeat freely — three untitled buffers, two index.js tabs —
        // so identity is the pane item itself.
        entry: (item) => ({ id: item.paneItem, text: item.title }),
        row: (item) => ({
          label: item.title,
          detail: item.uri || item.container,
          className: item.active ? "active-item" : null,
        }),
        decorate: (li, item) => {
          // The item's own icon name wins over its path — `normalizeTarget`
          // settles that. Only a real path is offered as one; a `scheme://`
          // URI is not. An item with neither still reads as a file.
          const uri = item.uri && !item.uri.includes("://") ? item.uri : null;
          let target = { item: item.paneItem, path: uri, context: "fuzzy-workspace" };
          if (atom.icons.iconFor(target).render === "none") target = { name: "file-text" };
          atom.icons.applyTo(li.firstChild, target, { setData: false });
          li.firstChild.dataset.container = item.container;
        },
      },
      actions: [
        {
          name: "focus-item",
          label: "Focus item",
          keystroke: "enter",
          run: ({ item }) => this.focusItem(item),
        },
        {
          name: "close-item",
          label: "Close item",
          keystroke: "alt-delete",
          run: ({ item }) => {
            item.pane.destroyItem(item.paneItem);
            // Stay open and re-read the workspace, so closing several items in
            // a row does not mean reopening the list each time.
            return { keepOpen: true, refresh: true };
          },
        },
        {
          name: "copy-path",
          label: "Copy path",
          keystroke: "alt-c",
          run: ({ item }) => {
            if (!item.uri) {
              atom.notifications.addWarning("Selected item has no path");
              return { keepOpen: true };
            }
            clipboard.writeText(item.uri);
          },
        },
        {
          name: "query-from-selection",
          label: "Query from selection",
          keystroke: "alt-s",
          when: "always",
          run: ({ session }) => {
            session.setQueryFromSelection();
            return { keepOpen: true };
          },
        },
      ],
      confirm: ({ item }) => this.focusItem(item),
    });
  },

  focusItem(item) {
    const container = item.pane.getContainer();
    if (container && typeof container.show === "function") {
      container.show();
    }
    item.pane.activateItem(item.paneItem);
    item.pane.activate();
    const element =
      typeof item.paneItem.getElement === "function" ? item.paneItem.getElement() : null;
    if (element && typeof element.focus === "function") element.focus();
  },
};
