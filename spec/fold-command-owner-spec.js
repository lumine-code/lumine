const { Range } = require("../src/text-buffer");

describe("Fold command scroll ownership", () => {
  let editor, mode, release, epoch;
  beforeEach(async () => {
    editor = await lumine.workspace.open();
    editor.setText("function work() {\n  value();\n}\n");
    mode = editor.getBuffer().getLanguageMode();
    epoch = 1;
    mode.getSyntaxRequestEpoch = () => epoch;
    mode.getFoldableRangeContainingPoint = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    spyOn(editor, "scrollToCursorPosition");
  });
  afterEach(() => {
    release?.([]);
    editor.destroy();
  });
  for (const change of ["grammar", "epoch", "none"])
    it(`scrolls only for its still-current syntax (${change})`, async () => {
      const pending = lumine.commands.dispatch(editor.getElement(), "editor:fold-current-row");
      if (change === "grammar") editor.getBuffer().setLanguageMode(null);
      if (change === "epoch") epoch++;
      release(new Range([0, 16], [2, 0]));
      await pending;
      expect(editor.scrollToCursorPosition.calls.count()).toBe(change === "none" ? 1 : 0);
    });
});
