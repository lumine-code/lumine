const retainContextMenuHover = require("../src/context-menu-hover");

describe("context menu source hover", () => {
  let host;
  let row;
  let target;
  let popup;

  beforeEach(() => {
    host = document.createElement("div");
    host.innerHTML =
      '<table class="data-table"><tbody><tr class="data-table-row"><td>Source</td></tr></tbody></table>';
    row = host.querySelector("tr");
    target = row.firstElementChild;
    jasmine.attachToDOM(host);
  });

  afterEach(() => {
    popup?.destroy();
    popup = null;
    host.remove();
  });

  it("retains the exact source path for the popup lifetime without selecting the row", () => {
    popup = lumine.contextMenu.show(target, [{ label: "Inspect" }]);
    expect(target.hasAttribute("data-context-menu-hover")).toBeTrue();
    expect(row.hasAttribute("data-context-menu-hover")).toBeTrue();
    expect(row.classList.contains("selected")).toBeFalse();
    expect(getComputedStyle(target).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    popup.close({ cancelled: true });
    expect(target.hasAttribute("data-context-menu-hover")).toBeFalse();
    expect(row.hasAttribute("data-context-menu-hover")).toBeFalse();
    expect(host.hasAttribute("data-context-menu-hover")).toBeFalse();
  });

  it("transfers ownership when another context menu replaces the first", () => {
    popup = lumine.contextMenu.show(target, [{ label: "First" }]);
    const first = popup;
    const other = document.createElement("tr");
    other.className = "data-table-row";
    other.innerHTML = "<td>Other</td>";
    row.parentElement.appendChild(other);
    popup = lumine.contextMenu.show(other.firstElementChild, [{ label: "Second" }]);
    expect(first.closed).toBeTrue();
    expect(row.hasAttribute("data-context-menu-hover")).toBeFalse();
    expect(other.hasAttribute("data-context-menu-hover")).toBeTrue();
    expect(host.hasAttribute("data-context-menu-hover")).toBeTrue();
    popup.destroy();
    expect(host.hasAttribute("data-context-menu-hover")).toBeFalse();
  });

  it("restores previous attributes and handles overlapping owners on detached rows", () => {
    row.setAttribute("data-context-menu-hover", "existing");
    const first = retainContextMenuHover(target);
    const second = retainContextMenuHover(target);
    row.remove();
    first.dispose();
    expect(row.hasAttribute("data-context-menu-hover")).toBeTrue();
    second.dispose();
    second.dispose();
    expect(row.getAttribute("data-context-menu-hover")).toBe("existing");
    expect(target.hasAttribute("data-context-menu-hover")).toBeFalse();
  });

  it("cleans the source state before dispatching a chosen action", async () => {
    const action = jasmine.createSpy("inspect source");
    const command = lumine.commands.add(row, "test:inspect-context-source", action);
    try {
      popup = lumine.contextMenu.show(target, [
        { label: "Inspect", command: "test:inspect-context-source" },
      ]);
      popup.rootList.items[0].element.click();
      await Promise.resolve();
      expect(action).toHaveBeenCalledTimes(1);
      expect(row.hasAttribute("data-context-menu-hover")).toBeFalse();
    } finally {
      command.dispose();
    }
  });

  it("releases the source if popup creation fails", () => {
    spyOn(lumine.contextMenu.menuManager, "showPopup").and.throwError("Cannot open popup");
    expect(() => lumine.contextMenu.show(target, [])).toThrowError("Cannot open popup");
    expect(row.hasAttribute("data-context-menu-hover")).toBeFalse();
    expect(host.hasAttribute("data-context-menu-hover")).toBeFalse();
  });
});
