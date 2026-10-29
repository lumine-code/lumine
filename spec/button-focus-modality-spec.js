const fs = require("node:fs");
const path = require("node:path");
const { ipcRenderer } = require("electron");

describe("base action focus indication", () => {
  let fixture, root, previous;

  beforeEach(() => {
    jasmine.useRealClock();
    fixture = document.createElement("div");
    fixture.style.cssText = "position:fixed;left:20px;top:40px;width:450px;z-index:100000";
    jasmine.attachToDOM(fixture);
    root = fixture.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("style");
    stylesheet.textContent =
      ":host { --accent-indicator-color: rgb(10, 20, 30); --ui-control-height: 24px; --ui-spacing: 8px; --button-background-color: rgb(40, 40, 40); --button-background-color-hover: rgb(60, 60, 60); --button-background-color-selected: rgb(80, 80, 80); }\n" +
      [
        "private/scaffolding.css",
        "buttons.css",
        "button-groups.css",
        "private/links.css",
        "private/forms.css",
        "lists.css",
      ]
        .map((file) =>
          fs.readFileSync(path.join(__dirname, "../static/lumine-ui/styles", file), "utf8"),
        )
        .join("\n");
    root.appendChild(stylesheet);
    previous = document.createElement("button");
    previous.textContent = "Previous";
    root.appendChild(previous);
  });

  afterEach(() => fixture.remove());

  async function settle() {
    for (let i = 0; i < 2; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  async function click(element) {
    const rect = element.getBoundingClientRect();
    for (const type of ["mouseMove", "mouseDown", "mouseUp"]) {
      await ipcRenderer.invoke("lumine:window", "sendInputEvent", {
        type,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        button: "left",
        clickCount: 1,
      });
    }
    await ipcRenderer.invoke("lumine:window", "sendInputEvent", {
      type: "mouseMove",
      x: 5,
      y: 5,
    });
    await settle();
  }

  async function key(keyCode, modifiers = []) {
    for (const type of ["keyDown", "keyUp"]) {
      await ipcRenderer.invoke("lumine:window", "sendInputEvent", { type, keyCode, modifiers });
    }
    await settle();
  }

  function button(className) {
    const element = document.createElement("button");
    element.className = className;
    element.textContent = "Action";
    root.appendChild(element);
    return element;
  }

  it("keeps pointer focus without retaining the keyboard ring or hover state", async () => {
    for (const className of [
      "btn",
      "btn active",
      "btn selected",
      "btn focus",
      "btn btn-primary",
      "list-group-item",
      "list-group-item list-group-item-info",
    ]) {
      const element = button(className);
      const resting = getComputedStyle(element);
      const shadow = resting.boxShadow;
      const background = resting.backgroundColor;
      await click(element);
      expect(root.activeElement).withContext(className).toBe(element);
      expect(element.matches(":focus-visible")).withContext(className).toBe(false);
      const style = getComputedStyle(element);
      expect(style.outlineStyle).withContext(className).toBe("none");
      expect(style.boxShadow).withContext(className).toBe(shadow);
      expect(style.backgroundColor).withContext(className).toBe(background);
      element.remove();
    }
  });

  it("shows a keyboard ring and preserves native Space activation and toggle state", async () => {
    const element = button("btn selected");
    element.setAttribute("aria-pressed", "true");
    let clicks = 0;
    element.addEventListener("click", () => clicks++);
    await click(previous);
    await key("Tab");
    expect(root.activeElement).toBe(element);
    expect(element.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(element).outlineWidth).toBe("2px");
    await key("Space");
    expect(clicks).toBe(1);
    expect(root.activeElement).toBe(element);
    expect(element.getAttribute("aria-pressed")).toBe("true");
    expect(element.classList.contains("selected")).toBe(true);
  });

  it("does not let a focus class force a ring without keyboard focus", () => {
    const element = button("btn focus");
    expect(element.matches(":focus")).toBe(false);
    expect(getComputedStyle(element).outlineStyle).toBe("none");
  });

  it("still indicates text input focus after a mouse click", async () => {
    const input = document.createElement("input");
    input.className = "form-control";
    root.appendChild(input);
    await click(input);
    expect(root.activeElement).toBe(input);
    expect(input.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(input).boxShadow).toBe("rgb(10, 20, 30) 0px 0px 0px 1px");
  });

  it("uses the same pointer and keyboard policy for action links", async () => {
    const element = document.createElement("a");
    element.href = "#action";
    element.textContent = "Action link";
    element.addEventListener("click", (event) => event.preventDefault());
    root.appendChild(element);
    await click(element);
    expect(root.activeElement).toBe(element);
    expect(element.matches(":focus-visible")).toBe(false);
    expect(getComputedStyle(element).outlineStyle).toBe("none");
    await key("Tab", ["shift"]);
    await key("Tab");
    expect(root.activeElement).toBe(element);
    expect(element.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(element).outlineWidth).toBe("2px");
  });
});
