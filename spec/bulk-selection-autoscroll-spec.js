describe("bulk selection autoscroll", () => {
  let editor;

  beforeEach(async () => {
    jasmine.useRealClock();
    editor = lumine.workspace.buildTextEditor({ autoHeight: false });
    editor.setText(Array.from({ length: 2001 }, (_, row) => `row ${row}`).join("\n"));
    const element = lumine.views.getView(editor);
    element.style.width = "600px";
    element.style.height = "300px";
    jasmine.attachToDOM(element);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    editor.component.updateSync();
  });

  afterEach(() => editor.destroy());

  for (const method of ["setSelectedBufferRanges", "setSelectedScreenRanges"]) {
    for (const policy of ["bulk", "disabled", "single"]) {
      it(`${method} preserves the final cursor and viewport with ${policy} selections`, async () => {
        const events = [];
        const lease = editor.onDidRequestAutoscroll((event) => events.push(event));
        let markerUpdates = 0;
        const markerLease = editor.selectionsMarkerLayer.onDidUpdate(() => markerUpdates++);
        const rows =
          policy === "single" ? [500] : Array.from({ length: 1000 }, (_, index) => index * 2);
        const options = { mode: "center", ...(policy === "disabled" ? { autoscroll: false } : {}) };
        try {
          editor[method](
            rows.map((row) => [
              [row, 0],
              [row, 0],
            ]),
            options,
          );
          expect(markerUpdates).toBe(1);
          await new Promise((resolve) => requestAnimationFrame(resolve));
          editor.component.updateSync();
          const visibleRows = editor.getVisibleRowRange();
          expect(editor.getCursorBufferPosition().toArray()).toEqual([rows.at(-1), 0]);
          expect(editor.getSelections().length).toBe(rows.length);
          expect(visibleRows[1] - visibleRows[0]).toBeLessThan(100);
          expect(options).toEqual({
            mode: "center",
            ...(policy === "disabled" ? { autoscroll: false } : {}),
          });
          if (policy === "disabled") {
            expect(events.length).toBe(0);
            expect(visibleRows[0]).toBe(0);
          } else {
            expect(events.length).toBe(1);
            expect(visibleRows[0]).toBeLessThanOrEqual(rows.at(-1));
            expect(visibleRows[1]).toBeGreaterThanOrEqual(rows.at(-1));
            expect(events[0].options.mode).toEqual([50, 50]);
          }
        } finally {
          lease.dispose();
          markerLease.dispose();
        }
      });
    }

    it(`${method} scrolls to the active reversed selection after overlapping ranges merge`, () => {
      const events = [];
      const lease = editor.onDidRequestAutoscroll((event) => events.push(event));
      try {
        editor[method](
          [
            [
              [500, 1],
              [500, 4],
            ],
            [
              [500, 2],
              [500, 5],
            ],
          ],
          { reversed: true },
        );
        expect(editor.getSelections().length).toBe(1);
        expect(editor.getLastSelection().isReversed()).toBe(true);
        expect(editor.getCursorBufferPosition().toArray()).toEqual([500, 1]);
        expect(events.length).toBe(1);
      } finally {
        lease.dispose();
      }
    });
  }
});
