const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const ScopeDescriptor = require("../src/scope-descriptor");

describe("Editor scroll modes", () => {
  let editor, requests;

  beforeEach(() => {
    editor = new TextEditor({ buffer: new TextBuffer({ text: "short line\n".repeat(60) }) });
    requests = [];
    editor.onDidRequestAutoscroll((request) => requests.push(request));
  });

  afterEach(() => editor.destroy());

  function requestedMode() {
    return requests.at(-1).options.mode;
  }

  it("uses the current shared setting only for zone requests", () => {
    lumine.config.set("editor.scrollZone", [20, 70]);
    editor.scrollToZone();
    expect(requestedMode()).toEqual([20, 70]);
    lumine.config.set("editor.scrollZone", [75, 10]);
    expect(requests.length).toBe(1);
    editor.scrollToZone();
    expect(requestedMode()).toEqual([75, 10]);
    for (const [mode, bounds] of [
      ["nearest", [0, 100]],
      ["center", [50, 50]],
      [25, [25, 25]],
      [
        [10, 80],
        [10, 80],
      ],
    ]) {
      editor.scrollToBufferPosition([10, 0], { mode });
      expect(requestedMode()).toEqual(bounds);
    }
  });

  it("resolves zone at the target editor's root scope", () => {
    lumine.config.set("editor.scrollZone", [0, 50]);
    lumine.config.set("editor.scrollZone", [30], { scopeSelector: ".source.python" });
    spyOn(editor, "getRootScopeDescriptor").and.returnValue(
      new ScopeDescriptor({ scopes: ["source.python"] }),
    );
    editor.scrollToZone();
    expect(requestedMode()).toEqual([30, 30]);
    editor.scrollToCursorPosition({ mode: "nearest" });
    expect(requestedMode()).toEqual([0, 100]);
  });

  it("keeps ordinary and mini editor movement nearest while forwarding explicit modes", () => {
    lumine.config.set("editor.scrollZone", [25]);
    editor.setCursorBufferPosition([10, 0]);
    expect(requestedMode()).toEqual([0, 100]);
    editor.setCursorBufferPosition([11, 0], { mode: "zone" });
    expect(requestedMode()).toEqual([25, 25]);
    const count = requests.length;
    editor.setCursorBufferPosition([12, 0], { mode: "zone", autoscroll: false });
    expect(requests.length).toBe(count);
    editor.update({ mini: true });
    editor.setCursorBufferPosition([13, 0]);
    expect(requestedMode()).toEqual([0, 100]);
  });

  it("forwards the mode and active end for selection requests", () => {
    editor.setSelectedBufferRange(
      [
        [3, 0],
        [30, 0],
      ],
      { mode: [80, 20], reversed: true },
    );
    expect(requestedMode()).toEqual([80, 20]);
    expect(requests.at(-1).options.reversed).toBe(true);
    expect(requests.at(-1).screenRange).toEqual([
      [3, 0],
      [30, 0],
    ]);
    lumine.config.set("editor.scrollZone", [10, 60]);
    editor.setSelectedBufferRanges(
      [
        [
          [3, 0],
          [4, 0],
        ],
        [
          [20, 0],
          [22, 0],
        ],
      ],
      { mode: "zone" },
    );
    expect(requestedMode()).toEqual([10, 60]);
    expect(requests.at(-1).screenRange).toEqual([
      [20, 0],
      [22, 0],
    ]);
  });

  it("dispatches the zone command through the same request path", () => {
    lumine.config.set("editor.scrollZone", [15, 60]);
    const element = lumine.views.getView(editor);
    jasmine.attachToDOM(element);
    lumine.commands.dispatch(element, "editor:scroll-to-zone");
    expect(requestedMode()).toEqual([15, 60]);
  });

  it("rejects unknown modes and removed option fields", () => {
    const sparsePair = [0, 50];
    delete sparsePair[0];
    for (const mode of ["unknown", NaN, Infinity, [], [0, 20, 80], new Array(2), sparsePair]) {
      expect(() => editor.scrollToCursorPosition({ mode })).toThrowError(TypeError);
    }
    expect(() => editor.scrollToCursorPosition({ center: true })).toThrowError(TypeError);
    expect(() => editor.scrollToCursorPosition({ zone: [0, 50] })).toThrowError(TypeError);
    expect(requests.length).toBe(0);
  });

  it("does not mutate cursor scroll options or explicit numeric bounds", () => {
    const mode = Object.freeze([80, 20]);
    const options = Object.freeze({ mode });
    editor.scrollToCursorPosition(options);
    expect(requestedMode()).toEqual([80, 20]);
    expect(options).toEqual({ mode: [80, 20] });
    expect(requests.at(-1).options.mode).not.toBe(mode);
  });
});
