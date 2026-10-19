const fs = require("node:fs");
const crypto = require("node:crypto");

describe("Buffer word index popup performance", () => {
  it("measures cold, repeated and typing requests through actual popup layout", async () => {
    jasmine.useRealClock();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", false);
    lumine.config.set("autocomplete.enableBuiltinProvider", true);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1000px";
    workspace.style.height = "800px";
    jasmine.attachToDOM(workspace);
    const editor = await lumine.workspace.open();
    const element = lumine.views.getView(editor);
    element.focus();
    const pack = await lumine.packages.activatePackage("autocomplete");
    expect(fs.realpathSync(pack.path)).toBe(fs.realpathSync(process.env.COMPLETION_PACKAGE));
    const manager = pack.mainModule.autocompleteManager;
    const deadline = performance.now() + 10000;
    while (!manager?.ready || manager.editor !== editor) {
      if (performance.now() > deadline) throw new Error("Completion manager readiness timed out");
      await tick();
    }
    async function popup(count, edit = false) {
      let subscription, observer, checkReady, timeout;
      const itemsReady = new Promise((resolve) => {
        subscription = manager.suggestionList.onDidChangeItems((items) => {
          if (items?.length === count) resolve();
        });
      });
      const domReady = new Promise((resolve, reject) => {
        checkReady = () => {
          const first = element.querySelector(".autocomplete li .word");
          if (
            manager.suggestionList.items?.length === count &&
            first?.textContent === manager.suggestionList.items[0].text &&
            first.querySelector(".character-match")
          )
            resolve();
        };
        observer = new MutationObserver(checkReady);
        observer.observe(element, { subtree: true, childList: true });
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Popup readiness timed out: expected ${count}, got ${manager.suggestionList.items?.length}`,
              ),
            ),
          10000,
        );
      });
      const start = performance.now();
      try {
        if (edit) editor.insertText("a");
        lumine.commands.dispatch(element, "autocomplete:activate");
        await Promise.race([itemsReady, domReady]);
        element.component.updateSync();
        checkReady();
        await domReady;
      } finally {
        subscription.dispose();
        observer.disconnect();
        clearTimeout(timeout);
      }
      return performance.now() - start;
    }
    const results = [];
    for (const fixture of [
      { id: "repeated-100", rows: 100 },
      { id: "repeated-6000", rows: 6000 },
      { id: "unique-6000", rows: 6000, unique: true },
      { id: "window-100000", rows: 100000, window: true },
    ]) {
      const cursorRow = fixture.window ? 50000 : fixture.rows;
      const lines = Array.from({ length: fixture.rows }, (_, row) =>
        fixture.unique
          ? `banana${row} bandana${row} banana${row}`
          : "banana bandana ban_ana bandaid band bNa",
      );
      for (const mode of ["cold", "warm", "type"]) {
        const values = [];
        for (let sample = -3; sample < 9; sample++) {
          manager.cancelSuggestions();
          const content = lines.slice();
          content.splice(cursorRow, 0, mode === "type" ? "bn" : "bna");
          // Explicit empty reset guarantees cold index state even for identical fixtures.
          editor.setText("");
          editor.setText(content.join("\n"));
          editor.setCursorBufferPosition([cursorRow, mode === "type" ? 2 : 3]);
          await editor.whenGrammarSettled();
          element.component.updateSync();
          const count = fixture.unique ? 20 : 5;
          if (mode !== "cold") {
            await popup(mode === "type" && !fixture.unique ? 6 : count);
            manager.cancelSuggestions();
            element.component.updateSync();
          }
          const elapsed = await popup(count, mode === "type");
          expect(editor.lineTextForBufferRow(cursorRow)).toBe("bna");
          if (sample >= 0) values.push(elapsed);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const sorted = values.slice().sort((a, b) => a - b);
        results.push({
          id: `${fixture.id}/${mode}`,
          median: sorted[Math.floor(sorted.length / 2)],
          samples: values,
        });
      }
    }
    manager.cancelSuggestions();
    editor.destroy();
    fs.writeFileSync(
      process.env.COMPLETION_OUTPUT,
      JSON.stringify(
        {
          runtime: process.versions,
          samples: 9,
          warmups: 3,
          driverHash: crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
          results,
        },
        null,
        2,
      ),
    );
  }, 240000);
});
