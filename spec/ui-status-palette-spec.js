describe("distinct shared status surfaces", () => {
  it("keeps severity colors in alerts, tables and form addons independent of the UI backdrop", () => {
    const host = document.createElement("div");
    jasmine.attachToDOM(host);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    const rgba = (color) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    try {
      for (const backdrop of ["white", "black"]) {
        host.style.setProperty("--base-background-color", backdrop);
        host.style.setProperty("--input-background-color", backdrop);
        for (const [status, rowClass] of [
          ["info", "info"],
          ["success", "success"],
          ["warning", "warning"],
          ["error", "danger"],
        ]) {
          host.style.setProperty(`--background-color-${status}`, "hsl(210, 60%, 50%)");
          host.style.setProperty(`--text-color-${status}`, "hsl(210, 60%, 60%)");
          host.innerHTML = `<div class="alert alert-${rowClass}">Status</div><table class="table"><tbody><tr class="${rowClass}"><td>Status</td></tr></tbody></table>`;
          if (status !== "info")
            host.innerHTML += `<div class="has-${status}"><span class="input-group-addon">Status</span></div>`;
          for (const element of host.querySelectorAll(".alert, td, .input-group-addon")) {
            const style = getComputedStyle(element);
            for (const [property, expected] of [
              ["color", "hsl(210, 60%, 20%)"],
              ["backgroundColor", "hsl(210, 60%, 75%)"],
            ]) {
              const actual = rgba(style[property]);
              for (const [channel, value] of rgba(expected).entries())
                expect(Math.abs(actual[channel] - value))
                  .withContext(`${status} ${property}`)
                  .toBeLessThanOrEqual(1);
            }
          }
        }
      }
    } finally {
      host.remove();
    }
  });
});
