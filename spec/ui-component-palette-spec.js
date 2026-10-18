describe("shared HTML component palettes", () => {
  it("uses theme roles for fields, help, navigation, alerts and table rows", () => {
    const host = document.createElement("div");
    host.style.cssText =
      "--text-color: rgb(200,210,220); --text-color-highlight: rgb(230,240,250); --text-color-subtle: rgb(130,140,150); --base-background-color: rgb(20,30,40); --app-background-color: rgb(20,30,40); --input-background-color: rgb(30,40,50); --input-border-color: rgb(60,70,80); --base-border-color: rgb(70,80,90); --accent-indicator-color: rgb(80,120,200); --text-color-warning: hsl(40,60%,50%);";
    host.innerHTML =
      '<fieldset><legend>Legend</legend><input class="form-control"><p class="help-block">Help</p></fieldset><ul class="nav nav-tabs"><li class="active"><a href="#">Tab</a></li></ul><div class="alert alert-warning">Warning <a class="alert-link" href="#">Details</a></div><table class="table table-striped"><tbody><tr><td>Value</td></tr></tbody></table>';
    jasmine.attachToDOM(host);
    try {
      const input = host.querySelector("input");
      expect(getComputedStyle(input).color).toBe("rgb(200, 210, 220)");
      expect(getComputedStyle(input).backgroundColor).toBe("rgb(30, 40, 50)");
      expect(getComputedStyle(input).borderTopColor).toBe("rgb(60, 70, 80)");
      expect(getComputedStyle(host.querySelector("legend")).color).toBe("rgb(230, 240, 250)");
      expect(getComputedStyle(host.querySelector(".help-block")).color).toBe("rgb(130, 140, 150)");
      expect(getComputedStyle(host.querySelector(".nav-tabs a")).color).toBe("rgb(230, 240, 250)");
      const reference = document.createElement("span");
      reference.style.color = "hsl(from hsl(40,60%,50%) h s 10%)";
      host.appendChild(reference);
      const severityText = getComputedStyle(reference).color;
      expect(getComputedStyle(host.querySelector(".alert")).color).toBe(severityText);
      expect(getComputedStyle(host.querySelector(".alert-link")).color).toBe(severityText);
      const row = host.querySelector("tr");
      const background = getComputedStyle(row).backgroundColor;
      host.style.setProperty("--base-background-color", "rgb(50,60,70)");
      expect(getComputedStyle(row).backgroundColor).not.toBe(background);
      input.focus();
      for (const animation of input.getAnimations()) animation.finish();
      expect(getComputedStyle(input).borderTopColor).toBe("rgb(80, 120, 200)");
    } finally {
      host.remove();
    }
  });
});
