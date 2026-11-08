describe("shared panel empty states", () => {
  let panel;
  let body;

  beforeEach(() => {
    panel = document.createElement("section");
    panel.style.cssText =
      "display:flex;flex-direction:column;width:260px;height:240px;font-size:12px";
    panel.innerHTML = `
      <header style="flex:none;height:30px"><button type="button">Filter</button></header>
      <div class="panel-empty-state">
        <background-tips><ul class="centered background-message">
          <li>No results</li><li>Try another filter</li>
        </ul></background-tips>
      </div>`;
    body = panel.querySelector(".panel-empty-state");
    jasmine.attachToDOM(panel);
  });

  afterEach(() => panel.remove());

  it("centers stacked messages in the body without covering the header", () => {
    const header = panel.querySelector("header").getBoundingClientRect();
    const area = body.getBoundingClientRect();
    const message = body.querySelector("background-tips");
    const [first, second] = [...body.querySelectorAll("li")].map((line) =>
      line.getBoundingClientRect(),
    );
    expect(area.top).toBeGreaterThanOrEqual(header.bottom);
    expect(message.getBoundingClientRect().top).toBeGreaterThanOrEqual(header.bottom);
    expect(second.top).toBeGreaterThanOrEqual(first.bottom);
    expect(Math.abs((first.top + second.bottom) / 2 - (area.top + area.bottom) / 2)).toBeLessThan(
      1,
    );
    expect(getComputedStyle(message).pointerEvents).toBe("none");
    expect(getComputedStyle(body.querySelector("ul")).cursor).toBe("default");
    body.hidden = true;
    expect(body.getBoundingClientRect().height).toBe(0);
  });

  it("uses theme typography and wraps long messages in a narrow body", () => {
    panel.style.width = "160px";
    panel.style.setProperty("--text-color-faded", "rgb(90, 100, 110)");
    const text = body.querySelector("ul");
    text.firstElementChild.textContent = "No documentation is available for this document";
    const line = text.firstElementChild;
    expect(getComputedStyle(text).color).toBe("rgb(90, 100, 110)");
    expect(getComputedStyle(text).fontSize).toBe("24px");
    expect(line.getBoundingClientRect().width).toBeLessThanOrEqual(body.clientWidth);
    expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
  });
});
