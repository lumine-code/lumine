describe("shared CSS variable semantics", () => {
  let fixture;
  let stylesheet;

  beforeEach(() => {
    fixture = document.createElement("div");
    jasmine.attachToDOM(fixture);
    stylesheet = lumine.styles.addStyleSheet(
      `:root {
        --text-color: rgb(10, 20, 30);
        --text-color-highlight: rgb(20, 30, 40);
        --text-color-selected: rgb(30, 40, 50);
        --background-color-selected: rgb(200, 210, 220);
        --badge-background-color: rgb(210, 220, 230);
        --text-color-error: rgb(40, 50, 60);
        --background-color-error: rgb(220, 230, 240);
        --text-color-on-info: rgb(50, 60, 70);
        --text-color-on-success: rgb(60, 70, 80);
        --text-color-on-warning: rgb(70, 80, 90);
        --text-color-on-error: rgb(80, 90, 100);
        --ui-row-height: 37px;
        --ui-control-height: 19px;
      }`,
      { priority: 2 },
    );
  });

  afterEach(() => {
    fixture.remove();
    stylesheet.dispose();
  });

  it("uses the badge surface token and paired diagnostic foregrounds", () => {
    fixture.innerHTML = '<span class="badge">Count</span>';
    const badge = getComputedStyle(fixture.firstElementChild);
    expect(badge.backgroundColor).toBe("rgb(210, 220, 230)");
    expect(badge.color).toBe("rgb(20, 30, 40)");
    for (const [kind, foreground] of [
      ["info", "rgb(50, 60, 70)"],
      ["success", "rgb(60, 70, 80)"],
      ["warning", "rgb(70, 80, 90)"],
      ["error", "rgb(80, 90, 100)"],
    ]) {
      for (const className of [`badge badge-${kind}`, `highlight-${kind}`]) {
        const item = document.createElement("span");
        item.className = className;
        item.textContent = kind;
        fixture.appendChild(item);
        expect(getComputedStyle(item).color).withContext(className).toBe(foreground);
      }
    }
  });

  it("keeps selection foregrounds paired in navigation, lists and select boxes", () => {
    fixture.innerHTML =
      '<ul class="nav nav-pills"><li class="active"><a href="#">Navigation</a></li></ul>' +
      '<ul class="list-tree"><li class="selected">Tree</li></ul>' +
      '<div class="select-list"><ol class="list-group"><li class="selected two-lines"><span class="primary-line">Primary</span><span class="secondary-line">Secondary</span></li></ol></div>' +
      '<div class="context-view-surface select-box-list"><div class="select-box-option" aria-selected="true">Option</div></div>';
    for (const item of fixture.querySelectorAll(
      ".nav-pills a, .list-tree .selected, .select-list .primary-line, .select-box-option",
    )) {
      expect(getComputedStyle(item).color).toBe("rgb(30, 40, 50)");
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    context.fillStyle = getComputedStyle(fixture.querySelector(".secondary-line")).color;
    context.fillRect(0, 0, 1, 1);
    const channels = Array.from(context.getImageData(0, 0, 1, 1).data);
    for (const [index, expected] of [30, 40, 50, 128].entries()) {
      expect(channels[index]).toBeCloseTo(expected, 0);
    }
    const link = fixture.querySelector("a");
    link.focus();
    expect(getComputedStyle(link).color).toBe("rgb(30, 40, 50)");
    expect(getComputedStyle(link).backgroundColor).toBe("rgb(200, 210, 220)");
  });

  it("uses row geometry independently of button control height", () => {
    fixture.innerHTML =
      '<ul class="list-tree"><li class="selected">Tree</li></ul>' +
      '<ul class="list-group"><li>List</li></ul><button class="btn">Control</button>';
    for (const row of fixture.querySelectorAll("li")) {
      expect(getComputedStyle(row).lineHeight).toBe("37px");
    }
    expect(getComputedStyle(fixture.querySelector(".selected"), "::before").height).toBe("37px");
    expect(getComputedStyle(fixture.querySelector("button")).lineHeight).toBe("19px");
  });

  it("uses the diagnostic foreground for invalid input strokes", () => {
    fixture.innerHTML =
      '<input class="input-text" required><input class="input-search" type="search" required>' +
      '<input class="input-number" type="number" required><textarea class="input-textarea" required></textarea>';
    for (const input of fixture.children) {
      expect(input.matches(":invalid")).toBe(true);
      expect(getComputedStyle(input).borderTopColor).toBe("rgb(40, 50, 60)");
    }
  });

  it("keeps the detached editor font fallback local and accepts workspace typography", () => {
    const editor = document.createElement("lumine-text-editor");
    fixture.appendChild(editor);
    expect(
      getComputedStyle(document.documentElement).getPropertyValue("--editor-font-family").trim(),
    ).toBe("");
    expect(getComputedStyle(editor).fontFamily).toContain("Consolas");
    const workspace = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspace);
    const original = workspace.style.getPropertyValue("--editor-font-family");
    try {
      workspace.style.setProperty("--editor-font-family", "serif");
      workspace.appendChild(editor);
      expect(getComputedStyle(editor).fontFamily).toBe("serif");
    } finally {
      editor.remove();
      if (original) workspace.style.setProperty("--editor-font-family", original);
      else workspace.style.removeProperty("--editor-font-family");
    }
  });
});
