const fs = require("node:fs");
const path = require("node:path");

describe("core button focus styles", () => {
  let fixture;
  let root;

  beforeEach(() => {
    fixture = document.createElement("div");
    jasmine.attachToDOM(fixture);
    root = fixture.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("style");
    stylesheet.textContent =
      ":host { --accent-indicator-color: rgb(10, 20, 30); }\n" +
      fs.readFileSync(path.join(__dirname, "../static/lumine-ui/styles/buttons.css"), "utf8");
    root.appendChild(stylesheet);
  });

  afterEach(() => {
    fixture.remove();
  });

  function focusStyle(className) {
    const button = document.createElement("button");
    button.className = className;
    button.textContent = "Action";
    root.appendChild(button);
    const input = document.createElement("input");
    root.appendChild(input);
    input.focus();
    button.focus();
    input.remove();
    expect(root.activeElement).withContext(className).toBe(button);
    expect(button.matches(":focus-visible")).withContext(className).toBe(true);
    return getComputedStyle(button);
  }

  it("provides a visible default keyboard ring for focused and active buttons", () => {
    for (const className of ["btn", "btn active", "btn focus", "btn active focus"]) {
      const style = focusStyle(className);
      expect(style.outlineStyle).withContext(className).toBe("auto");
      expect(style.outlineWidth).withContext(className).toBe("2px");
      expect(style.outlineOffset).withContext(className).toBe("-2px");
      expect(style.outlineColor).withContext(className).toBe("rgb(10, 20, 30)");
    }
  });

  it("lets a theme replace the default ring with its own focus indicator", () => {
    const theme = document.createElement("style");
    theme.textContent = `
      .btn {
        &:focus-visible {
          outline: none;
          box-shadow: 0 0 0 2px rgb(40, 50, 60);
        }
      }
    `;
    root.appendChild(theme);

    for (const className of ["btn", "btn active", "btn focus", "btn active focus"]) {
      const style = focusStyle(className);
      expect(style.outlineStyle).withContext(className).toBe("none");
      expect(style.boxShadow).withContext(className).toBe("rgb(40, 50, 60) 0px 0px 0px 2px");
    }
  });
});
