const TextEditorComponent = require("../src/text-editor-component");

describe("longest-line measurement lifetime", () => {
  function componentFor(line) {
    const component = Object.create(TextEditorComponent.prototype);
    component.longestLineToMeasure = line;
    component.previousLongestLine = line;
    component.lineComponentsByScreenLineId = new Map();
    component.measurements = { longestLineWidth: 120 };
    component.window = { devicePixelRatio: 1 };
    component.getBaseCharacterWidth = () => 8;
    component.requestLineToMeasure = jasmine.createSpy("request current line");
    component.props = {
      model: {
        getApproximateLongestScreenRow: () => 0,
        lineLengthForScreenRow: () => 10,
        displayLayer: { requiresScreenLineWindow: () => false },
        screenLineForScreenRow: () => line,
      },
    };
    return component;
  }

  for (const retired of [undefined, { element: document.createElement("div") }]) {
    it(`retires a queued ${retired ? "emptied" : "unmounted"} line and retries after a fresh render`, () => {
      const line = { id: "retired-line", startPixelColumn: 10 };
      const component = componentFor(line);
      if (retired) component.lineComponentsByScreenLineId.set(line.id, retired);
      expect(() => component.measureLongestLineWidth()).not.toThrow();
      expect(component.measurements.longestLineWidth).toBe(120);
      expect(component.longestLineToMeasure).toBeNull();

      component.queryLongestLine();
      expect(component.requestLineToMeasure).toHaveBeenCalledOnceWith(0, line);
      const element = document.createElement("div");
      element.appendChild(document.createElement("span"));
      spyOn(element.firstChild, "getBoundingClientRect").and.returnValue({ width: 100 });
      component.lineComponentsByScreenLineId.set(line.id, { element });
      component.measureLongestLineWidth();
      expect(component.measurements.longestLineWidth).toBe(180);
      expect(component.longestLineToMeasure).toBeNull();
    });
  }

  it("does not clear a newer measurement queued during a DOM read", () => {
    const line = { id: "current" },
      next = { id: "next" };
    const component = componentFor(line);
    const element = document.createElement("div");
    element.appendChild(document.createElement("span"));
    spyOn(element.firstChild, "getBoundingClientRect").and.callFake(() => {
      component.longestLineToMeasure = next;
      return { width: 160 };
    });
    component.lineComponentsByScreenLineId.set(line.id, { element });
    component.measureLongestLineWidth();
    expect(component.longestLineToMeasure).toBe(next);
  });
});
