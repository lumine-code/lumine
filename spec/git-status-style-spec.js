const fs = require("fs");
const path = require("path");

describe("staged Git status colors", () => {
  let sheet, host, colorizeDisabled;

  beforeEach(() => {
    colorizeDisabled = document.body.classList.contains("git-colorize-disabled");
    document.body.classList.remove("git-colorize-disabled");
    sheet = lumine.styles.addStyleSheet(
      fs.readFileSync(path.join(__dirname, "../static/lumine-ui/styles/git-status.css"), "utf8"),
      { priority: 1000 },
    );
    host = document.createElement("div");
    host.style.cssText =
      "--text-color-modified: rgb(240, 150, 10); --text-color-modified-staged: rgb(120, 90, 50); --text-color-added: rgb(40, 180, 90); --text-color-added-staged: rgb(50, 100, 60); color: rgb(30, 30, 30)";
    jasmine.attachToDOM(host);
  });

  afterEach(() => {
    host.remove();
    sheet.dispose();
    document.body.classList.toggle("git-colorize-disabled", colorizeDisabled);
  });

  for (const [status, unstaged, staged] of [
    ["modified", "rgb(240, 150, 10)", "rgb(120, 90, 50)"],
    ["added", "rgb(40, 180, 90)", "rgb(50, 100, 60)"],
  ]) {
    it(`shows staged ${status} colors on active tabs and selected tree entries`, () => {
      host.innerHTML = `<ul class="tab-bar"><li class="tab active"><span class="title status-${status} status-staged">file</span></li></ul>
        <ul class="list-tree"><li class="selected status-${status} status-staged">file</li><li class="list-nested-item selected status-${status} status-staged"><div class="list-item">directory</div></li></ul>`;
      const targets = [
        host.querySelector(".title"),
        host.querySelector(".list-tree > li"),
        host.querySelector(".list-item"),
      ];
      for (const target of targets) expect(getComputedStyle(target).color).toBe(staged);
      for (const element of host.querySelectorAll(".status-staged"))
        element.classList.remove("status-staged");
      for (const target of targets) expect(getComputedStyle(target).color).toBe(unstaged);
    });
  }

  it("dims staged inactive tabs and respects the colorization toggle", () => {
    host.innerHTML =
      '<ul class="tab-bar"><li class="tab"><span class="title status-modified status-staged">file</span></li></ul>';
    const title = host.querySelector(".title");
    const inactive = getComputedStyle(title).color;
    host.querySelector(".tab").classList.add("active");
    expect(getComputedStyle(title).color).toBe("rgb(120, 90, 50)");
    expect(inactive).not.toBe(getComputedStyle(title).color);
    document.body.classList.add("git-colorize-disabled");
    expect(getComputedStyle(title).color).not.toBe("rgb(120, 90, 50)");
  });
});
