const fs = require("node:fs");
const path = require("node:path");

describe("shared dialog layout", () => {
  let fixture, root;

  beforeEach(() => {
    fixture = document.createElement("div");
    jasmine.attachToDOM(fixture);
    root = fixture.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        --ui-spacing: 10px;
        --ui-panel-padding: 15px;
        --ui-input-font-size: 15px;
      }
      * { box-sizing: border-box; }
      lumine-panel { display: block; }
      ${fs.readFileSync(path.join(__dirname, "../static/lumine-ui/styles/dialogs.css"), "utf8")}
      /* Themes load after core and retain the picker geometry for lists. */
      lumine-panel.modal { width: 900px; max-width: 900px; padding: 6px; }
      lumine-panel.modal lumine-text-editor[mini] { margin-bottom: 20px; font-size: 18px; }
    `;
    root.append(style);
  });

  afterEach(() => fixture.remove());

  function panel(content) {
    const element = document.createElement("lumine-panel");
    element.className = "modal dialog-panel";
    element.innerHTML = `<div class="dialog-form">${content}</div>`;
    root.append(element);
    return element;
  }

  it("keeps the theme's picker width with full panel padding around form fields", () => {
    const element = panel('<div class="dialog-header">Prompt</div>');
    const style = getComputedStyle(element);
    expect(style.paddingTop).toBe("15px");
    const width = style.width;

    element.classList.remove("dialog-panel");
    expect(getComputedStyle(element).width).toBe(width);
  });

  it("scrolls a long body while keeping actions within the form", () => {
    const element = panel(`
      <header class="dialog-header">Many fields</header>
      <div class="dialog-body">${'<div class="dialog-field" style="height:40px">Field</div>'.repeat(100)}</div>
      <footer class="dialog-actions"><button>Cancel</button><button>Save</button></footer>
    `);
    const body = element.querySelector(".dialog-body");
    const footer = element.querySelector(".dialog-actions");
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      element.getBoundingClientRect().bottom,
    );
    expect(element.scrollWidth).toBe(element.clientWidth);
  });

  it("wraps actions without overflowing a narrow form", () => {
    const element = panel(`
      <footer class="dialog-actions">
        <button style="width:100px">Cancel</button><button style="width:100px">Save</button>
      </footer>
    `);
    element.style.width = "150px";
    const [cancel, save] = element.querySelectorAll("button");
    expect(save.getBoundingClientRect().top).toBeGreaterThan(cancel.getBoundingClientRect().top);
    expect(element.scrollWidth).toBe(element.clientWidth);
  });
});
