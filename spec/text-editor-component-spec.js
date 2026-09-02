const { conditionPromise, timeoutPromise: wait } = require("./helpers/async-spec-helpers");

const Random = require("random-seed");
const { getRandomBufferRange, buildRandomLines } = require("./helpers/random");
const TextEditorComponent = require("../src/text-editor-component");
const TextEditorElement = require("../src/text-editor-element");
const TextEditor = require("../src/text-editor");
const ViewRegistry = require("../src/view-registry");
const TextBuffer = require("../src/text-buffer");
const { Point } = TextBuffer;
const fs = require("fs");
const path = require("path");
const electron = require("electron");
const clipboardBridge = require("../src/clipboard-bridge");
const { beginLayoutDrag } = require("../src/layout-drag");
const {
  UPDATE_MODE_NORMAL,
  UPDATE_MODE_SCROLL_TILES,
} = require("../src/text-editor-component-helpers");

function createClipboardData(initialData = {}) {
  const data = new Map(Object.entries(initialData));
  return {
    getData(type) {
      return data.get(type) || "";
    },
    setData(type, value) {
      data.set(type, value);
    },
  };
}

// Define a custom scheduler that uses `setTimeout` instead of
// `requestAnimationFrame` because the latter behaves slowly when the browser
// does not think the editor is visible.
class CustomViewRegistry extends ViewRegistry {
  animationFrameRequest = null;

  clearDocumentRequests() {
    this.documentReaders = [];
    this.documentWriters = [];
    this.nextUpdatePromise = null;
    this.resolveNextUpdatePromise = null;
    if (this.animationFrameRequest != null) {
      clearTimeout(this.animationFrameRequest);
      this.animationFrameRequest = null;
    }
  }

  requestDocumentUpdate() {
    if (this.animationFrameRequest == null) {
      this.animationFrameRequest = setTimeout(this.performDocumentUpdate, 0);
    }
  }
}

let defaultScheduler = TextEditorComponent.getScheduler();
let alternativeScheduler = new CustomViewRegistry(defaultScheduler.props);
// Every `await component.getNextUpdatePromise()` in this file is an untimed
// wait on a single scheduler flush, so the scheduler has to be one that always
// runs. The default one is driven by `requestAnimationFrame`, which this
// Chromium suspends for a window it does not consider rendered (see
// src/initialize-test-window.js) — and macOS, whose WindowServer reports real
// occlusion, is exactly where that happens. Excluding darwin here left it the
// only platform waiting on the compositor, which is what timed out at 120s.
function useAlternativeScheduler() {
  TextEditorComponent.setScheduler(alternativeScheduler);
}

function restoreDefaultScheduler() {
  TextEditorComponent.setScheduler(defaultScheduler);
}

const SAMPLE_TEXT = fs.readFileSync(path.join(__dirname, "fixtures", "sample.js"), "utf8");

const SAMPLE_WITH_RTL_TEXT = fs.readFileSync(
  path.join(__dirname, "fixtures", "sample-with-rtl-text.js"),
  "utf8",
);

class DummyElement extends HTMLElement {
  connectedCallback() {
    this.didAttach();
  }
}

const editors = [];
let verticalScrollbarWidth, horizontalScrollbarHeight;

describe("TextEditorComponent", () => {
  beforeEach(() => {
    useAlternativeScheduler();
  });

  beforeEach(() => {
    if (!window.customElements.get("text-editor-component-test-element")) {
      window.customElements.define("text-editor-component-test-element", DummyElement);
    }
  });

  beforeEach(() => {
    jasmine.useRealClock();

    // Force scrollbars to be visible regardless of local system configuration
    const scrollbarStyle = document.createElement("style");
    scrollbarStyle.textContent =
      "lumine-text-editor ::-webkit-scrollbar { -webkit-appearance: none }";
    jasmine.attachToDOM(scrollbarStyle);

    if (verticalScrollbarWidth == null) {
      const { component, element } = buildComponent({
        text: "abcdefgh\n".repeat(10),
        width: 30,
        height: 30,
      });
      verticalScrollbarWidth = getVerticalScrollbarWidth(component);
      horizontalScrollbarHeight = getHorizontalScrollbarHeight(component);
      element.remove();
    }
  });

  afterEach(() => {
    for (const editor of editors) {
      editor.destroy();
    }
    editors.length = 0;
    // Drop anything still queued, so a spec that did time out cannot bleed a
    // pending writer into the next one.
    alternativeScheduler.clearDocumentRequests();
    restoreDefaultScheduler();
  });

  describe("rendering", () => {
    it("renders lines and line numbers for the visible region", async () => {
      const { component, element, editor } = buildComponent({
        rowsPerTile: 3,
        autoHeight: false,
      });

      expect(queryOnScreenLineNumberElements(element).length).toBe(13);
      expect(queryOnScreenLineElements(element).length).toBe(13);

      element.style.height = 4 * component.measurements.lineHeight + "px";
      await component.getNextUpdatePromise();
      expect(queryOnScreenLineNumberElements(element).length).toBe(9);
      expect(queryOnScreenLineElements(element).length).toBe(9);

      await setScrollTop(component, 5 * component.getLineHeight());

      // After scrolling down beyond > 3 rows, the order of line numbers and lines
      // in the DOM is a bit weird because the first tile is recycled to the bottom
      // when it is scrolled out of view
      expect(
        queryOnScreenLineNumberElements(element).map((element) => element.textContent.trim()),
      ).toEqual(["10", "11", "12", "4", "5", "6", "7", "8", "9"]);
      expect(
        queryOnScreenLineElements(element).map((element) => element.dataset.screenRow),
      ).toEqual(["9", "10", "11", "3", "4", "5", "6", "7", "8"]);
      expect(queryOnScreenLineElements(element).map((element) => element.textContent)).toEqual([
        editor.lineTextForScreenRow(9),
        " ", // this line is blank in the model, but we render a space to prevent the line from collapsing vertically
        editor.lineTextForScreenRow(11),
        editor.lineTextForScreenRow(3),
        editor.lineTextForScreenRow(4),
        editor.lineTextForScreenRow(5),
        editor.lineTextForScreenRow(6),
        editor.lineTextForScreenRow(7),
        editor.lineTextForScreenRow(8),
      ]);

      await setScrollTop(component, 2.5 * component.getLineHeight());
      expect(
        queryOnScreenLineNumberElements(element).map((element) => element.textContent.trim()),
      ).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
      expect(
        queryOnScreenLineElements(element).map((element) => element.dataset.screenRow),
      ).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
      expect(queryOnScreenLineElements(element).map((element) => element.textContent)).toEqual([
        editor.lineTextForScreenRow(0),
        editor.lineTextForScreenRow(1),
        editor.lineTextForScreenRow(2),
        editor.lineTextForScreenRow(3),
        editor.lineTextForScreenRow(4),
        editor.lineTextForScreenRow(5),
        editor.lineTextForScreenRow(6),
        editor.lineTextForScreenRow(7),
        editor.lineTextForScreenRow(8),
      ]);
    });

    it("bases the width of the lines div on the width of the longest initially-visible screen line", async () => {
      const { component, element, editor } = buildComponent({
        rowsPerTile: 2,
        height: 20,
        width: 100,
      });

      {
        expect(editor.getApproximateLongestScreenRow()).toBe(3);
        const expectedWidth = Math.ceil(
          component.pixelPositionForScreenPosition(Point(3, Infinity)).left +
            component.getBaseCharacterWidth(),
        );
        expect(element.querySelector(".lines").style.width).toBe(expectedWidth + "px");
      }

      {
        // Get the next update promise synchronously here to ensure we don't
        // miss the update while polling the condition.
        const nextUpdatePromise = component.getNextUpdatePromise();
        // Drive the requestIdleCallback-scheduled background work directly: a
        // loaded CI renderer can starve idle callbacks (or grant them sub-2ms
        // deadlines, below the display layer's minimum chunk) for longer than
        // any reasonable poll timeout.
        await conditionPromise(() => {
          editor.doBackgroundWork({ didTimeout: false, timeRemaining: () => 100 });
          return editor.getApproximateLongestScreenRow() === 6;
        });
        await nextUpdatePromise;

        // Capture the width of the lines before requesting the width of
        // longest line, because making that request forces a DOM update
        const actualWidth = element.querySelector(".lines").style.width;
        const expectedWidth = Math.ceil(
          component.pixelPositionForScreenPosition(Point(6, Infinity)).left +
            component.getBaseCharacterWidth(),
        );
        expect(actualWidth).toBe(expectedWidth + "px");
      }

      {
        // Make sure we do not throw an error if a synchronous update is
        // triggered before measuring the longest line from a
        // previously-scheduled update.
        editor.getBuffer().insert(Point(12, Infinity), "x".repeat(100));
        expect(editor.getLongestScreenRow()).toBe(12);

        TextEditorComponent.getScheduler().readDocument(() => {
          // This will happen before the measurement phase of the update
          // triggered above.
          component.pixelPositionForScreenPosition(Point(11, Infinity));
        });

        await component.getNextUpdatePromise();
      }
    });

    it("re-renders lines when their height changes", async () => {
      const { component, element } = buildComponent({
        rowsPerTile: 3,
        autoHeight: false,
      });
      element.style.height = 4 * component.measurements.lineHeight + "px";
      await component.getNextUpdatePromise();
      expect(queryOnScreenLineNumberElements(element).length).toBe(9);
      expect(queryOnScreenLineElements(element).length).toBe(9);

      element.style.lineHeight = "2.0";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      expect(queryOnScreenLineNumberElements(element).length).toBe(6);
      expect(queryOnScreenLineElements(element).length).toBe(6);

      element.style.lineHeight = "0.7";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      expect(queryOnScreenLineNumberElements(element).length).toBe(12);
      expect(queryOnScreenLineElements(element).length).toBe(12);

      element.style.lineHeight = "0.05";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      expect(queryOnScreenLineNumberElements(element).length).toBe(13);
      expect(queryOnScreenLineElements(element).length).toBe(13);

      element.style.lineHeight = "0";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      expect(queryOnScreenLineNumberElements(element).length).toBe(13);
      expect(queryOnScreenLineElements(element).length).toBe(13);

      element.style.lineHeight = "1";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      expect(queryOnScreenLineNumberElements(element).length).toBe(9);
      expect(queryOnScreenLineElements(element).length).toBe(9);
    });

    it("makes the content at least as tall as the scroll container client height", async () => {
      const { component, editor } = buildComponent({
        text: "a".repeat(100),
        width: 50,
        height: 100,
      });
      expect(component.refs.content.offsetHeight).toBe(
        100 - getHorizontalScrollbarHeight(component),
      );

      editor.setText("a\n".repeat(30));
      await component.getNextUpdatePromise();
      expect(component.refs.content.offsetHeight).toBeGreaterThan(100);
      expect(component.refs.content.offsetHeight).toBeNear(component.getContentHeight(), 2);
    });

    it("honors the scrollPastEnd option by adding empty space equivalent to the clientHeight to the end of the content area", async () => {
      const { component, editor } = buildComponent({
        autoHeight: false,
        autoWidth: false,
      });

      await editor.update({ scrollPastEnd: true });
      await setEditorHeightInLines(component, 6);

      // scroll to end
      await setScrollTop(component, Infinity);
      expect(component.getFirstVisibleRow()).toBe(editor.getScreenLineCount() - 3);

      editor.update({ scrollPastEnd: false });
      await component.getNextUpdatePromise(); // wait for scrollable content resize
      expect(component.getFirstVisibleRow()).toBe(editor.getScreenLineCount() - 6);

      // Always allows at least 3 lines worth of overscroll if the editor is short
      await setEditorHeightInLines(component, 2);
      await editor.update({ scrollPastEnd: true });
      await setScrollTop(component, Infinity);
      expect(component.getFirstVisibleRow()).toBe(editor.getScreenLineCount() + 1);
    });

    it("does not fire onDidChangeScrollTop listeners when assigning the same maximal value and the content height has fractional pixels (regression)", async () => {
      const { component, element, editor } = buildComponent({
        autoHeight: false,
        autoWidth: false,
      });
      await setEditorHeightInLines(component, 3);

      // Force a fractional content height with a block decoration
      const item = document.createElement("div");
      item.style.height = "10.6px";
      editor.decorateMarker(editor.markBufferPosition([0, 0]), {
        type: "block",
        item,
      });
      await component.getNextUpdatePromise();

      component.setScrollTop(Infinity);
      element.onDidChangeScrollTop((_newScrollTop) => {
        throw new Error("Scroll top should not have changed");
      });
      component.setScrollTop(component.getScrollTop());
    });

    it("gives the line number tiles an explicit width and height so their layout can be strictly contained", async () => {
      const { component, editor } = buildComponent({ rowsPerTile: 3 });

      const lineNumberGutterElement = component.refs.gutterContainer.refs.lineNumberGutter.element;
      expect(lineNumberGutterElement.offsetHeight).toBeNear(component.getScrollHeight());

      for (const child of lineNumberGutterElement.children) {
        expect(child.offsetWidth).toBe(lineNumberGutterElement.offsetWidth);
        if (!child.classList.contains("line-number")) {
          for (const lineNumberElement of child.children) {
            expect(lineNumberElement.offsetWidth).toBe(lineNumberGutterElement.offsetWidth);
          }
        }
      }

      editor.setText("x\n".repeat(99));
      await component.getNextUpdatePromise();
      expect(lineNumberGutterElement.offsetHeight).toBeNear(component.getScrollHeight());
      for (const child of lineNumberGutterElement.children) {
        expect(child.offsetWidth).toBe(lineNumberGutterElement.offsetWidth);
        if (!child.classList.contains("line-number")) {
          for (const lineNumberElement of child.children) {
            expect(lineNumberElement.offsetWidth).toBe(lineNumberGutterElement.offsetWidth);
          }
        }
      }
    });

    it("keeps the number of tiles stable when the visible line count changes during vertical scrolling", async () => {
      const { component } = buildComponent({
        rowsPerTile: 3,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 5.5);
      expect(component.refs.lineTiles.children.length).toBe(3 + 2); // account for cursors and highlights containers

      await setScrollTop(component, 0.5 * component.getLineHeight());
      expect(component.refs.lineTiles.children.length).toBe(3 + 2); // account for cursors and highlights containers

      await setScrollTop(component, 1 * component.getLineHeight());
      expect(component.refs.lineTiles.children.length).toBe(3 + 2); // account for cursors and highlights containers
    });

    it("recycles tiles on resize", async () => {
      const { component } = buildComponent({
        rowsPerTile: 2,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 7);
      await setScrollTop(component, 3.5 * component.getLineHeight());
      const lineNode = lineNodeForScreenRow(component, 7);
      await setEditorHeightInLines(component, 4);
      expect(lineNodeForScreenRow(component, 7)).toBe(lineNode);
    });

    it("updates lines numbers when a row's foldability changes (regression)", async () => {
      const { component, editor } = buildComponent({ text: "abc\n" });
      editor.setCursorBufferPosition([1, 0]);
      await component.getNextUpdatePromise();
      expect(lineNumberNodeForScreenRow(component, 0).classList.contains("foldable")).toBe(false);

      editor.insertText("  def");
      await component.getNextUpdatePromise();
      expect(lineNumberNodeForScreenRow(component, 0).classList.contains("foldable")).toBe(true);

      editor.undo();
      await component.getNextUpdatePromise();
      expect(lineNumberNodeForScreenRow(component, 0).classList.contains("foldable")).toBe(false);
    });

    it("shows the foldable icon on the last screen row of a buffer row that can be folded", async () => {
      const { component } = buildComponent({
        text: "abc\n  de\nfghijklm\n  no",
        softWrapped: true,
      });
      await setEditorWidthInCharacters(component, 5);
      expect(lineNumberNodeForScreenRow(component, 0).classList.contains("foldable")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 1).classList.contains("foldable")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 2).classList.contains("foldable")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 3).classList.contains("foldable")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 4).classList.contains("foldable")).toBe(false);
    });

    it("renders dummy vertical and horizontal scrollbars when content overflows", async () => {
      const { component, editor } = buildComponent({
        height: 100,
        width: 100,
      });
      const verticalScrollbar = component.refs.verticalScrollbar.element;
      const horizontalScrollbar = component.refs.horizontalScrollbar.element;
      expect(verticalScrollbar.scrollHeight).toBeNear(component.getContentHeight());
      expect(horizontalScrollbar.scrollWidth).toBeNear(component.getContentWidth());
      expect(getVerticalScrollbarWidth(component)).toBeGreaterThan(0);
      expect(getHorizontalScrollbarHeight(component)).toBeGreaterThan(0);
      expect(verticalScrollbar.style.bottom).toBe(getVerticalScrollbarWidth(component) + "px");
      expect(verticalScrollbar.style.visibility).toBe("");
      expect(horizontalScrollbar.style.right).toBe(getHorizontalScrollbarHeight(component) + "px");
      expect(horizontalScrollbar.style.visibility).toBe("");
      expect(component.refs.scrollbarCorner).toBeDefined();
      expect(component.refs.scrollbarCorner.style.visibility).toBe("");

      setScrollTop(component, 100);
      await setScrollLeft(component, 100);
      expect(verticalScrollbar.scrollTop).toBe(100);
      expect(horizontalScrollbar.scrollLeft).toBe(100);

      verticalScrollbar.scrollTop = 120;
      verticalScrollbar.dispatchEvent(new Event("scroll"));
      horizontalScrollbar.scrollLeft = 120;
      horizontalScrollbar.dispatchEvent(new Event("scroll"));
      expect(component.getScrollTop()).toBe(120);
      expect(component.getScrollLeft()).toBe(120);

      editor.setText("a\n".repeat(15));
      await component.getNextUpdatePromise();
      expect(getVerticalScrollbarWidth(component)).toBeGreaterThan(0);
      expect(getHorizontalScrollbarHeight(component)).toBe(0);
      expect(verticalScrollbar.style.visibility).toBe("");
      expect(horizontalScrollbar.style.visibility).toBe("hidden");
      expect(component.refs.scrollbarCorner.style.visibility).toBe("hidden");

      editor.setText("a".repeat(100));
      await component.getNextUpdatePromise();
      expect(getVerticalScrollbarWidth(component)).toBe(0);
      expect(getHorizontalScrollbarHeight(component)).toBeGreaterThan(0);
      expect(verticalScrollbar.style.visibility).toBe("hidden");
      expect(horizontalScrollbar.style.visibility).toBe("");
      expect(component.refs.scrollbarCorner.style.visibility).toBe("hidden");

      editor.setText("");
      await component.getNextUpdatePromise();
      expect(getVerticalScrollbarWidth(component)).toBe(0);
      expect(getHorizontalScrollbarHeight(component)).toBe(0);
      expect(verticalScrollbar.style.visibility).toBe("hidden");
      expect(horizontalScrollbar.style.visibility).toBe("hidden");
      expect(component.refs.scrollbarCorner.style.visibility).toBe("hidden");
    });

    it("shows the vertical scrollbar for a short file when scrollPastEnd makes it scrollable (regression)", async () => {
      const { component, editor } = buildComponent({
        autoHeight: false,
        autoWidth: false,
      });
      await editor.update({ scrollPastEnd: true });
      await setEditorHeightInLines(component, 20);

      // A file much shorter than the viewport: the real content does not
      // overflow, but the scroll-past-end padding still makes the editor
      // scrollable. The thumb must be visible whenever scrolling is possible.
      editor.setText("a\n".repeat(5));
      await component.getNextUpdatePromise();

      expect(component.getContentHeight()).toBeLessThan(component.getScrollContainerClientHeight());
      expect(component.getMaxScrollTop()).toBeGreaterThan(0);
      expect(component.canScrollVertically()).toBe(true);
      expect(component.refs.verticalScrollbar.element.style.visibility).toBe("");
    });

    describe("when scrollbar styles change or the editor element is detached and then reattached", () => {
      it("updates the bottom/right of dummy scrollbars and client height/width measurements", async () => {
        const { component, element, editor } = buildComponent({
          height: 100,
          width: 100,
        });
        expect(getHorizontalScrollbarHeight(component)).toBeGreaterThan(10);
        expect(getVerticalScrollbarWidth(component)).toBeGreaterThan(10);
        setScrollTop(component, 20);
        setScrollLeft(component, 10);
        await component.getNextUpdatePromise();

        // Updating scrollbar styles.
        const style = document.createElement("style");
        style.textContent = "::-webkit-scrollbar { height: 10px; width: 10px; }";
        jasmine.attachToDOM(style);
        TextEditor.didUpdateScrollbarStyles();
        await component.getNextUpdatePromise();

        expect(getHorizontalScrollbarHeight(component)).toBeNear(10);
        expect(getVerticalScrollbarWidth(component)).toBeNear(10);
        expect(component.refs.horizontalScrollbar.element.style.right).toHaveNearPixels("10px");
        expect(component.refs.verticalScrollbar.element.style.bottom).toHaveNearPixels("10px");
        expect(component.refs.horizontalScrollbar.element.scrollLeft).toBeNear(10);
        expect(component.refs.verticalScrollbar.element.scrollTop).toBeNear(20);
        expect(component.getScrollContainerClientHeight()).toBeNear(100 - 10);
        expect(component.getScrollContainerClientWidth()).toBeNear(
          100 - component.getGutterContainerWidth() - 10,
        );

        // Detaching and re-attaching the editor element.
        element.remove();
        jasmine.attachToDOM(element);

        expect(getHorizontalScrollbarHeight(component)).toBeNear(10);
        expect(getVerticalScrollbarWidth(component)).toBeNear(10);
        expect(component.refs.horizontalScrollbar.element.style.right).toHaveNearPixels("10px");
        expect(component.refs.verticalScrollbar.element.style.bottom).toHaveNearPixels("10px");
        expect(component.refs.horizontalScrollbar.element.scrollLeft).toBeNear(10);
        expect(component.refs.verticalScrollbar.element.scrollTop).toBeNear(20);
        expect(component.getScrollContainerClientHeight()).toBeNear(100 - 10);
        expect(component.getScrollContainerClientWidth()).toBeNear(
          100 - component.getGutterContainerWidth() - 10,
        );

        // Ensure we don't throw an error trying to remeasure non-existent scrollbars for mini editors.
        await editor.update({ mini: true });
        TextEditor.didUpdateScrollbarStyles();
        component.scheduleUpdate();
        await component.getNextUpdatePromise();
      });
    });

    it("renders cursors within the visible row range", async () => {
      const { component, element, editor } = buildComponent({
        height: 40,
        rowsPerTile: 2,
      });
      await setScrollTop(component, 100);

      expect(component.getRenderedStartRow()).toBe(4);
      expect(component.getRenderedEndRow()).toBe(10);

      editor.setCursorScreenPosition([0, 0], { autoscroll: false }); // out of view
      editor.addCursorAtScreenPosition([2, 2], { autoscroll: false }); // out of view
      editor.addCursorAtScreenPosition([4, 0], { autoscroll: false }); // line start
      editor.addCursorAtScreenPosition([4, 4], { autoscroll: false }); // at token boundary
      editor.addCursorAtScreenPosition([4, 6], { autoscroll: false }); // within token
      editor.addCursorAtScreenPosition([5, Infinity], { autoscroll: false }); // line end
      editor.addCursorAtScreenPosition([10, 2], { autoscroll: false }); // out of view
      await component.getNextUpdatePromise();

      let cursorNodes = Array.from(element.querySelectorAll(".cursor"));
      expect(cursorNodes.length).toBe(4);
      verifyCursorPosition(component, cursorNodes[0], 4, 0);
      verifyCursorPosition(component, cursorNodes[1], 4, 4);
      verifyCursorPosition(component, cursorNodes[2], 4, 6);
      verifyCursorPosition(component, cursorNodes[3], 5, 30);

      editor.setCursorScreenPosition([8, 11], { autoscroll: false });
      await component.getNextUpdatePromise();

      cursorNodes = Array.from(element.querySelectorAll(".cursor"));
      expect(cursorNodes.length).toBe(1);
      verifyCursorPosition(component, cursorNodes[0], 8, 11);

      editor.setCursorScreenPosition([0, 0], { autoscroll: false });
      await component.getNextUpdatePromise();

      cursorNodes = Array.from(element.querySelectorAll(".cursor"));
      expect(cursorNodes.length).toBe(0);

      editor.setSelectedScreenRange(
        [
          [8, 0],
          [12, 0],
        ],
        { autoscroll: false },
      );
      await component.getNextUpdatePromise();
      cursorNodes = Array.from(element.querySelectorAll(".cursor"));
      expect(cursorNodes.length).toBe(0);
    });

    jasmine.itWithDocumentFocus(
      "blinks cursors when the editor is focused and the cursors are not moving",
      async () => {
        let blink;
        const cursorBlinkPeriod = 40;
        // Match this editor's own blink interval by its period rather than
        // taking whichever callback was registered last: another editor left
        // over from an earlier spec can start blinking on a real timer while
        // this one runs, and driving that one blinks nothing here.
        spyOn(window, "setInterval").and.callFake((callback, period) => {
          if (period === cursorBlinkPeriod / 2) blink = callback;
          return 1;
        });
        spyOn(window, "clearInterval");

        // Every selection change here schedules a blink resume on a real timer,
        // and a resume blinks the cursors back off. At the default 300ms that is
        // a race the assertions below lose whenever a frame runs long under
        // full-suite load. No spec covers resumption, so push it out of reach
        // rather than depending on the wall clock.
        const { component, element, editor } = buildComponent({
          cursorBlinkPeriod,
          cursorBlinkResumeDelay: 10000,
        });
        editor.addCursorAtScreenPosition([1, 0]);

        element.focus();
        await component.getNextUpdatePromise();
        // Windows CI can momentarily drop OS window focus during the async
        // update, which blurs the hidden input and clears `is-focused` — the
        // only rule that gives a cursor `opacity: 1`, so every assertion below
        // reads 0 instead. Re-establish focus through the component's own entry
        // point, then render each blink synchronously rather than awaiting an
        // update: with no yield left between the blinks and the assertions that
        // read them, no blur can be delivered in between.
        component.didFocus();
        component.updateSync();
        const [cursor1, cursor2] = element.querySelectorAll(".cursor");

        expect(getComputedStyle(cursor1).opacity).toBe("1");
        expect(getComputedStyle(cursor2).opacity).toBe("1");

        blink();
        component.updateSync();
        expect(getComputedStyle(cursor1).opacity).toBe("0");
        expect(getComputedStyle(cursor2).opacity).toBe("0");

        blink();
        component.updateSync();
        expect(getComputedStyle(cursor1).opacity).toBe("1");
        expect(getComputedStyle(cursor2).opacity).toBe("1");

        editor.moveRight();
        component.updateSync();

        expect(getComputedStyle(cursor1).opacity).toBe("1");
        expect(getComputedStyle(cursor2).opacity).toBe("1");
        expect(window.clearInterval).toHaveBeenCalledWith(1);
      },
    );

    it('gives cursors at the end of lines the width of an "x" character', async () => {
      const { component, element, editor } = buildComponent();
      editor.setText("abcde");
      await setEditorWidthInCharacters(component, 5.5);

      editor.setCursorScreenPosition([0, Infinity]);
      await component.getNextUpdatePromise();
      expect(element.querySelector(".cursor").offsetWidth).toBe(
        Math.round(component.getBaseCharacterWidth()),
      );

      // Clip cursor width when soft-wrap is on and the cursor is at the end of
      // the line. This prevents the parent tile from disabling sub-pixel
      // anti-aliasing. For some reason, adding overflow: hidden to the cursor
      // container doesn't solve this issue so we're adding this workaround instead.
      editor.setSoftWrapped(true);
      await component.getNextUpdatePromise();
      expect(element.querySelector(".cursor").getBoundingClientRect().width).toBeLessThanOrEqual(
        component.getBaseCharacterWidth(),
      );
    });

    it("positions and sizes cursors correctly when they are located next to a fold marker", async () => {
      const { component, element, editor } = buildComponent();
      editor.foldBufferRange([
        [0, 3],
        [0, 6],
      ]);

      editor.setCursorScreenPosition([0, 3]);
      await component.getNextUpdatePromise();
      verifyCursorPosition(component, element.querySelector(".cursor"), 0, 3);

      editor.setCursorScreenPosition([0, 4]);
      await component.getNextUpdatePromise();
      verifyCursorPosition(component, element.querySelector(".cursor"), 0, 4);
    });

    it("positions cursors and placeholder text correctly when the lines container has a margin and/or is padded", async () => {
      const { component, element, editor } = buildComponent({
        placeholderText: "testing",
      });

      component.refs.lineTiles.style.marginLeft = "10px";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();

      editor.setCursorBufferPosition([0, 3]);
      await component.getNextUpdatePromise();
      verifyCursorPosition(component, element.querySelector(".cursor"), 0, 3);

      editor.setCursorScreenPosition([1, 0]);
      await component.getNextUpdatePromise();
      verifyCursorPosition(component, element.querySelector(".cursor"), 1, 0);

      component.refs.lineTiles.style.paddingTop = "5px";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      verifyCursorPosition(component, element.querySelector(".cursor"), 1, 0);

      editor.setCursorScreenPosition([2, 2]);
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      verifyCursorPosition(component, element.querySelector(".cursor"), 2, 2);

      editor.setText("");
      await component.getNextUpdatePromise();

      const placeholderText = element.querySelector(".placeholder-text");
      const placeholderTextLeft = placeholderText.getBoundingClientRect().left;
      const linesLeft = component.refs.lineTiles.getBoundingClientRect().left;
      expect(placeholderTextLeft).toBe(linesLeft);
      expect(parseFloat(getComputedStyle(placeholderText).paddingInlineStart)).toBeGreaterThan(0);
    });

    it("places the hidden input element at the location of the last cursor if it is visible", async () => {
      const { component, editor } = buildComponent({
        height: 60,
        width: 120,
        rowsPerTile: 2,
      });
      const { hiddenInput } = component.refs.cursorsAndInput.refs;
      setScrollTop(component, 100);
      await setScrollLeft(component, 40);

      expect(component.getRenderedStartRow()).toBe(4);
      expect(component.getRenderedEndRow()).toBe(10);

      // When out of view, the hidden input is positioned at 0, 0
      expect(editor.getCursorScreenPosition()).toEqual([0, 0]);
      expect(hiddenInput.offsetTop).toBe(0);
      expect(hiddenInput.offsetLeft).toBe(0);

      // Otherwise it is positioned at the last cursor position
      editor.addCursorAtScreenPosition([7, 4]);
      await component.getNextUpdatePromise();
      expect(hiddenInput.getBoundingClientRect().top).toBe(clientTopForLine(component, 7));
      expect(Math.round(hiddenInput.getBoundingClientRect().left)).toBeNear(
        clientLeftForCharacter(component, 7, 4),
      );
    });

    it("soft wraps lines based on the content width when soft wrap is enabled", async () => {
      let baseCharacterWidth, gutterContainerWidth;
      {
        const { component, editor } = buildComponent();
        baseCharacterWidth = component.getBaseCharacterWidth();
        gutterContainerWidth = component.getGutterContainerWidth();
        editor.destroy();
      }

      const { component, element, editor } = buildComponent({
        width: gutterContainerWidth + baseCharacterWidth * 55,
        attach: false,
      });
      editor.setSoftWrapped(true);
      jasmine.attachToDOM(element);

      expect(getEditorWidthInBaseCharacters(component)).toBe(55);
      expect(lineNodeForScreenRow(component, 3).textContent).toBe(
        "    var pivot = items.shift(), current, left = [], ",
      );
      expect(lineNodeForScreenRow(component, 4).textContent).toBe("    right = [];");

      const { scrollContainer } = component.refs;
      expect(scrollContainer.clientWidth).toBe(scrollContainer.scrollWidth);
    });

    it("correctly forces the display layer to index visible rows when resizing (regression)", async () => {
      const text = "a".repeat(30) + "\n" + "b".repeat(1000);
      const { component, element, editor } = buildComponent({
        height: 300,
        width: 800,
        attach: false,
        text,
      });
      editor.setSoftWrapped(true);
      jasmine.attachToDOM(element);

      element.style.width = 200 + "px";
      await component.getNextUpdatePromise();
      expect(queryOnScreenLineElements(element).length).toBe(24);
    });

    it("decorates the line numbers of folded lines", async () => {
      const { component, editor } = buildComponent();
      editor.foldBufferRow(1);
      await component.getNextUpdatePromise();
      expect(lineNumberNodeForScreenRow(component, 1).classList.contains("folded")).toBe(true);
    });

    it("makes lines at least as wide as the scrollContainer", async () => {
      const { component, element, editor } = buildComponent();
      const { scrollContainer } = component.refs;
      editor.setText("a");
      await component.getNextUpdatePromise();

      expect(element.querySelector(".line").offsetWidth).toBe(
        scrollContainer.offsetWidth - verticalScrollbarWidth,
      );
    });

    it("resizes based on the content when the autoHeight and/or autoWidth options are true", async () => {
      const { component, element, editor } = buildComponent({
        autoHeight: true,
        autoWidth: true,
      });
      const editorPadding = 3;
      element.style.padding = editorPadding + "px";
      const initialWidth = element.offsetWidth;
      const initialHeight = element.offsetHeight;
      // An auto-width editor can never scroll horizontally and an auto-height
      // one can never scroll vertically, so no scrollbar space is reserved:
      // the element hugs its content exactly.
      expect(initialWidth).toBe(
        component.getGutterContainerWidth() + component.getContentWidth() + 2 * editorPadding,
      );
      expect(initialHeight).toBeNear(component.getContentHeight() + 2 * editorPadding);

      // When autoWidth is enabled, width adjusts to content
      editor.setCursorScreenPosition([6, Infinity]);
      editor.insertText("x".repeat(50));
      await component.getNextUpdatePromise();
      expect(element.offsetWidth).toBe(
        component.getGutterContainerWidth() + component.getContentWidth() + 2 * editorPadding,
      );
      expect(element.offsetWidth).toBeGreaterThan(initialWidth);

      // When autoHeight is enabled, height adjusts to content
      editor.insertText("\n".repeat(5));
      await component.getNextUpdatePromise();
      expect(element.offsetHeight).toBeNear(component.getContentHeight() + 2 * editorPadding);
      expect(element.offsetHeight).toBeGreaterThan(initialHeight);
    });

    it("does not render the line number gutter at all if the isLineNumberGutterVisible parameter is false", () => {
      const { element } = buildComponent({
        lineNumberGutterVisible: false,
      });
      expect(element.querySelector(".line-number")).toBe(null);
    });

    it("does not duplicate gutter content when the line number gutter is hidden and shown again", async () => {
      const { component, element, editor } = buildComponent();
      const gutterElement = editor.getLineNumberGutter().getElement();
      const dummyCount = gutterElement.querySelectorAll(".line-number.dummy").length;
      const lineNumberCount = gutterElement.querySelectorAll(".line-number").length;
      expect(dummyCount).toBe(1);
      expect(lineNumberCount).toBeGreaterThan(1);

      editor.setLineNumberGutterVisible(false);
      await component.getNextUpdatePromise();
      expect(element.contains(gutterElement)).toBe(false);

      editor.setLineNumberGutterVisible(true);
      await component.getNextUpdatePromise();
      expect(element.contains(gutterElement)).toBe(true);
      expect(gutterElement.querySelectorAll(".line-number.dummy").length).toBe(dummyCount);
      expect(gutterElement.querySelectorAll(".line-number").length).toBe(lineNumberCount);
    });

    it("does not render the line numbers but still renders the line number gutter if showLineNumbers is false", async () => {
      function checkScrollContainerLeft(component) {
        const { scrollContainer, gutterContainer } = component.refs;
        expect(scrollContainer.getBoundingClientRect().left).toBeNear(
          Math.round(gutterContainer.element.getBoundingClientRect().right),
        );
      }

      const { component, element, editor } = buildComponent({
        showLineNumbers: false,
      });
      expect(
        Array.from(element.querySelectorAll(".line-number")).every((e) => e.textContent === ""),
      ).toBe(true);
      checkScrollContainerLeft(component);

      await editor.update({ showLineNumbers: true });
      expect(
        Array.from(element.querySelectorAll(".line-number")).map((e) => e.textContent),
      ).toEqual(["00", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"]);
      checkScrollContainerLeft(component);

      await editor.update({ showLineNumbers: false });
      expect(
        Array.from(element.querySelectorAll(".line-number")).every((e) => e.textContent === ""),
      ).toBe(true);
      checkScrollContainerLeft(component);
    });

    it("supports the placeholderText parameter", () => {
      const placeholderText = "Placeholder Test";
      const { element } = buildComponent({ placeholderText, text: "" });
      expect(element.textContent).toContain(placeholderText);
    });

    it("adds the data-grammar attribute and updates it when the grammar changes", async () => {
      await lumine.packages.activatePackage("language-javascript");

      const { editor, element, component } = buildComponent();
      expect(element.dataset.grammar).toBe("text plain null-grammar");

      lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.js");
      await component.getNextUpdatePromise();
      expect(element.dataset.grammar).toBe("source js");
    });

    it("adds the data-encoding attribute and updates it when the encoding changes", async () => {
      const { editor, element, component } = buildComponent();
      expect(element.dataset.encoding).toBe("utf8");

      editor.setEncoding("ascii");
      await component.getNextUpdatePromise();
      expect(element.dataset.encoding).toBe("ascii");
    });

    it("adds the has-selection class when the editor has a non-empty selection", async () => {
      const { editor, element, component } = buildComponent();
      expect(element.classList.contains("has-selection")).toBe(false);

      editor.setSelectedBufferRanges([
        [
          [0, 0],
          [0, 0],
        ],
        [
          [1, 0],
          [1, 10],
        ],
      ]);
      await component.getNextUpdatePromise();
      expect(element.classList.contains("has-selection")).toBe(true);

      editor.setSelectedBufferRanges([
        [
          [0, 0],
          [0, 0],
        ],
        [
          [1, 0],
          [1, 0],
        ],
      ]);
      await component.getNextUpdatePromise();
      expect(element.classList.contains("has-selection")).toBe(false);
    });

    it("assigns buffer-row and screen-row to each line number as data fields", async () => {
      const { editor, element, component } = buildComponent();
      editor.setSoftWrapped(true);
      await component.getNextUpdatePromise();
      await setEditorWidthInCharacters(component, 40);
      {
        const bufferRows = queryOnScreenLineNumberElements(element).map((e) => e.dataset.bufferRow);
        const screenRows = queryOnScreenLineNumberElements(element).map((e) => e.dataset.screenRow);
        expect(bufferRows).toEqual([
          "0",
          "1",
          "2",
          "2",
          "3",
          "3",
          "4",
          "5",
          "6",
          "6",
          "6",
          "7",
          "8",
          "8",
          "8",
          "9",
          "10",
          "11",
          "11",
          "12",
        ]);
        expect(screenRows).toEqual([
          "0",
          "1",
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "9",
          "10",
          "11",
          "12",
          "13",
          "14",
          "15",
          "16",
          "17",
          "18",
          "19",
        ]);
      }

      editor.getBuffer().insert([2, 0], "\n");
      await component.getNextUpdatePromise();
      {
        const bufferRows = queryOnScreenLineNumberElements(element).map((e) => e.dataset.bufferRow);
        const screenRows = queryOnScreenLineNumberElements(element).map((e) => e.dataset.screenRow);
        expect(bufferRows).toEqual([
          "0",
          "1",
          "2",
          "3",
          "3",
          "4",
          "4",
          "5",
          "6",
          "7",
          "7",
          "7",
          "8",
          "9",
          "9",
          "9",
          "10",
          "11",
          "12",
          "12",
          "13",
        ]);
        expect(screenRows).toEqual([
          "0",
          "1",
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "9",
          "10",
          "11",
          "12",
          "13",
          "14",
          "15",
          "16",
          "17",
          "18",
          "19",
          "20",
        ]);
      }
    });

    jasmine.itWithDocumentFocus(
      "does not blow away class names added to the element by packages when changing the class name",
      async () => {
        const { component, element } = buildComponent();
        element.classList.add("a", "b");
        expect(element.className).toBe("editor a b");
        element.focus();
        await component.getNextUpdatePromise();
        await wait(0);
        // Windows CI can momentarily drop OS window focus during the async
        // update, which blurs the hidden input and clears `is-focused` before
        // the assertion. Re-establish focus through the component's own entry
        // point and render synchronously, leaving no async gap.
        component.didFocus();
        component.updateSync();
        expect(element.className).toBe("editor a b is-focused");
        document.body.focus();
        // Mirror of the focus half above. Losing OS focus is delivered
        // asynchronously too, so a contended runner can process the blur after
        // the assertion and leave `is-focused` behind. Drive the component's
        // own blur entry point and render synchronously, leaving no async gap.
        component.didBlurHiddenInput({ type: "blur", relatedTarget: document.body });
        component.updateSync();
        expect(element.className).toBe("editor a b");
      },
    );

    jasmine.itWithDocumentFocus(
      "does not blow away class names managed by the component when packages change the element class name",
      async () => {
        const { component, element } = buildComponent({ mini: true });
        element.classList.add("a", "b");
        element.focus();
        await component.getNextUpdatePromise();
        // Same spurious-blur hazard as below: re-establish focus synchronously
        // before asserting.
        component.didFocus();
        component.updateSync();
        expect(element.className).toBe("editor mini a b is-focused");
        element.className = "a c d";
        // Windows CI can momentarily drop OS window focus during an async update, which blurs
        // the hidden input and clears `focused`, dropping `is-focused` from the re-render.
        // Re-establish focus through the component's own entry point (which sets `focused`
        // directly rather than depending on OS focus) and render synchronously so no async gap
        // remains for a spurious blur to clear it before the assertion.
        component.didFocus();
        component.updateSync();
        expect(element.className).toBe("a c d editor is-focused mini");
      },
    );

    it("ignores resize events when the editor is hidden", async () => {
      const { component, element } = buildComponent({
        autoHeight: false,
      });
      element.style.height = 5 * component.getLineHeight() + "px";
      await component.getNextUpdatePromise();
      const originalClientContainerHeight = component.getClientContainerHeight();
      const originalGutterContainerWidth = component.getGutterContainerWidth();
      const originalLineNumberGutterWidth = component.getLineNumberGutterWidth();
      expect(originalClientContainerHeight).toBeGreaterThan(0);
      expect(originalGutterContainerWidth).toBeGreaterThan(0);
      expect(originalLineNumberGutterWidth).toBeGreaterThan(0);

      element.style.display = "none";
      // In production, resize events are triggered before the intersection
      // observer detects the editor's visibility has changed. In tests, we are
      // unable to reproduce this scenario and so we simulate them.
      expect(component.visible).toBe(true);
      component.didResize();
      component.didResizeGutterContainer();
      expect(component.getClientContainerHeight()).toBe(originalClientContainerHeight);
      expect(component.getGutterContainerWidth()).toBe(originalGutterContainerWidth);
      expect(component.getLineNumberGutterWidth()).toBe(originalLineNumberGutterWidth);

      // Ensure measurements stay the same after receiving the intersection
      // observer events.
      await conditionPromise(() => !component.visible);
      expect(component.getClientContainerHeight()).toBe(originalClientContainerHeight);
      expect(component.getGutterContainerWidth()).toBe(originalGutterContainerWidth);
      expect(component.getLineNumberGutterWidth()).toBe(originalLineNumberGutterWidth);
    });

    it("re-measures when the client container is resized without the element", async () => {
      const { component, element } = buildComponent({ autoHeight: false });
      const initialWidth = component.getClientContainerWidth();
      expect(initialWidth).toBe(element.offsetWidth);

      // This is how the minimap resizes an editor: it attaches itself as a flex
      // sibling of the client container, so the container gets narrower while
      // the element the component lives in keeps its size.
      element.style.display = "flex";
      component.refs.clientContainer.style.flex = "0 0 75%";
      const sibling = document.createElement("div");
      sibling.style.flex = "0 0 25%";
      element.appendChild(sibling);

      await conditionPromise(() => component.getClientContainerWidth() < initialWidth);
      expect(component.getClientContainerWidth()).toBe(component.refs.clientContainer.offsetWidth);
      expect(element.offsetWidth).toBe(initialWidth);

      sibling.remove();
      component.refs.clientContainer.style.flex = "";

      await conditionPromise(() => component.getClientContainerWidth() === initialWidth);
    });

    it("leaves the client container of auto-sized editors unobserved", async () => {
      // The component sizes that container itself on every update when the
      // editor is auto-sized, so observing it would measure back the size the
      // component just wrote.
      const { component, element, editor } = buildComponent({ autoHeight: true });
      await component.getNextUpdatePromise();
      expect(component.observingClientContainer).toBe(false);

      editor.update({ autoHeight: false });
      element.style.height = "300px";
      component.updateSync();
      expect(component.observingClientContainer).toBe(true);

      editor.update({ autoHeight: true });
      component.updateSync();
      expect(component.observingClientContainer).toBe(false);
    });

    it("bails out of an in-flight scheduled update when the editor is destroyed before the flush (regression)", async () => {
      const { component, editor } = buildComponent();

      // updateSync hands its measure and after-measure phases to the document
      // scheduler, which flushes on a later frame - an editor destroyed in
      // that gap must not be measured or rendered (see scheduleUpdate: a
      // destroyed editor must never render).
      component.updateSync({ useScheduler: true });
      spyOn(component, "measureContentDuringUpdateSync").and.callThrough();
      spyOn(component, "renderSync").and.callThrough();
      editor.destroy();
      TextEditorComponent.getScheduler().performDocumentUpdate();

      expect(component.measureContentDuringUpdateSync).not.toHaveBeenCalled();
      expect(component.renderSync).not.toHaveBeenCalled();
    });

    describe("randomized tests", () => {
      let originalTimeout;

      beforeEach(() => {
        useAlternativeScheduler();
        originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
        jasmine.DEFAULT_TIMEOUT_INTERVAL = 60 * 1000;
      });

      afterEach(() => {
        jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
        restoreDefaultScheduler();
      });

      it("renders the visible rows correctly after randomly mutating the editor", async () => {
        const initialSeed = Date.now();
        for (var i = 0; i < 20; i++) {
          let seed = initialSeed + i;
          // seed = 1520247533732
          const failureMessage = "Randomized test failed with seed: " + seed;
          const random = Random(seed);

          const rowsPerTile = random.intBetween(1, 6);
          const { component, element, editor } = buildComponent({
            rowsPerTile,
            autoHeight: false,
          });
          editor.setSoftWrapped(Boolean(random(2)));
          await setEditorWidthInCharacters(component, random(20));
          await setEditorHeightInLines(component, random(10));

          element.style.fontSize = random(20) + "px";
          element.style.lineHeight = random.floatBetween(0.1, 2.0);
          TextEditor.didUpdateStyles();
          await component.getNextUpdatePromise();

          element.focus();

          for (var j = 0; j < 5; j++) {
            const k = random(100);
            const range = getRandomBufferRange(random, editor.buffer);

            if (k < 10) {
              editor.setSoftWrapped(!editor.isSoftWrapped());
            } else if (k < 15) {
              if (random(2)) await setEditorWidthInCharacters(component, random(20));
              if (random(2)) await setEditorHeightInLines(component, random(10));
            } else if (k < 40) {
              editor.setSelectedBufferRange(range);
              editor.backspace();
            } else if (k < 80) {
              const linesToInsert = buildRandomLines(random, 5);
              editor.setCursorBufferPosition(range.start);
              editor.insertText(linesToInsert);
            } else if (k < 90) {
              if (random(2)) {
                editor.foldBufferRange(range);
              } else {
                editor.destroyFoldsIntersectingBufferRange(range);
              }
            } else if (k < 95) {
              editor.setSelectedBufferRange(range);
            } else {
              if (random(2)) {
                component.setScrollTop(random(component.getScrollHeight()));
              }
              if (random(2)) {
                component.setScrollLeft(random(component.getScrollWidth()));
              }
            }

            component.scheduleUpdate();
            await component.getNextUpdatePromise();

            const renderedLines = queryOnScreenLineElements(element).sort(
              (a, b) => a.dataset.screenRow - b.dataset.screenRow,
            );
            const renderedLineNumbers = queryOnScreenLineNumberElements(element).sort(
              (a, b) => a.dataset.screenRow - b.dataset.screenRow,
            );
            const renderedStartRow = component.getRenderedStartRow();
            const expectedLines = editor.displayLayer.getScreenLines(
              renderedStartRow,
              component.getRenderedEndRow(),
            );

            expect(renderedLines.length).toBe(expectedLines.length, failureMessage);
            expect(renderedLineNumbers.length).toBe(expectedLines.length, failureMessage);
            for (let k = 0; k < renderedLines.length; k++) {
              const expectedLine = expectedLines[k];
              const expectedText = expectedLine.lineText || " ";

              const renderedLine = renderedLines[k];
              const renderedLineNumber = renderedLineNumbers[k];
              let renderedText = renderedLine.textContent;
              // We append zero width NBSPs after folds at the end of the
              // line in order to support measurement.
              if (expectedText.endsWith(editor.displayLayer.foldCharacter)) {
                renderedText = renderedText.substring(0, renderedText.length - 1);
              }

              expect(renderedText).toBe(expectedText, failureMessage);
              expect(parseInt(renderedLine.dataset.screenRow)).toBe(
                renderedStartRow + k,
                failureMessage,
              );
              expect(parseInt(renderedLineNumber.dataset.screenRow)).toBe(
                renderedStartRow + k,
                failureMessage,
              );
            }
          }

          element.remove();
          editor.destroy();
        }
      });
    });
  });

  describe("mini editors", () => {
    it("adds the mini attribute and class even when the element is not attached", () => {
      {
        const { element } = buildComponent({ mini: true });
        expect(element.hasAttribute("mini")).toBe(true);
        expect(element.classList.contains("mini")).toBe(true);
      }

      {
        const { element } = buildComponent({
          mini: true,
          attach: false,
        });
        expect(element.hasAttribute("mini")).toBe(true);
        expect(element.classList.contains("mini")).toBe(true);
      }
    });

    it("does not render the gutter container", () => {
      const { component, element } = buildComponent({ mini: true });
      expect(component.refs.gutterContainer).toBeUndefined();
      expect(element.querySelector("gutter-container")).toBeNull();
    });

    it("does not render line decorations for the cursor line", async () => {
      const { component, element, editor } = buildComponent({ mini: true });
      expect(element.querySelector(".line").classList.contains("cursor-line")).toBe(false);

      editor.update({ mini: false });
      await component.getNextUpdatePromise();
      expect(element.querySelector(".line").classList.contains("cursor-line")).toBe(true);

      editor.update({ mini: true });
      await component.getNextUpdatePromise();
      expect(element.querySelector(".line").classList.contains("cursor-line")).toBe(false);
    });

    it("does not render scrollbars", async () => {
      const { component, editor } = buildComponent({
        mini: true,
        autoHeight: false,
      });
      await setEditorWidthInCharacters(component, 10);

      editor.setText("x".repeat(20) + "y".repeat(20));
      await component.getNextUpdatePromise();

      expect(component.canScrollVertically()).toBe(false);
      expect(component.canScrollHorizontally()).toBe(false);
      expect(component.refs.horizontalScrollbar).toBeUndefined();
      expect(component.refs.verticalScrollbar).toBeUndefined();
    });
  });

  jasmine.describeWithDocumentFocus("focus", () => {
    it("focuses the hidden input element and adds the is-focused class when focused", async () => {
      const { component, element } = buildComponent();
      const { hiddenInput } = component.refs.cursorsAndInput.refs;

      expect(document.activeElement).not.toBe(hiddenInput);
      element.focus();
      expect(document.activeElement).toBe(hiddenInput);
      // element.focus() sets `focused` synchronously through the hidden input's
      // focus event, so render synchronously. An async wait here would let
      // Windows CI momentarily drop OS window focus and blur the input, clearing
      // `is-focused` before the assertion.
      component.updateSync();
      expect(element.classList.contains("is-focused")).toBe(true);

      element.focus(); // focusing back to the element does not blur
      expect(document.activeElement).toBe(hiddenInput);
      expect(element.classList.contains("is-focused")).toBe(true);

      document.body.focus();
      expect(document.activeElement).not.toBe(hiddenInput);
      await component.getNextUpdatePromise();
      expect(element.classList.contains("is-focused")).toBe(false);
    });

    it("updates the component when the hidden input is focused directly", async () => {
      const { component, element } = buildComponent();
      const { hiddenInput } = component.refs.cursorsAndInput.refs;
      expect(element.classList.contains("is-focused")).toBe(false);
      expect(document.activeElement).not.toBe(hiddenInput);

      hiddenInput.focus();
      // Focusing the hidden input sets `focused` synchronously; render
      // synchronously so no async gap lets a spurious OS-window blur clear it.
      component.updateSync();
      expect(element.classList.contains("is-focused")).toBe(true);
    });

    it("gracefully handles a focus event that occurs prior to the attachedCallback of the element", () => {
      const { component, element } = buildComponent({ attach: false });
      const parent = document.createElement("text-editor-component-test-element");
      parent.appendChild(element);
      parent.didAttach = () => element.focus();
      jasmine.attachToDOM(parent);
      expect(document.activeElement).toBe(component.refs.cursorsAndInput.refs.hiddenInput);
    });

    it("gracefully handles a focus event that occurs prior to detecting the element has become visible", async () => {
      const { component, element } = buildComponent({ attach: false });
      element.style.display = "none";
      jasmine.attachToDOM(element);
      element.style.display = "block";
      element.focus();
      await component.getNextUpdatePromise();

      expect(document.activeElement).toBe(component.refs.cursorsAndInput.refs.hiddenInput);
    });

    it("emits blur events only when focus shifts to something other than the editor itself or its hidden input", () => {
      const { element } = buildComponent();

      let blurEventCount = 0;
      element.addEventListener("blur", () => blurEventCount++);

      element.focus();
      expect(blurEventCount).toBe(0);
      element.focus();
      expect(blurEventCount).toBe(0);
      document.body.focus();
      expect(blurEventCount).toBe(1);
    });

    it("keeps focus when a render repositions the cursors container around a foreign element", () => {
      // A package may append its own overlay into `.lines` (color-inline does),
      // which leaves the cursors container with a trailing sibling, so the
      // next render repositions it to keep it last. Re-inserting the subtree
      // that holds the focused hidden input silently dropped focus on `body`;
      // the reposition has to move it atomically instead.
      const { component, element, editor } = buildComponent();
      const { hiddenInput } = component.refs.cursorsAndInput.refs;
      element.focus();
      expect(document.activeElement).toBe(hiddenInput);

      const foreign = document.createElement("div");
      component.refs.lineTiles.appendChild(foreign);
      editor.setText("changed");
      component.updateSync();

      expect(component.refs.cursorsAndInput.element.nextSibling).toBeNull();
      expect(document.activeElement).toBe(hiddenInput);
    });
  });

  describe("autoscroll", () => {
    it("automatically scrolls vertically when the requested range is within the vertical scroll margin of the top or bottom", async () => {
      // Size the editor in line-height units so the visible row count does not
      // depend on the platform's font metrics.
      const { component, element, editor } = buildComponent({ autoHeight: false });
      element.style.height =
        7.5 * component.measurements.lineHeight + horizontalScrollbarHeight + "px";
      await component.getNextUpdatePromise();
      expect(component.getLastVisibleRow()).toBe(7);

      editor.scrollToScreenRange([
        [4, 0],
        [6, 0],
      ]);
      await component.getNextUpdatePromise();
      expect(component.getScrollBottom()).toBeNear(
        (6 + 1 + editor.verticalScrollMargin) * component.getLineHeight(),
      );

      editor.scrollToScreenPosition([8, 0]);
      await component.getNextUpdatePromise();
      expect(component.getScrollBottom()).toBeNear(
        (8 + 1 + editor.verticalScrollMargin) * component.measurements.lineHeight,
      );

      editor.scrollToScreenPosition([3, 0]);
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBeNear(
        (3 - editor.verticalScrollMargin) * component.measurements.lineHeight,
      );

      editor.scrollToScreenPosition([2, 0]);
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBe(0);
    });

    it("does not vertically autoscroll by more than half of the visible lines if the editor is shorter than twice the scroll margin", async () => {
      const { component, element, editor } = buildComponent({
        autoHeight: false,
      });
      element.style.height =
        5.5 * component.measurements.lineHeight + horizontalScrollbarHeight + "px";
      await component.getNextUpdatePromise();
      expect(component.getLastVisibleRow()).toBe(5);
      const scrollMarginInLines = 2;

      editor.scrollToScreenPosition([6, 0]);
      await component.getNextUpdatePromise();
      expect(component.getScrollBottom()).toBeNear(
        (6 + 1 + scrollMarginInLines) * component.measurements.lineHeight,
      );

      editor.scrollToScreenPosition([6, 4]);
      await component.getNextUpdatePromise();
      expect(component.getScrollBottom()).toBeNear(
        (6 + 1 + scrollMarginInLines) * component.measurements.lineHeight,
      );

      editor.scrollToScreenRange([
        [4, 4],
        [6, 4],
      ]);
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBeNear(
        (4 - scrollMarginInLines) * component.measurements.lineHeight,
      );

      editor.scrollToScreenRange(
        [
          [4, 4],
          [6, 4],
        ],
        { reversed: false },
      );
      await component.getNextUpdatePromise();
      expect(component.getScrollBottom()).toBeNear(
        (6 + 1 + scrollMarginInLines) * component.measurements.lineHeight,
      );
    });

    it("autoscrolls the given range to the center of the screen if the `center` option is true", async () => {
      // Size the editor in line-height units so the visible row count does not
      // depend on the platform's font metrics.
      const { component, element, editor } = buildComponent({ autoHeight: false });
      element.style.height = 3.125 * component.measurements.lineHeight + "px";
      await component.getNextUpdatePromise();
      expect(component.getLastVisibleRow()).toBe(2);

      editor.scrollToScreenRange(
        [
          [4, 0],
          [6, 0],
        ],
        { center: true },
      );
      await component.getNextUpdatePromise();

      const actualScrollCenter = (component.getScrollTop() + component.getScrollBottom()) / 2;
      const expectedScrollCenter = ((4 + 7) / 2) * component.getLineHeight();
      expect(actualScrollCenter).toBeCloseTo(expectedScrollCenter, 0);
    });

    describe("the `zone` option", () => {
      // A tall buffer of short lines: no soft wrap and no horizontal scrollbar,
      // so the only geometry these specs depend on is the line height.
      async function buildZoneComponent() {
        const { component, element, editor } = buildComponent({
          autoHeight: false,
          text: "abcdefgh\n".repeat(50),
        });
        element.style.height = 9.5 * component.measurements.lineHeight + "px";
        await component.getNextUpdatePromise();
        return { component, element, editor };
      }

      // The band measures the travel the range has between the two autoscroll
      // margins, so the expectations are derived the same way rather than
      // hard-coded against the platform's font metrics.
      function offsetForPercentage(component, percentage, rangeHeightInLines = 1) {
        const margin = component.getVerticalAutoscrollMargin();
        const travel =
          component.getScrollContainerClientHeight() -
          2 * margin -
          rangeHeightInLines * component.getLineHeight();
        return margin + travel * (percentage / 100);
      }

      it("pins the range to a single percentage of the viewport", async () => {
        const { component, editor } = await buildZoneComponent();
        const lineHeight = component.getLineHeight();

        editor.scrollToScreenPosition([10, 0], { zone: 25 });
        await component.getNextUpdatePromise();
        expect(component.getScrollTop()).toBeNear(
          10 * lineHeight - offsetForPercentage(component, 25),
        );

        // Strict: it scrolls back for a row that is already comfortably on
        // screen, which the default behaviour never does.
        editor.scrollToScreenPosition([11, 0], { zone: 25 });
        await component.getNextUpdatePromise();
        expect(component.getScrollTop()).toBeNear(
          11 * lineHeight - offsetForPercentage(component, 25),
        );
      });

      it("leaves the viewport alone while the range is inside a two-ended zone", async () => {
        const { component, editor } = await buildZoneComponent();

        editor.scrollToScreenPosition([12, 0], { zone: [0, 100] });
        await component.getNextUpdatePromise();
        const scrollTop = component.getScrollTop();
        expect(scrollTop).toBeGreaterThan(0);

        editor.scrollToScreenPosition([11, 0], { zone: [0, 100] });
        await component.getNextUpdatePromise();
        expect(component.getScrollTop()).toBe(scrollTop);
      });

      it("scrolls to the nearer edge of the zone once the range leaves it", async () => {
        const { component, editor } = await buildZoneComponent();
        const lineHeight = component.getLineHeight();

        editor.scrollToScreenPosition([12, 0], { zone: [20, 60] });
        await component.getNextUpdatePromise();
        expect(component.getScrollTop()).toBeNear(
          12 * lineHeight - offsetForPercentage(component, 60),
        );

        // Above the zone now, so the row lands on its upper edge instead.
        editor.scrollToScreenPosition([9, 0], { zone: [20, 60] });
        await component.getNextUpdatePromise();
        expect(component.getScrollTop()).toBeNear(
          9 * lineHeight - offsetForPercentage(component, 20),
        );
      });

      it("reproduces the default vertical autoscroll with `[0, 100]`", async () => {
        const range = [
          [12, 0],
          [14, 0],
        ];

        const byDefault = await buildZoneComponent();
        byDefault.editor.scrollToScreenRange(range);
        await byDefault.component.getNextUpdatePromise();

        const byZone = await buildZoneComponent();
        byZone.editor.scrollToScreenRange(range, { zone: [0, 100] });
        await byZone.component.getNextUpdatePromise();

        expect(byZone.component.getScrollTop()).toBeNear(byDefault.component.getScrollTop());
      });

      it("reproduces the `center` option with `50`", async () => {
        const range = [
          [12, 0],
          [14, 0],
        ];

        const byCenter = await buildZoneComponent();
        byCenter.editor.scrollToScreenRange(range, { center: true });
        await byCenter.component.getNextUpdatePromise();

        const byZone = await buildZoneComponent();
        byZone.editor.scrollToScreenRange(range, { zone: 50 });
        await byZone.component.getNextUpdatePromise();

        expect(byZone.component.getScrollTop()).toBeNear(byCenter.component.getScrollTop());
      });

      it("lands on the opposite edge when the pair is inverted", async () => {
        const { component, editor } = await buildZoneComponent();
        const lineHeight = component.getLineHeight();

        // Same band as [0, 50], but leaving through the bottom throws the row
        // up to the top of it rather than resting it on the edge it crossed.
        editor.scrollToScreenPosition([12, 0], { zone: [50, 0] });
        await component.getNextUpdatePromise();
        expect(component.getScrollTop()).toBeNear(
          12 * lineHeight - offsetForPercentage(component, 0),
        );

        // And leaving through the top throws it down to the bottom of the band.
        editor.scrollToScreenPosition([11, 0], { zone: [50, 0] });
        await component.getNextUpdatePromise();
        expect(component.getScrollTop()).toBeNear(
          11 * lineHeight - offsetForPercentage(component, 50),
        );
      });

      it("clamps percentages to 0-100", async () => {
        const { component, editor } = await buildZoneComponent();
        const lineHeight = component.getLineHeight();

        editor.scrollToScreenPosition([12, 0], { zone: [-40, 900] });
        await component.getNextUpdatePromise();
        expect(component.getScrollTop()).toBeNear(
          12 * lineHeight - offsetForPercentage(component, 100),
        );
      });

      it("rests a range too tall to fit against the top margin", async () => {
        const { component, editor } = await buildZoneComponent();
        const lineHeight = component.getLineHeight();

        editor.scrollToScreenRange(
          [
            [8, 0],
            [30, 0],
          ],
          { zone: 100 },
        );
        await component.getNextUpdatePromise();
        expect(component.getScrollTop()).toBeNear(
          8 * lineHeight - component.getVerticalAutoscrollMargin(),
        );
      });

      it("rejects a zone that is not a percentage or a pair of them", () => {
        const { editor } = buildComponent({ autoHeight: false });
        expect(() => editor.scrollToScreenPosition([2, 0], { zone: "0-50" })).toThrow();
        expect(() => editor.scrollToScreenPosition([2, 0], { zone: [] })).toThrow();
        expect(() => editor.scrollToScreenPosition([2, 0], { zone: [0, 50, 100] })).toThrow();
        expect(() => editor.scrollToScreenPosition([2, 0], { zone: [0, NaN] })).toThrow();
      });
    });

    it("automatically scrolls horizontally when the requested range is within the horizontal scroll margin of the right edge of the gutter or right edge of the scroll container", async () => {
      const { component, element, editor } = buildComponent();
      element.style.width =
        component.getGutterContainerWidth() +
        3 * editor.horizontalScrollMargin * component.measurements.baseCharacterWidth +
        "px";
      await component.getNextUpdatePromise();

      editor.scrollToScreenRange([
        [1, 12],
        [2, 28],
      ]);
      await component.getNextUpdatePromise();
      let expectedScrollLeft =
        clientLeftForCharacter(component, 1, 12) -
        lineNodeForScreenRow(component, 1).getBoundingClientRect().left -
        editor.horizontalScrollMargin * component.measurements.baseCharacterWidth;
      expect(component.getScrollLeft()).toBeNear(expectedScrollLeft);

      editor.scrollToScreenRange(
        [
          [1, 12],
          [2, 28],
        ],
        { reversed: false },
      );
      await component.getNextUpdatePromise();
      expectedScrollLeft =
        component.getGutterContainerWidth() +
        clientLeftForCharacter(component, 2, 28) -
        lineNodeForScreenRow(component, 2).getBoundingClientRect().left +
        editor.horizontalScrollMargin * component.measurements.baseCharacterWidth -
        component.getScrollContainerClientWidth();
      expect(component.getScrollLeft()).toBeNear(expectedScrollLeft);
    });

    it('does not horizontally autoscroll by more than half of the visible "base-width" characters if the editor is narrower than twice the scroll margin', async () => {
      const { component, editor } = buildComponent({ autoHeight: false });
      await setEditorWidthInCharacters(component, 1.5 * editor.horizontalScrollMargin);
      const editorWidthInChars =
        component.getScrollContainerClientWidth() / component.getBaseCharacterWidth();
      expect(Math.round(editorWidthInChars)).toBe(9);

      editor.scrollToScreenRange([
        [6, 10],
        [6, 15],
      ]);
      await component.getNextUpdatePromise();
      let expectedScrollLeft = Math.floor(
        clientLeftForCharacter(component, 6, 10) -
          lineNodeForScreenRow(component, 1).getBoundingClientRect().left -
          Math.floor((editorWidthInChars - 1) / 2) * component.getBaseCharacterWidth(),
      );
      expect(component.getScrollLeft()).toBeNear(expectedScrollLeft);
    });

    it("correctly autoscrolls after inserting a line that exceeds the current content width", async () => {
      const { component, element, editor } = buildComponent();
      element.style.width =
        component.getGutterContainerWidth() + component.getContentWidth() + "px";
      await component.getNextUpdatePromise();

      editor.setCursorScreenPosition([0, Infinity]);
      editor.insertText("x".repeat(100));
      await component.getNextUpdatePromise();

      expect(component.getScrollLeft()).toBeNear(
        component.getScrollWidth() - component.getScrollContainerClientWidth(),
      );
    });

    it("does not try to measure lines that do not exist when the animation frame is delivered", async () => {
      const { component, editor } = buildComponent({
        autoHeight: false,
        height: 30,
        rowsPerTile: 2,
      });
      editor.scrollToBufferPosition([11, 5]);
      editor.getBuffer().deleteRows(11, 12);
      await component.getNextUpdatePromise();
      expect(component.getScrollBottom()).toBeNear((10 + 1) * component.measurements.lineHeight);
    });

    it("accounts for the presence of horizontal scrollbars that appear during the same frame as the autoscroll", async () => {
      const { component, element, editor } = buildComponent({
        autoHeight: false,
      });
      element.style.height = component.getContentHeight() / 2 + "px";
      element.style.width = component.getScrollWidth() + "px";
      await component.getNextUpdatePromise();

      editor.setCursorScreenPosition([10, Infinity]);
      editor.insertText("\n\n" + "x".repeat(100));
      await component.getNextUpdatePromise();

      expect(component.getScrollTop()).toBeNear(
        component.getScrollHeight() - component.getScrollContainerClientHeight(),
      );
      expect(component.getScrollLeft()).toBeNear(
        component.getScrollWidth() - component.getScrollContainerClientWidth(),
      );

      // Scrolling to the top should not throw an error. This failed
      // previously due to horizontalPositionsToMeasure not being empty after
      // autoscrolling vertically to account for the horizontal scrollbar.
      spyOn(window, "onerror");
      await setScrollTop(component, 0);
      expect(window.onerror).not.toHaveBeenCalled();
    });
  });

  describe("logical scroll positions", () => {
    it("allows the scrollTop to be changed and queried in terms of rows via setScrollTopRow and getScrollTopRow", () => {
      const { component, element } = buildComponent({
        attach: false,
        height: 80,
      });

      // Caches the scrollTopRow if we don't have measurements
      component.setScrollTopRow(6);
      expect(component.getScrollTopRow()).toBe(6);

      // Assigns the scrollTop based on the logical position when attached
      jasmine.attachToDOM(element);
      const expectedScrollTop = Math.round(6 * component.getLineHeight());
      expect(component.getScrollTopRow()).toBeNear(6);
      expect(component.getScrollTop()).toBeNear(expectedScrollTop);
      // The stored position is exact; the rendered transform quantizes it to
      // the physical grid (one CSS pixel in the spec environment).
      expect(component.refs.content.style.transform).toBe(
        `translate(0px, -${Math.round(component.getScrollTop())}px)`,
      );

      // Allows the scrollTopRow to be updated while attached
      component.setScrollTopRow(4);
      expect(component.getScrollTopRow()).toBeNear(4);
      expect(component.getScrollTop()).toBeNear(Math.round(4 * component.getLineHeight()));

      // Preserves the scrollTopRow when detached
      element.remove();
      expect(component.getScrollTopRow()).toBeNear(4);
      expect(component.getScrollTop()).toBeNear(Math.round(4 * component.getLineHeight()));

      component.setScrollTopRow(6);
      expect(component.getScrollTopRow()).toBeNear(6);
      expect(component.getScrollTop()).toBeNear(Math.round(6 * component.getLineHeight()));

      jasmine.attachToDOM(element);
      element.style.height = "60px";
      expect(component.getScrollTopRow()).toBeNear(6);
      expect(component.getScrollTop()).toBeNear(Math.round(6 * component.getLineHeight()));
    });

    it("allows the scrollLeft to be changed and queried in terms of base character columns via setScrollLeftColumn and getScrollLeftColumn", () => {
      const { component, element } = buildComponent({
        attach: false,
        width: 80,
      });

      // Caches the scrollTopRow if we don't have measurements
      component.setScrollLeftColumn(2);
      expect(component.getScrollLeftColumn()).toBe(2);

      // Assigns the scrollTop based on the logical position when attached
      jasmine.attachToDOM(element);
      expect(component.getScrollLeft()).toBeCloseTo(2 * component.getBaseCharacterWidth(), 0);

      // Allows the scrollTopRow to be updated while attached
      component.setScrollLeftColumn(4);
      expect(component.getScrollLeft()).toBeCloseTo(4 * component.getBaseCharacterWidth(), 0);

      // Preserves the scrollTopRow when detached
      element.remove();
      expect(component.getScrollLeft()).toBeCloseTo(4 * component.getBaseCharacterWidth(), 0);

      component.setScrollLeftColumn(6);
      expect(component.getScrollLeft()).toBeCloseTo(6 * component.getBaseCharacterWidth(), 0);

      jasmine.attachToDOM(element);
      element.style.width = "60px";
      expect(component.getScrollLeft()).toBeCloseTo(6 * component.getBaseCharacterWidth(), 0);
    });
  });

  describe("scrolling via the mouse wheel", () => {
    it("scrolls both axes by their respective deltas", () => {
      const scrollSensitivity = 25;
      // deltaY of 100 corresponds to the legacy wheelDelta of 120 per notch.
      const wheelDeltaParity = 1.2;
      const { component } = buildComponent({
        height: 50,
        width: 50,
        scrollSensitivity,
        // Pin the instant path: an unset param follows the global setting.
        smoothScrolling: false,
      });
      // stub in place for Event.preventDefault()
      const eventPreventDefaultStub = function () {};

      const factor = wheelDeltaParity * (scrollSensitivity / 100);

      {
        // A diagonal gesture moves both axes at once.
        const expectedScrollTop = 20 * factor;
        const expectedScrollLeft = 10 * factor;
        component.didMouseWheel({
          deltaX: 10,
          deltaY: 20,
          deltaMode: 0,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollTop()).toBeNear(expectedScrollTop);
        expect(component.getScrollLeft()).toBeNear(expectedScrollLeft);
        expect(component.refs.content.style.transform).toBe(
          `translate(${-expectedScrollLeft}px, ${-expectedScrollTop}px)`,
        );
      }

      {
        const expectedScrollTop = component.getScrollTop() - 10 * factor;
        const expectedScrollLeft = component.getScrollLeft() + 10 * factor;
        component.didMouseWheel({
          deltaX: 10,
          deltaY: -10,
          deltaMode: 0,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollTop()).toBeNear(expectedScrollTop);
        expect(component.getScrollLeft()).toBeNear(expectedScrollLeft);
        expect(component.refs.content.style.transform).toBe(
          `translate(${-expectedScrollLeft}px, ${-expectedScrollTop}px)`,
        );
      }

      {
        const expectedScrollTop = component.getScrollTop() + 10 * factor;
        const expectedScrollLeft = component.getScrollLeft() - 10 * factor;
        component.didMouseWheel({
          deltaX: -10,
          deltaY: 10,
          deltaMode: 0,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollTop()).toBeNear(expectedScrollTop);
        expect(component.getScrollLeft()).toBeNear(expectedScrollLeft);
        expect(component.refs.content.style.transform).toBe(
          `translate(${-expectedScrollLeft}px, ${-expectedScrollTop}px)`,
        );
      }
    });

    it("inverts deltaX and deltaY when holding shift on Windows and Linux", async () => {
      const scrollSensitivity = 50;
      // deltaY of 100 corresponds to the legacy wheelDelta of 120 per notch.
      const wheelDeltaParity = 1.2;
      const { component } = buildComponent({
        height: 50,
        width: 50,
        scrollSensitivity,
        // Pin the instant path: an unset param follows the global setting.
        smoothScrolling: false,
      });
      // stub in place for Event.preventDefault()
      const eventPreventDefaultStub = function () {};

      component.props.platform = "linux";
      {
        const expectedScrollTop = 20 * wheelDeltaParity * (scrollSensitivity / 100);
        component.didMouseWheel({
          deltaX: 0,
          deltaY: 20,
          deltaMode: 0,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollTop()).toBeNear(expectedScrollTop);
        expect(component.refs.content.style.transform).toBe(
          `translate(0px, -${expectedScrollTop}px)`,
        );
        await setScrollTop(component, 0);
      }

      {
        const expectedScrollLeft = 20 * wheelDeltaParity * (scrollSensitivity / 100);
        component.didMouseWheel({
          deltaX: 0,
          deltaY: 20,
          deltaMode: 0,
          shiftKey: true,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollLeft()).toBeNear(expectedScrollLeft);
        expect(component.refs.content.style.transform).toBe(
          `translate(-${expectedScrollLeft}px, 0px)`,
        );
        await setScrollLeft(component, 0);
      }

      {
        const expectedScrollTop = 20 * wheelDeltaParity * (scrollSensitivity / 100);
        component.didMouseWheel({
          deltaX: 20,
          deltaY: 0,
          deltaMode: 0,
          shiftKey: true,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollTop()).toBe(expectedScrollTop);
        expect(component.refs.content.style.transform).toBe(
          `translate(0px, -${expectedScrollTop}px)`,
        );
        await setScrollTop(component, 0);
      }

      component.props.platform = "win32";
      {
        const expectedScrollTop = 20 * wheelDeltaParity * (scrollSensitivity / 100);
        component.didMouseWheel({
          deltaX: 0,
          deltaY: 20,
          deltaMode: 0,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollTop()).toBe(expectedScrollTop);
        expect(component.refs.content.style.transform).toBe(
          `translate(0px, -${expectedScrollTop}px)`,
        );
        await setScrollTop(component, 0);
      }

      {
        const expectedScrollLeft = 20 * wheelDeltaParity * (scrollSensitivity / 100);
        component.didMouseWheel({
          deltaX: 0,
          deltaY: 20,
          deltaMode: 0,
          shiftKey: true,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollLeft()).toBe(expectedScrollLeft);
        expect(component.refs.content.style.transform).toBe(
          `translate(-${expectedScrollLeft}px, 0px)`,
        );
        await setScrollLeft(component, 0);
      }

      {
        const expectedScrollTop = 20 * wheelDeltaParity * (scrollSensitivity / 100);
        component.didMouseWheel({
          deltaX: 20,
          deltaY: 0,
          deltaMode: 0,
          shiftKey: true,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollTop()).toBe(expectedScrollTop);
        expect(component.refs.content.style.transform).toBe(
          `translate(0px, -${expectedScrollTop}px)`,
        );
        await setScrollTop(component, 0);
      }

      component.props.platform = "darwin";
      {
        const expectedScrollTop = 20 * wheelDeltaParity * (scrollSensitivity / 100);
        component.didMouseWheel({
          deltaX: 0,
          deltaY: 20,
          deltaMode: 0,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollTop()).toBe(expectedScrollTop);
        expect(component.refs.content.style.transform).toBe(
          `translate(0px, -${expectedScrollTop}px)`,
        );
        await setScrollTop(component, 0);
      }

      {
        const expectedScrollTop = 20 * wheelDeltaParity * (scrollSensitivity / 100);
        component.didMouseWheel({
          deltaX: 0,
          deltaY: 20,
          deltaMode: 0,
          shiftKey: true,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollTop()).toBe(expectedScrollTop);
        expect(component.refs.content.style.transform).toBe(
          `translate(0px, -${expectedScrollTop}px)`,
        );
        await setScrollTop(component, 0);
      }

      {
        const expectedScrollLeft = 20 * wheelDeltaParity * (scrollSensitivity / 100);
        component.didMouseWheel({
          deltaX: 20,
          deltaY: 0,
          deltaMode: 0,
          shiftKey: true,
          preventDefault: eventPreventDefaultStub,
        });
        expect(component.getScrollLeft()).toBe(expectedScrollLeft);
        expect(component.refs.content.style.transform).toBe(
          `translate(-${expectedScrollLeft}px, 0px)`,
        );
        await setScrollLeft(component, 0);
      }
    });
  });

  describe("smooth scrolling", () => {
    const FRAME = 1000 / 60;
    // deltaY of 100 corresponds to the legacy wheelDelta of 120 per notch.
    const wheelDeltaParity = 1.2;

    function buildSmoothComponent(params = {}) {
      const result = buildComponent({
        height: 50,
        width: 50,
        scrollSensitivity: 25,
        smoothScrolling: true,
        wheelSmoothness: 8,
        ...params,
      });
      // Detach the animator from real animation frames so specs can drive it
      // deterministically via advance().
      result.component.scrollAnimator.raf = () => 0;
      result.component.scrollAnimator.caf = () => {};
      return result;
    }

    function driveAnimationToCompletion(component, maxFrames = 1000) {
      let frames = 0;
      while (component.scrollAnimator.isAnimating() && frames < maxFrames) {
        component.scrollAnimator.advance(FRAME);
        frames++;
      }
      expect(component.scrollAnimator.isAnimating()).toBe(false);
      return frames;
    }

    it("glides toward the wheel target instead of jumping instantly", () => {
      const { component, element } = buildSmoothComponent();
      let started = 0;
      let ended = 0;
      element.onDidStartScrollAnimation(() => started++);
      element.onDidEndScrollAnimation(() => ended++);

      const preventDefault = jasmine.createSpy("preventDefault");
      component.didMouseWheel({ deltaX: 0, deltaY: 20, deltaMode: 0, preventDefault });
      const expectedScrollTop = 20 * wheelDeltaParity * 0.25;

      expect(preventDefault).toHaveBeenCalled();
      expect(started).toBe(1);
      expect(component.getScrollTop()).toBe(0);

      component.scrollAnimator.advance(FRAME);
      expect(component.getScrollTop()).toBeGreaterThan(0);
      expect(component.getScrollTop()).toBeLessThan(expectedScrollTop);

      driveAnimationToCompletion(component);
      expect(component.getScrollTop()).toBeNear(expectedScrollTop);
      expect(started).toBe(1);
      expect(ended).toBe(1);
    });

    it("does not prevent default when the editor cannot scroll in the requested direction", () => {
      const { component } = buildSmoothComponent();
      const preventDefault = jasmine.createSpy("preventDefault");
      component.didMouseWheel({ deltaX: 0, deltaY: -20, deltaMode: 0, preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(component.scrollAnimator.isAnimating()).toBe(false);
    });

    it("follows the global setting for editors no TextEditorRegistry configures", () => {
      // Editors embedded in package views (for example diff views) are never
      // registered with lumine.textEditors, so their params stay unset.
      const { component } = buildSmoothComponent({ smoothScrolling: undefined });

      lumine.config.set("editor.smoothScrolling", true);
      const preventDefault = jasmine.createSpy("preventDefault");
      component.didMouseWheel({ deltaX: 0, deltaY: 20, deltaMode: 0, preventDefault });
      expect(component.scrollAnimator.isAnimating()).toBe(true);
      expect(component.getScrollTop()).toBe(0);
      driveAnimationToCompletion(component);
      expect(component.getScrollTop()).toBeNear(20 * wheelDeltaParity * 0.25);

      lumine.config.set("editor.smoothScrolling", false);
      const scrollTop = component.getScrollTop();
      component.didMouseWheel({ deltaX: 0, deltaY: 20, deltaMode: 0, preventDefault });
      expect(component.scrollAnimator.isAnimating()).toBe(false);
      expect(component.getScrollTop()).toBeNear(scrollTop + 20 * wheelDeltaParity * 0.25);
    });

    it("applies the alt wheel multiplier", () => {
      const { component } = buildSmoothComponent({ altWheelMultiplier: 5 });
      const preventDefault = jasmine.createSpy("preventDefault");
      component.didMouseWheel({
        deltaX: 0,
        deltaY: 20,
        deltaMode: 0,
        altKey: true,
        preventDefault,
      });
      driveAnimationToCompletion(component);
      expect(component.getScrollTop()).toBeNear(20 * wheelDeltaParity * 5 * 0.25);
    });

    it("normalizes line-based wheel deltas against the line height", () => {
      const { component } = buildSmoothComponent();
      const preventDefault = jasmine.createSpy("preventDefault");
      component.didMouseWheel({ deltaX: 0, deltaY: 2, deltaMode: 1, preventDefault });
      driveAnimationToCompletion(component);
      expect(component.getScrollTop()).toBeNear(
        2 * component.getLineHeight() * wheelDeltaParity * 0.25,
      );
    });

    it("accumulates repeated wheel events into the running glide", () => {
      const { component, element } = buildSmoothComponent();
      let started = 0;
      element.onDidStartScrollAnimation(() => started++);
      const preventDefault = jasmine.createSpy("preventDefault");

      component.didMouseWheel({ deltaX: 0, deltaY: 20, deltaMode: 0, preventDefault });
      component.scrollAnimator.advance(FRAME);
      component.didMouseWheel({ deltaX: 0, deltaY: 20, deltaMode: 0, preventDefault });
      expect(started).toBe(1);

      driveAnimationToCompletion(component);
      expect(component.getScrollTop()).toBeNear(2 * 20 * wheelDeltaParity * 0.25);
    });

    it("updates only scroll-position DOM while the viewport stays in the mounted tile", async () => {
      const { component, element } = buildSmoothComponent({
        text: `${"x".repeat(200)}\n`.repeat(30),
      });
      if (component.updateScheduled) await component.getNextUpdatePromise();
      const updateSync = spyOn(component, "updateSync").and.callThrough();
      let notifyingTop = false;
      let notifyingLeft = false;
      element.onDidChangeScrollTop(() => {
        notifyingTop = true;
      });
      element.onDidChangeScrollLeft(() => {
        notifyingLeft = true;
      });

      component.scrollAnimator.scrollBy({ x: 20, y: 20, smoothness: 8 });
      component.scrollAnimator.advance(FRAME);

      expect(notifyingTop).toBe(true);
      expect(notifyingLeft).toBe(true);
      expect(updateSync).not.toHaveBeenCalled();
      expect(component.refs.content.style.transform).toBe(
        `translate(-${component.getScrollLeft()}px, -${component.getScrollTop()}px)`,
      );
      expect(component.refs.gutterContainer.innerElement.style.transform).toBe(
        `translateY(-${component.getScrollTop()}px)`,
      );
      expect(component.refs.verticalScrollbar.element.scrollTop).toBeNear(component.getScrollTop());
      expect(component.refs.horizontalScrollbar.element.scrollLeft).toBeNear(
        component.getScrollLeft(),
      );
      expect(component.scrollTopPending).toBe(false);
      expect(component.scrollLeftPending).toBe(false);

      // Programmatic scrollbar echoes are filtered by the scrollbar itself,
      // but the next real scrollbar movement still takes over normally.
      component.refs.verticalScrollbar.element.dispatchEvent(new Event("scroll"));
      component.refs.horizontalScrollbar.element.dispatchEvent(new Event("scroll"));
      expect(updateSync).not.toHaveBeenCalled();
      const verticalScrollbar = component.refs.verticalScrollbar.element;
      verticalScrollbar.scrollTop += 1;
      const userScrollTop = verticalScrollbar.scrollTop;
      verticalScrollbar.dispatchEvent(new Event("scroll"));
      expect(updateSync).toHaveBeenCalledTimes(1);
      expect(component.scrollAnimator.isAnimating()).toBe(false);
      expect(component.getScrollTop()).toBe(userScrollTop);
    });

    it("keeps gliding through programmatic scrollbar echoes at a very large offset", async () => {
      const { component, editor } = buildSmoothComponent({ text: "first\nsecond\nthird\n" });
      const marker = editor.markScreenPosition([0, 0], { invalidate: "never" });
      const item = document.createElement("div");
      item.style.height = "11000000px";
      editor.decorateMarker(marker, { type: "block", item, position: "after" });
      await component.getNextUpdatePromise();

      const initialScrollTop = 10_498_232.805;
      expect(component.getMaxScrollTop()).toBeGreaterThan(initialScrollTop + 48);
      await setScrollTop(component, initialScrollTop);
      const scrollbar = component.refs.verticalScrollbar.element;
      const preventDefault = jasmine.createSpy("preventDefault");

      component.didMouseWheel({
        deltaX: 0,
        deltaY: 160,
        deltaMode: 0,
        preventDefault,
      });
      const targetScrollTop = initialScrollTop + 160 * wheelDeltaParity * 0.25;
      expect(preventDefault).toHaveBeenCalled();

      component.scrollAnimator.advance(FRAME);
      expect(component.getScrollTop()).toBeNear(initialScrollTop + 12);
      scrollbar.dispatchEvent(new Event("scroll"));
      expect(component.scrollAnimator.isAnimating()).toBe(true);

      let frames = 1;
      while (component.scrollAnimator.isAnimating() && frames < 1000) {
        component.scrollAnimator.advance(FRAME);
        scrollbar.dispatchEvent(new Event("scroll"));
        frames++;
      }
      expect(component.scrollAnimator.isAnimating()).toBe(false);
      expect(frames).toBeGreaterThan(2);
      expect(component.getScrollTop()).toBeNear(targetScrollTop);
    });

    it("falls back to a complete update when scrolling crosses a tile boundary", () => {
      const { component } = buildSmoothComponent({
        text: "line\n".repeat(100),
      });
      const updateSync = spyOn(component, "updateSync").and.callThrough();
      const boundaryRow = component.mountedTileStartRow + component.getRowsPerTile();
      // Fully past the boundary: a fractional boundary position snaps to the
      // nearest physical pixel, and half a pixel short of it the outgoing
      // tile is rightly still mounted.
      const boundaryTop = Math.ceil(component.pixelPositionBeforeBlocksForRow(boundaryRow));

      component.scrollAnimator.scrollTo({ top: boundaryTop, smoothness: 1 });
      component.scrollAnimator.advance(FRAME);

      expect(updateSync).toHaveBeenCalledTimes(1);
      expect(updateSync).toHaveBeenCalledWith({ updateMode: UPDATE_MODE_SCROLL_TILES });
      expect(component.mountedTileStartRow).toBe(boundaryRow);
    });

    it("updates only entering line-number gutter tiles when scrolling crosses a tile boundary", async () => {
      const { component, editor } = buildSmoothComponent({
        text: `${"x".repeat(80)}\n`.repeat(100),
        softWrapped: true,
        rowsPerTile: 3,
        width: 180,
      });
      const labelFns = ["old", "new"].map((prefix) =>
        jasmine
          .createSpy(`${prefix}Label`)
          .and.callFake(({ bufferRow, screenRow }) => `${prefix}:${bufferRow}:${screenRow}`),
      );
      const gutters = labelFns.map((labelFn, index) =>
        editor.addGutter({
          name: `diff-${index}`,
          priority: index,
          type: "line-number",
          labelFn,
        }),
      );
      const marker = editor.markBufferRange(editor.getBuffer().getRange(), {
        invalidate: "never",
      });
      gutters.forEach((gutter) => gutter.decorateMarker(marker, { class: "changed" }));
      await component.getNextUpdatePromise();
      component.updateSync();

      const previousEndRow = component.mountedTileEndRow;
      const boundaryRow = component.mountedTileStartRow + component.getRowsPerTile();
      const boundaryTop = Math.ceil(component.pixelPositionBeforeBlocksForRow(boundaryRow));
      labelFns.forEach((labelFn) => labelFn.calls.reset());
      expect(component.canUpdateForScrollOnly(false, true)).toBe(true);

      component.scrollAnimator.scrollTo({ top: boundaryTop, smoothness: 1 });
      component.scrollAnimator.advance(FRAME);

      const enteringRows = Array.from(
        { length: component.mountedTileEndRow - previousEndRow },
        (_, index) => previousEndRow + index,
      );
      for (const labelFn of labelFns) {
        expect(
          labelFn.calls
            .allArgs()
            .map(([{ screenRow }]) => screenRow)
            .sort((a, b) => a - b),
        ).toEqual(enteringRows);
      }

      for (let index = 0; index < gutters.length; index++) {
        const prefix = index === 0 ? "old" : "new";
        const lineNumbers = Array.from(
          gutters[index].getElement().querySelectorAll(".line-number:not(.dummy)"),
        ).sort((a, b) => Number(a.dataset.screenRow) - Number(b.dataset.screenRow));
        expect(lineNumbers.length).toBe(
          component.getRenderedEndRow() - component.getRenderedStartRow(),
        );
        for (const lineNumber of lineNumbers) {
          const screenRow = Number(lineNumber.dataset.screenRow);
          const bufferRow = editor.bufferRowForScreenRow(screenRow);
          expect(Number(lineNumber.dataset.bufferRow)).toBe(bufferRow);
          expect(lineNumber.textContent).toBe(`${prefix}:${bufferRow}:${screenRow}`);
          expect(lineNumber).toHaveClass("changed");
          expect(lineNumber.getBoundingClientRect().top).toBeNear(
            lineNodeForScreenRow(component, screenRow).getBoundingClientRect().top,
          );
        }
      }
    });

    it("refreshes retained line-number gutter tiles when other work is pending", async () => {
      const { component, editor } = buildSmoothComponent({
        text: "line\n".repeat(100),
        rowsPerTile: 3,
      });
      let prefix = "old";
      const labelFn = jasmine
        .createSpy("label")
        .and.callFake(({ screenRow }) => `${prefix}:${screenRow}`);
      const gutter = editor.addGutter({ name: "diff", type: "line-number", labelFn });
      await component.getNextUpdatePromise();

      const boundaryRow = component.mountedTileStartRow + component.getRowsPerTile();
      const retainedLineNumber = () =>
        gutter.getElement().querySelector(`[data-screen-row="${boundaryRow}"]`);
      expect(retainedLineNumber().textContent).toBe(`old:${boundaryRow}`);

      prefix = "new";
      labelFn.calls.reset();
      const marker = editor.markScreenRange(
        [
          [boundaryRow, 0],
          [boundaryRow, 1],
        ],
        { invalidate: "never" },
      );
      gutter.decorateMarker(marker, { class: "pending-change" });
      expect(component.updateScheduled).toBe(true);

      const boundaryTop = Math.ceil(component.pixelPositionBeforeBlocksForRow(boundaryRow));
      component.scrollAnimator.scrollTo({ top: boundaryTop, smoothness: 1 });
      component.scrollAnimator.advance(FRAME);

      expect(labelFn.calls.count()).toBe(
        component.getRenderedEndRow() - component.getRenderedStartRow(),
      );
      expect(retainedLineNumber().textContent).toBe(`new:${boundaryRow}`);
      expect(retainedLineNumber()).toHaveClass("pending-change");
    });

    it("rejects scroll-only updates whenever other editor work is pending", async () => {
      const { component } = buildSmoothComponent();
      if (component.updateScheduled) await component.getNextUpdatePromise();
      expect(component.canUpdateScrollPositionOnly(false, true)).toBe(true);
      expect(component.canUpdateForScrollOnly(false, true)).toBe(true);

      const unsafeStates = [
        ["updateScheduled", true],
        ["pendingAutoscroll", {}],
        ["pendingScrollAnchor", {}],
        ["pendingReflowScrollAnchor", {}],
        ["remeasureCharacterDimensions", true],
        ["remeasureAllBlockDecorations", true],
        ["remeasureGutterDimensions", true],
        ["remeasureScrollbars", true],
      ];
      for (const [property, value] of unsafeStates) {
        const original = component[property];
        component[property] = value;
        expect(component.canUpdateScrollPositionOnly(false, true)).toBe(false);
        expect(component.canUpdateForScrollOnly(false, true)).toBe(false);
        component[property] = original;
      }

      component.linesToMeasure.set(0, {});
      expect(component.canUpdateScrollPositionOnly(false, true)).toBe(false);
      expect(component.canUpdateForScrollOnly(false, true)).toBe(false);
      component.linesToMeasure.clear();
      component.horizontalPositionsToMeasure.set(0, []);
      expect(component.canUpdateScrollPositionOnly(false, true)).toBe(false);
      expect(component.canUpdateForScrollOnly(false, true)).toBe(false);
      component.horizontalPositionsToMeasure.clear();

      const updateSync = spyOn(component, "updateSync");
      component.blockDecorationsToMeasure.add({});
      expect(component.canUpdateScrollPositionOnly(false, true)).toBe(false);
      expect(component.canUpdateForScrollOnly(false, true)).toBe(false);
      expect(component.updateScrollAnimationFrame({ horizontal: false, vertical: true })).toBe(
        false,
      );
      expect(updateSync).toHaveBeenCalledWith({ updateMode: UPDATE_MODE_NORMAL });
      updateSync.calls.reset();
      component.blockDecorationsToMeasure.clear();

      component.decorationsToRender.overlays.push({});
      expect(component.updateScrollAnimationFrame({ horizontal: false, vertical: true })).toBe(
        false,
      );
      expect(updateSync).toHaveBeenCalledTimes(1);
      expect(updateSync).toHaveBeenCalledWith({ updateMode: UPDATE_MODE_NORMAL });
    });

    it("cancels the glide when the scroll position is set directly", () => {
      const { component, element } = buildSmoothComponent();
      let ended = 0;
      element.onDidEndScrollAnimation(() => ended++);
      const preventDefault = jasmine.createSpy("preventDefault");

      component.didMouseWheel({ deltaX: 0, deltaY: 20, deltaMode: 0, preventDefault });
      component.scrollAnimator.advance(FRAME);

      component.setScrollTop(30);
      component.updateSync();
      expect(component.scrollAnimator.isAnimating()).toBe(false);
      expect(ended).toBe(1);
      expect(component.getScrollTop()).toBe(30);

      component.scrollAnimator.advance(FRAME);
      expect(component.getScrollTop()).toBe(30);
    });

    it("cancels the glide when an autoscroll takes over the viewport", () => {
      const { component, editor } = buildSmoothComponent();
      const preventDefault = jasmine.createSpy("preventDefault");

      component.didMouseWheel({ deltaX: 0, deltaY: 20, deltaMode: 0, preventDefault });
      component.scrollAnimator.advance(FRAME);
      expect(component.scrollAnimator.isAnimating()).toBe(true);

      editor.setCursorScreenPosition([12, 0]);
      component.updateSync();
      expect(component.scrollAnimator.isAnimating()).toBe(false);
      expect(component.getScrollTop()).toBeGreaterThan(0);
    });
  });

  describe("scrolling via the API", () => {
    it("ignores scroll requests to NaN, null or undefined positions", async () => {
      const { component } = buildComponent({
        rowsPerTile: 2,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 3);
      await setEditorWidthInCharacters(component, 10);

      const initialScrollTop = Math.round(2 * component.getLineHeight());
      const initialScrollLeft = Math.round(5 * component.getBaseCharacterWidth());
      setScrollTop(component, initialScrollTop);
      setScrollLeft(component, initialScrollLeft);
      await component.getNextUpdatePromise();

      setScrollTop(component, NaN);
      setScrollLeft(component, NaN);
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBeNear(initialScrollTop);
      expect(component.getScrollLeft()).toBeNear(initialScrollLeft);

      setScrollTop(component, null);
      setScrollLeft(component, null);
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBeNear(initialScrollTop);
      expect(component.getScrollLeft()).toBeNear(initialScrollLeft);

      setScrollTop(component, undefined);
      setScrollLeft(component, undefined);
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBeNear(initialScrollTop);
      expect(component.getScrollLeft()).toBeNear(initialScrollLeft);
    });

    it("keeps the exact scroll position and quantizes only the rendered transform", async () => {
      // The stored position never rounds — only outputs snap to the physical
      // grid. Rounding the state was a feedback loop: the scroll anchor
      // restores an exact fractional target, the store quantized it, and the
      // next capture adopted the moved position as its baseline; repeated
      // block heights hit the same rounding tie every pass, so the viewport
      // walked in one direction through a long measurement run.
      const { component } = buildComponent({
        rowsPerTile: 2,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 3);

      await setScrollTop(component, 10.4);
      expect(component.getScrollTop()).toBe(10.4);
      expect(component.refs.content.style.transform).toBe("translate(0px, -10px)");

      await setScrollTop(component, 10.6);
      expect(component.getScrollTop()).toBe(10.6);
      expect(component.refs.content.style.transform).toBe("translate(0px, -11px)");
    });

    it("holds the scroll anchor through repeated half-pixel block growth", async () => {
      // The reported failure shape: a block decoration above the viewport
      // grows by a half-pixel-fractional height on every measurement pass —
      // exact-state restore must compensate each pass to the pixel, where any
      // rounding of the stored position leaked half a pixel per pass in a
      // constant direction.
      const { component, editor } = buildComponent({
        text: "line\n".repeat(200),
        rowsPerTile: 3,
        autoHeight: false,
        attach: true,
      });
      await setEditorHeightInLines(component, 6);

      const marker = editor.markScreenPosition([0, 0], { invalidate: "never" });
      const item = document.createElement("div");
      item.style.width = "30px";
      item.style.height = "90.5px";
      editor.decorateMarker(marker, { type: "block", item, position: "after" });
      await component.getNextUpdatePromise();

      await setScrollTop(component, 60 * component.getLineHeight());

      const referenceRow = 100;
      const anchorOffset = () =>
        component.pixelPositionBeforeBlocksForRow(referenceRow) - component.getScrollTop();
      const initialOffset = anchorOffset();

      for (let i = 2; i <= 20; i++) {
        item.style.height = i * 90.5 + "px";
        component.invalidateBlockDecorationDimensions(editor.getDecorations({ type: "block" })[0]);
        await component.getNextUpdatePromise();
      }

      expect(Math.abs(anchorOffset() - initialOffset)).toBeLessThan(0.001);
    });

    it("pins the scroll anchor to a block decoration while its size is dragged", async () => {
      // Growing a block decoration whose top sits above the viewport displaces
      // everything below it, and the measure pass answers by holding the first
      // visible row still — which slides the decoration itself by exactly what
      // the growth added. Right for content that resized itself; wrong for a
      // hand on a resize handle, where the decoration is the one thing that
      // must not move. The pin makes the decoration the anchor instead, for
      // the length of the gesture.
      const { component, editor, element } = buildComponent({
        text: "line\n".repeat(200),
        rowsPerTile: 30,
        autoHeight: false,
        attach: true,
      });
      await setEditorHeightInLines(component, 20);

      // Above the viewport top (rows ~85+ are on screen below) but inside the
      // first rendered tile, so the item stays in the DOM and measurable.
      const marker = editor.markScreenPosition([60, 0], { invalidate: "never" });
      const item = document.createElement("div");
      item.style.width = "30px";
      item.style.height = "40px";
      const decoration = editor.decorateMarker(marker, {
        type: "block",
        item,
        position: "after",
      });
      await component.getNextUpdatePromise();

      await setScrollTop(
        component,
        component.pixelPositionBeforeBlocksForRow(85) + component.getLineHeight() / 4,
      );

      const decorationTop = () =>
        item.getBoundingClientRect().top - element.getBoundingClientRect().top;
      const grow = async (height) => {
        item.style.height = `${height}px`;
        component.invalidateBlockDecorationDimensions(decoration);
        await component.getNextUpdatePromise();
      };

      // Unpinned: the first visible row holds its place, so the decoration
      // climbs out from under the pointer by everything the drag just added.
      const beforeGrowth = decorationTop();
      await grow(140);
      expect(decorationTop()).toBeCloseTo(beforeGrowth - 100, 0);

      // Pinned: the decoration's own top is what holds, however many passes the
      // gesture takes.
      const pin = component.pinScrollAnchorToBlockDecoration(decoration);
      const pinnedTop = decorationTop();
      await grow(240);
      expect(decorationTop()).toBeCloseTo(pinnedTop, 0);
      await grow(340);
      expect(decorationTop()).toBeCloseTo(pinnedTop, 0);

      // Released, and the viewport top is in charge again.
      pin.dispose();
      const afterRelease = decorationTop();
      await grow(440);
      expect(decorationTop()).toBeCloseTo(afterRelease - 100, 0);
    });

    it("does not scroll while a block containing the viewport top edge grows", async () => {
      // A tall block whose top is scrolled off while its bottom edge — the
      // resize handle — is still on screen. The top edge of the viewport is
      // inside the block, so growth extends the block entirely below that
      // edge: nothing above it moved, nothing scrolls, and the handle follows
      // the pointer without needing the pin.
      const { component, editor, element } = buildComponent({
        text: "line\n".repeat(200),
        rowsPerTile: 30,
        autoHeight: false,
        attach: true,
      });
      await setEditorHeightInLines(component, 20);

      const marker = editor.markScreenPosition([60, 0], { invalidate: "never" });
      const item = document.createElement("div");
      item.style.width = "30px";
      item.style.height = "400px";
      const decoration = editor.decorateMarker(marker, {
        type: "block",
        item,
        position: "after",
      });
      await component.getNextUpdatePromise();

      // The block spans [61 lines, 61 lines + 400px); land the scroll position
      // inside it.
      await setScrollTop(component, 61 * component.getLineHeight() + 200);

      const scrollTopBefore = component.getScrollTop();
      const itemBottom = () =>
        item.getBoundingClientRect().bottom - element.getBoundingClientRect().top;
      const bottomBefore = itemBottom();

      item.style.height = "500px";
      component.invalidateBlockDecorationDimensions(decoration);
      await component.getNextUpdatePromise();

      expect(component.getScrollTop()).toBe(scrollTopBefore);
      expect(itemBottom()).toBeCloseTo(bottomBefore + 100, 0);
    });

    it("announces measured block decoration heights as a decoration update", async () => {
      // A consumer projecting rows to pixels — a scrollbar map — reads block
      // heights but cannot observe an off-screen element growing; the measure
      // pass is the only party that knows.
      const { component, editor } = buildComponent({
        text: "line\n".repeat(50),
        rowsPerTile: 3,
        autoHeight: false,
        attach: true,
      });
      await setEditorHeightInLines(component, 6);

      const marker = editor.markScreenPosition([0, 0], { invalidate: "never" });
      const item = document.createElement("div");
      item.style.width = "30px";
      item.style.height = "40px";
      editor.decorateMarker(marker, { type: "block", item, position: "after" });
      await component.getNextUpdatePromise();

      let updates = 0;
      const subscription = editor.onDidUpdateDecorations(() => updates++);

      // A growth measured by the pass announces itself.
      item.style.height = "80px";
      component.invalidateBlockDecorationDimensions(editor.getDecorations({ type: "block" })[0]);
      await component.getNextUpdatePromise();
      expect(updates).toBe(1);

      // A pass that measures the same height again stays silent.
      component.invalidateBlockDecorationDimensions(editor.getDecorations({ type: "block" })[0]);
      await component.getNextUpdatePromise();
      expect(updates).toBe(1);

      subscription.dispose();
    });
  });

  describe("line and line number decorations", () => {
    it("adds decoration classes on screen lines spanned by decorated markers", async () => {
      const { component, editor } = buildComponent({
        softWrapped: true,
      });
      await setEditorWidthInCharacters(component, 55);
      expect(lineNodeForScreenRow(component, 3).textContent).toBe(
        "    var pivot = items.shift(), current, left = [], ",
      );
      expect(lineNodeForScreenRow(component, 4).textContent).toBe("    right = [];");

      const marker1 = editor.markScreenRange([
        [1, 10],
        [3, 10],
      ]);
      const layer = editor.addMarkerLayer();
      layer.markScreenPosition([5, 0]);
      layer.markScreenPosition([8, 0]);
      const marker4 = layer.markScreenPosition([10, 0]);
      editor.decorateMarker(marker1, {
        type: ["line", "line-number"],
        class: "a",
      });
      const layerDecoration = editor.decorateMarkerLayer(layer, {
        type: ["line", "line-number"],
        class: "b",
      });
      layerDecoration.setPropertiesForMarker(marker4, {
        type: "line",
        class: "c",
      });
      await component.getNextUpdatePromise();

      expect(lineNodeForScreenRow(component, 1).classList.contains("a")).toBe(true);
      expect(lineNodeForScreenRow(component, 2).classList.contains("a")).toBe(true);
      expect(lineNodeForScreenRow(component, 3).classList.contains("a")).toBe(true);
      expect(lineNodeForScreenRow(component, 4).classList.contains("a")).toBe(false);
      expect(lineNodeForScreenRow(component, 5).classList.contains("b")).toBe(true);
      expect(lineNodeForScreenRow(component, 8).classList.contains("b")).toBe(true);
      expect(lineNodeForScreenRow(component, 10).classList.contains("b")).toBe(false);
      expect(lineNodeForScreenRow(component, 10).classList.contains("c")).toBe(true);

      expect(lineNumberNodeForScreenRow(component, 1).classList.contains("a")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 2).classList.contains("a")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 3).classList.contains("a")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 4).classList.contains("a")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 5).classList.contains("b")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 8).classList.contains("b")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 10).classList.contains("b")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 10).classList.contains("c")).toBe(false);

      marker1.setScreenRange([
        [5, 0],
        [8, 0],
      ]);
      await component.getNextUpdatePromise();

      expect(lineNodeForScreenRow(component, 1).classList.contains("a")).toBe(false);
      expect(lineNodeForScreenRow(component, 2).classList.contains("a")).toBe(false);
      expect(lineNodeForScreenRow(component, 3).classList.contains("a")).toBe(false);
      expect(lineNodeForScreenRow(component, 4).classList.contains("a")).toBe(false);
      expect(lineNodeForScreenRow(component, 5).classList.contains("a")).toBe(true);
      expect(lineNodeForScreenRow(component, 5).classList.contains("b")).toBe(true);
      expect(lineNodeForScreenRow(component, 6).classList.contains("a")).toBe(true);
      expect(lineNodeForScreenRow(component, 7).classList.contains("a")).toBe(true);
      expect(lineNodeForScreenRow(component, 8).classList.contains("a")).toBe(true);
      expect(lineNodeForScreenRow(component, 8).classList.contains("b")).toBe(true);

      expect(lineNumberNodeForScreenRow(component, 1).classList.contains("a")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 2).classList.contains("a")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 3).classList.contains("a")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 4).classList.contains("a")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 5).classList.contains("a")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 5).classList.contains("b")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 6).classList.contains("a")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 7).classList.contains("a")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 8).classList.contains("a")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 8).classList.contains("b")).toBe(true);
    });

    it("honors the onlyEmpty and onlyNonEmpty decoration options", async () => {
      const { component, editor } = buildComponent();
      const marker = editor.markScreenPosition([1, 0]);
      editor.decorateMarker(marker, {
        type: ["line", "line-number"],
        class: "a",
        onlyEmpty: true,
      });
      editor.decorateMarker(marker, {
        type: ["line", "line-number"],
        class: "b",
        onlyNonEmpty: true,
      });
      editor.decorateMarker(marker, {
        type: ["line", "line-number"],
        class: "c",
      });
      await component.getNextUpdatePromise();

      expect(lineNodeForScreenRow(component, 1).classList.contains("a")).toBe(true);
      expect(lineNodeForScreenRow(component, 1).classList.contains("b")).toBe(false);
      expect(lineNodeForScreenRow(component, 1).classList.contains("c")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 1).classList.contains("a")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 1).classList.contains("b")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 1).classList.contains("c")).toBe(true);

      marker.setScreenRange([
        [1, 0],
        [2, 4],
      ]);
      await component.getNextUpdatePromise();

      expect(lineNodeForScreenRow(component, 1).classList.contains("a")).toBe(false);
      expect(lineNodeForScreenRow(component, 1).classList.contains("b")).toBe(true);
      expect(lineNodeForScreenRow(component, 1).classList.contains("c")).toBe(true);
      expect(lineNodeForScreenRow(component, 2).classList.contains("b")).toBe(true);
      expect(lineNodeForScreenRow(component, 2).classList.contains("c")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 1).classList.contains("a")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 1).classList.contains("b")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 1).classList.contains("c")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 2).classList.contains("b")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 2).classList.contains("c")).toBe(true);
    });

    it("honors the onlyHead option", async () => {
      const { component, editor } = buildComponent();
      const marker = editor.markScreenRange([
        [1, 4],
        [3, 4],
      ]);
      editor.decorateMarker(marker, {
        type: ["line", "line-number"],
        class: "a",
        onlyHead: true,
      });
      await component.getNextUpdatePromise();

      expect(lineNodeForScreenRow(component, 1).classList.contains("a")).toBe(false);
      expect(lineNodeForScreenRow(component, 3).classList.contains("a")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 1).classList.contains("a")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 3).classList.contains("a")).toBe(true);
    });

    it("decorates the head row of onlyHead decorations whose range ends at column 0", async () => {
      const { component, editor } = buildComponent();
      const marker = editor.markScreenRange([
        [1, 4],
        [3, 0],
      ]);
      editor.decorateMarker(marker, {
        type: ["line", "line-number"],
        class: "a",
        onlyHead: true,
      });
      const reversedMarker = editor.markScreenRange(
        [
          [5, 0],
          [7, 2],
        ],
        { reversed: true },
      );
      editor.decorateMarker(reversedMarker, {
        type: ["line", "line-number"],
        class: "b",
        onlyHead: true,
      });
      await component.getNextUpdatePromise();

      // The head sits at the start of row 3; it is still on row 3.
      expect(lineNodeForScreenRow(component, 2).classList.contains("a")).toBe(false);
      expect(lineNodeForScreenRow(component, 3).classList.contains("a")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 2).classList.contains("a")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 3).classList.contains("a")).toBe(true);

      expect(lineNodeForScreenRow(component, 5).classList.contains("b")).toBe(true);
      expect(lineNodeForScreenRow(component, 7).classList.contains("b")).toBe(false);
      expect(lineNumberNodeForScreenRow(component, 5).classList.contains("b")).toBe(true);
      expect(lineNumberNodeForScreenRow(component, 7).classList.contains("b")).toBe(false);
    });

    it("only decorates the last row of non-empty ranges that end at column 0 if omitEmptyLastRow is false", async () => {
      const { component, editor } = buildComponent();
      const marker = editor.markScreenRange([
        [1, 0],
        [3, 0],
      ]);
      editor.decorateMarker(marker, {
        type: ["line", "line-number"],
        class: "a",
      });
      editor.decorateMarker(marker, {
        type: ["line", "line-number"],
        class: "b",
        omitEmptyLastRow: false,
      });
      await component.getNextUpdatePromise();

      expect(lineNodeForScreenRow(component, 1).classList.contains("a")).toBe(true);
      expect(lineNodeForScreenRow(component, 2).classList.contains("a")).toBe(true);
      expect(lineNodeForScreenRow(component, 3).classList.contains("a")).toBe(false);

      expect(lineNodeForScreenRow(component, 1).classList.contains("b")).toBe(true);
      expect(lineNodeForScreenRow(component, 2).classList.contains("b")).toBe(true);
      expect(lineNodeForScreenRow(component, 3).classList.contains("b")).toBe(true);
    });

    it("does not decorate invalidated markers", async () => {
      const { component, editor } = buildComponent();
      const marker = editor.markScreenRange(
        [
          [1, 0],
          [3, 0],
        ],
        {
          invalidate: "touch",
        },
      );
      editor.decorateMarker(marker, {
        type: ["line", "line-number"],
        class: "a",
      });
      await component.getNextUpdatePromise();
      expect(lineNodeForScreenRow(component, 2).classList.contains("a")).toBe(true);

      editor.getBuffer().insert([2, 0], "x");
      expect(marker.isValid()).toBe(false);
      await component.getNextUpdatePromise();
      expect(lineNodeForScreenRow(component, 2).classList.contains("a")).toBe(false);
    });
  });

  describe("highlight decorations", () => {
    beforeEach(() => {
      useAlternativeScheduler();
    });

    afterEach(() => {
      restoreDefaultScheduler();
    });

    it("renders single-line highlights", async () => {
      const { component, element, editor } = buildComponent();
      const marker = editor.markScreenRange([
        [1, 2],
        [1, 10],
      ]);
      editor.decorateMarker(marker, { type: "highlight", class: "a" });
      await component.getNextUpdatePromise();

      {
        const regions = element.querySelectorAll(".highlight.a .region.a");
        expectHighlightRegionsToSpanRange(component, regions, 1, 2, 10);
      }

      marker.setScreenRange([
        [1, 4],
        [1, 8],
      ]);
      await component.getNextUpdatePromise();

      {
        const regions = element.querySelectorAll(".highlight.a .region.a");
        expectHighlightRegionsToSpanRange(component, regions, 1, 4, 8);
      }
    });

    it("renders multi-line highlights", async () => {
      const { component, element, editor } = buildComponent({ rowsPerTile: 3 });
      const marker = editor.markScreenRange([
        [2, 4],
        [3, 4],
      ]);
      editor.decorateMarker(marker, { type: "highlight", class: "a" });

      await component.getNextUpdatePromise();

      {
        expect(element.querySelectorAll(".highlight.a").length).toBe(1);

        const regions = element.querySelectorAll(".highlight.a .region.a");
        expect(regions.length).toBe(2);
        const region0Rect = regions[0].getBoundingClientRect();
        expect(region0Rect.top).toBe(
          lineNodeForScreenRow(component, 2).getBoundingClientRect().top,
        );
        expect(region0Rect.bottom).toBe(
          lineNodeForScreenRow(component, 2).getBoundingClientRect().bottom,
        );
        expect(Math.round(region0Rect.left)).toBeNear(clientLeftForCharacter(component, 2, 4));
        expect(Math.round(region0Rect.right)).toBeNear(
          component.refs.content.getBoundingClientRect().right,
        );

        const region1Rect = regions[1].getBoundingClientRect();
        expect(region1Rect.top).toBeNear(
          lineNodeForScreenRow(component, 3).getBoundingClientRect().top,
        );
        expect(region1Rect.bottom).toBeNear(
          lineNodeForScreenRow(component, 3).getBoundingClientRect().bottom,
        );
        expect(Math.round(region1Rect.left)).toBeNear(clientLeftForCharacter(component, 3, 0));
        expect(Math.round(region1Rect.right)).toBeNear(clientLeftForCharacter(component, 3, 4));
      }

      marker.setScreenRange([
        [2, 4],
        [5, 4],
      ]);
      await component.getNextUpdatePromise();

      {
        expect(element.querySelectorAll(".highlight.a").length).toBe(1);

        const regions = element.querySelectorAll(".highlight.a .region.a");
        expect(regions.length).toBe(3);

        const region0Rect = regions[0].getBoundingClientRect();
        expect(region0Rect.top).toBeNear(
          lineNodeForScreenRow(component, 2).getBoundingClientRect().top,
        );
        expect(region0Rect.bottom).toBeNear(
          lineNodeForScreenRow(component, 2).getBoundingClientRect().bottom,
        );
        expect(Math.round(region0Rect.left)).toBeNear(clientLeftForCharacter(component, 2, 4));
        expect(Math.round(region0Rect.right)).toBeNear(
          component.refs.content.getBoundingClientRect().right,
        );

        const region1Rect = regions[1].getBoundingClientRect();
        expect(region1Rect.top).toBeNear(
          lineNodeForScreenRow(component, 3).getBoundingClientRect().top,
        );
        expect(region1Rect.bottom).toBeNear(
          lineNodeForScreenRow(component, 5).getBoundingClientRect().top,
        );
        expect(Math.round(region1Rect.left)).toBeNear(
          component.refs.content.getBoundingClientRect().left,
        );
        expect(Math.round(region1Rect.right)).toBeNear(
          component.refs.content.getBoundingClientRect().right,
        );

        const region2Rect = regions[2].getBoundingClientRect();
        expect(region2Rect.top).toBeNear(
          lineNodeForScreenRow(component, 5).getBoundingClientRect().top,
        );
        expect(region2Rect.bottom).toBeNear(
          lineNodeForScreenRow(component, 6).getBoundingClientRect().top,
        );
        expect(Math.round(region2Rect.left)).toBeNear(
          component.refs.content.getBoundingClientRect().left,
        );
        expect(Math.round(region2Rect.right)).toBeNear(clientLeftForCharacter(component, 5, 4));
      }
    });

    it("can flash highlight decorations", async () => {
      const { component, element, editor } = buildComponent({
        rowsPerTile: 3,
        height: 200,
      });
      const marker = editor.markScreenRange([
        [2, 4],
        [3, 4],
      ]);
      const decoration = editor.decorateMarker(marker, {
        type: "highlight",
        class: "a",
      });
      decoration.flash("b", 10);

      // Flash on initial appearance of highlight
      await component.getNextUpdatePromise();
      const highlights = element.querySelectorAll(".highlight.a");
      expect(highlights.length).toBe(1);

      expect(highlights[0].classList.contains("b")).toBe(true);

      await conditionPromise(() => !highlights[0].classList.contains("b"));

      // Don't flash on next update if another flash wasn't requested
      await setScrollTop(component, 100);
      expect(highlights[0].classList.contains("b")).toBe(false);

      // Flashing the same class again before the first flash completes
      // removes the flash class and adds it back on the next frame to ensure
      // CSS transitions apply to the second flash.
      decoration.flash("e", 100);
      await component.getNextUpdatePromise();
      expect(highlights[0].classList.contains("e")).toBe(true);

      decoration.flash("e", 100);
      await component.getNextUpdatePromise();
      expect(highlights[0].classList.contains("e")).toBe(false);

      await conditionPromise(() => highlights[0].classList.contains("e"));
      await conditionPromise(() => !highlights[0].classList.contains("e"));
    });

    it("flashing a highlight decoration doesn't unflash other highlight decorations", async () => {
      jasmine.useRealClock();
      const { component, element, editor } = buildComponent({
        rowsPerTile: 3,
        height: 200,
      });
      const marker = editor.markScreenRange([
        [2, 4],
        [3, 4],
      ]);
      const decoration = editor.decorateMarker(marker, {
        type: "highlight",
        class: "a",
      });

      // Flash one class
      decoration.flash("c", 1000);
      await component.getNextUpdatePromise();
      const highlights = element.querySelectorAll(".highlight.a");
      expect(highlights.length).toBe(1);
      expect(highlights[0].classList.contains("c")).toBe(true);

      // Flash another class while the previously-flashed class is still highlighted
      decoration.flash("d", process.env.CI ? 1500 : 100);
      await component.getNextUpdatePromise();
      expect(highlights[0].classList.contains("c")).toBe(true);
      expect(highlights[0].classList.contains("d")).toBe(true);
    });

    it("supports layer decorations", async () => {
      const { component, element, editor } = buildComponent({
        rowsPerTile: 12,
      });
      const markerLayer = editor.addMarkerLayer();
      const marker1 = markerLayer.markScreenRange([
        [2, 4],
        [3, 4],
      ]);
      const marker2 = markerLayer.markScreenRange([
        [5, 6],
        [7, 8],
      ]);
      const decoration = editor.decorateMarkerLayer(markerLayer, {
        type: "highlight",
        class: "a",
      });
      await component.getNextUpdatePromise();

      const highlights = element.querySelectorAll(".highlight");
      expect(highlights[0].classList.contains("a")).toBe(true);
      expect(highlights[1].classList.contains("a")).toBe(true);

      decoration.setPropertiesForMarker(marker1, {
        type: "highlight",
        class: "b",
      });
      await component.getNextUpdatePromise();
      expect(highlights[0].classList.contains("b")).toBe(true);
      expect(highlights[1].classList.contains("a")).toBe(true);

      decoration.setPropertiesForMarker(marker1, null);
      decoration.setPropertiesForMarker(marker2, {
        type: "highlight",
        class: "c",
      });
      await component.getNextUpdatePromise();
      expect(highlights[0].classList.contains("a")).toBe(true);
      expect(highlights[1].classList.contains("c")).toBe(true);
    });

    it("clears highlights when recycling a tile that previously contained highlights and now does not", async () => {
      const { component, element, editor } = buildComponent({
        rowsPerTile: 2,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 2);
      const marker = editor.markScreenRange([
        [1, 2],
        [1, 10],
      ]);
      editor.decorateMarker(marker, { type: "highlight", class: "a" });

      await component.getNextUpdatePromise();
      expect(element.querySelectorAll(".highlight.a").length).toBe(1);

      await setScrollTop(component, component.getLineHeight() * 3);
      expect(element.querySelectorAll(".highlight.a").length).toBe(0);
    });

    it("does not move existing highlights when adding or removing other highlight decorations (regression)", async () => {
      const { component, element, editor } = buildComponent();

      const marker1 = editor.markScreenRange([
        [1, 6],
        [1, 10],
      ]);
      editor.decorateMarker(marker1, { type: "highlight", class: "a" });
      await component.getNextUpdatePromise();
      const marker1Region = element.querySelector(".highlight.a");
      expect(Array.from(marker1Region.parentElement.children).indexOf(marker1Region)).toBe(0);

      const marker2 = editor.markScreenRange([
        [1, 2],
        [1, 4],
      ]);
      editor.decorateMarker(marker2, { type: "highlight", class: "b" });
      await component.getNextUpdatePromise();
      const marker2Region = element.querySelector(".highlight.b");
      expect(Array.from(marker1Region.parentElement.children).indexOf(marker1Region)).toBe(0);
      expect(Array.from(marker2Region.parentElement.children).indexOf(marker2Region)).toBe(1);

      marker2.destroy();
      await component.getNextUpdatePromise();
      expect(Array.from(marker1Region.parentElement.children).indexOf(marker1Region)).toBe(0);
    });

    it("correctly positions highlights that end on rows preceding or following block decorations", async () => {
      const { editor, element, component } = buildComponent();

      const item1 = document.createElement("div");
      item1.style.height = "30px";
      item1.style.backgroundColor = "blue";
      editor.decorateMarker(editor.markBufferPosition([4, 0]), {
        type: "block",
        position: "after",
        item: item1,
      });
      const item2 = document.createElement("div");
      item2.style.height = "30px";
      item2.style.backgroundColor = "yellow";
      editor.decorateMarker(editor.markBufferPosition([4, 0]), {
        type: "block",
        position: "before",
        item: item2,
      });
      editor.decorateMarker(
        editor.markBufferRange([
          [3, 0],
          [4, Infinity],
        ]),
        {
          type: "highlight",
          class: "highlight",
        },
      );

      await component.getNextUpdatePromise();
      const regions = element.querySelectorAll(".highlight .region");
      expect(regions[0].offsetTop).toBeNear(3 * component.getLineHeight());
      expect(regions[0].offsetHeight).toBeNear(component.getLineHeight());
      expect(regions[1].offsetTop).toBeNear(4 * component.getLineHeight() + 30);
    });
  });

  describe("overlay decorations", () => {
    function attachFakeWindow(component) {
      const fakeWindow = document.createElement("div");
      fakeWindow.style.position = "absolute";
      fakeWindow.style.padding = 20 + "px";
      fakeWindow.style.backgroundColor = "blue";
      fakeWindow.appendChild(component.element);
      jasmine.attachToDOM(fakeWindow);
      spyOn(component, "getWindowInnerWidth").and.callFake(
        () => fakeWindow.getBoundingClientRect().width,
      );
      spyOn(component, "getWindowInnerHeight").and.callFake(
        () => fakeWindow.getBoundingClientRect().height,
      );
      return fakeWindow;
    }

    it("renders overlay elements at the specified screen position unless it would overflow the window", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 100,
        attach: false,
      });
      // Use a whole-pixel line height so the overflow-flip decisions below do
      // not depend on the platform's font metrics.
      element.style.lineHeight = "16px";
      const fakeWindow = attachFakeWindow(component);

      await setScrollTop(component, 50);
      await setScrollLeft(component, 100);

      const marker = editor.markScreenPosition([4, 25]);

      const overlayElement = document.createElement("div");
      overlayElement.style.width = "50px";
      overlayElement.style.height = "50px";
      overlayElement.style.margin = "3px";
      overlayElement.style.backgroundColor = "red";

      const decoration = editor.decorateMarker(marker, {
        type: "overlay",
        item: overlayElement,
        class: "a",
      });
      await component.getNextUpdatePromise();

      const overlayComponent = component.overlayComponents.values().next().value;

      const overlayWrapper = overlayElement.parentElement;
      expect(overlayWrapper.classList.contains("a")).toBe(true);
      expect(overlayWrapper.getBoundingClientRect().top).toBeNear(clientTopForLine(component, 5));
      expect(overlayWrapper.getBoundingClientRect().left).toBeNear(
        clientLeftForCharacter(component, 4, 25),
      );

      // Updates the horizontal position on scroll
      await setScrollLeft(component, 150);
      expect(overlayWrapper.getBoundingClientRect().left).toBeNear(
        clientLeftForCharacter(component, 4, 25),
      );

      // Shifts the overlay horizontally to ensure the overlay element does not
      // overflow the window
      await setScrollLeft(component, 30);
      expect(overlayElement.getBoundingClientRect().right).toBeNear(
        fakeWindow.getBoundingClientRect().right,
      );
      await setScrollLeft(component, 280);
      expect(overlayElement.getBoundingClientRect().left).toBeNear(
        fakeWindow.getBoundingClientRect().left,
      );

      // Updates the vertical position on scroll
      await setScrollTop(component, 60);
      expect(overlayWrapper.getBoundingClientRect().top).toBeNear(clientTopForLine(component, 5));

      // Flips the overlay vertically to ensure the overlay element does not
      // overflow the bottom of the window
      setScrollLeft(component, 100);
      await setScrollTop(component, 0);
      expect(overlayWrapper.getBoundingClientRect().bottom).toBeNear(
        clientTopForLine(component, 4),
      );

      // Flips the overlay vertically on overlay resize if necessary
      await setScrollTop(component, 20);
      expect(overlayWrapper.getBoundingClientRect().top).toBeNear(clientTopForLine(component, 5));
      overlayElement.style.height = 60 + "px";
      {
        const nextOverlayUpdate = overlayComponent.getNextUpdatePromise();
        overlayComponent.props.didResize(overlayComponent);
        await nextOverlayUpdate;
      }
      expect(overlayWrapper.getBoundingClientRect().bottom).toBeNear(
        clientTopForLine(component, 4),
      );

      // Does not flip the overlay vertically if it would overflow the top of the window
      overlayElement.style.height = 80 + "px";
      {
        const nextOverlayUpdate = overlayComponent.getNextUpdatePromise();
        overlayComponent.props.didResize(overlayComponent);
        await nextOverlayUpdate;
      }
      expect(overlayWrapper.getBoundingClientRect().top).toBeNear(clientTopForLine(component, 5));

      // Reports where the annotated position ended up, for an overlay that
      // draws a pointer at it: which side of the line it was placed on, and
      // how far into its own box the position now falls once its margin and
      // the window edges have had their say.
      setScrollLeft(component, 100);
      await setScrollTop(component, 20);
      overlayElement.style.height = 50 + "px";
      {
        const nextOverlayUpdate = overlayComponent.getNextUpdatePromise();
        overlayComponent.props.didResize(overlayComponent);
        await nextOverlayUpdate;
      }
      expect(overlayWrapper.dataset.overlayPosition).toBe("below");
      // The margin is all that moved it, so the position sits that far in —
      // and the margin itself is reported, for a pointer drawn on the wrapper
      // rather than on an item that clips its overflow.
      expect(overlayWrapper.style.getPropertyValue("--overlay-anchor-offset")).toBe("-3px");
      expect(overlayWrapper.style.getPropertyValue("--overlay-margin-left")).toBe("3px");

      await setScrollTop(component, 0);
      expect(overlayWrapper.dataset.overlayPosition).toBe("above");

      // Pushed off the right edge, the position stays where it was and the
      // box slides out from under it.
      await setScrollLeft(component, 30);
      expect(
        parseInt(overlayWrapper.style.getPropertyValue("--overlay-anchor-offset"), 10),
      ).toBeGreaterThan(0);

      // Can update overlay wrapper class
      decoration.setProperties({
        type: "overlay",
        item: overlayElement,
        class: "b",
      });
      await component.getNextUpdatePromise();
      expect(overlayWrapper.classList.contains("a")).toBe(false);
      expect(overlayWrapper.classList.contains("b")).toBe(true);

      decoration.setProperties({ type: "overlay", item: overlayElement });
      await component.getNextUpdatePromise();
      expect(overlayWrapper.classList.contains("b")).toBe(false);
    });

    it("does not attempt to avoid overflowing the window if `avoidOverflow` is false on the decoration", async () => {
      const { component, editor } = buildComponent({
        width: 200,
        height: 100,
        attach: false,
      });
      const fakeWindow = attachFakeWindow(component);
      const overlayElement = document.createElement("div");
      overlayElement.style.width = "50px";
      overlayElement.style.height = "50px";
      overlayElement.style.margin = "3px";
      overlayElement.style.backgroundColor = "red";
      const marker = editor.markScreenPosition([4, 25]);
      editor.decorateMarker(marker, {
        type: "overlay",
        item: overlayElement,
        avoidOverflow: false,
      });
      await component.getNextUpdatePromise();

      await setScrollLeft(component, 30);
      expect(overlayElement.getBoundingClientRect().right).toBeGreaterThan(
        fakeWindow.getBoundingClientRect().right,
      );
      await setScrollLeft(component, 280);
      expect(overlayElement.getBoundingClientRect().left).toBeLessThan(
        fakeWindow.getBoundingClientRect().left,
      );
    });

    // The specs above are about the window edges deciding where an overlay
    // goes. These are about overlays deciding it between themselves, so the
    // window is pinned out of the way instead: a height the caller chooses, and
    // a width nothing can reach. The top edge is always the viewport's, so an
    // overlay that must not fit above is made tall rather than moved.
    function attachWithWindowHeight(component, getWindowInnerHeight) {
      jasmine.attachToDOM(component.element);
      spyOn(component, "getWindowInnerWidth").and.returnValue(100000);
      spyOn(component, "getWindowInnerHeight").and.callFake(getWindowInnerHeight);
      return () => component.refs.content.getBoundingClientRect().top;
    }

    function buildOverlayItem(height = 20) {
      const item = document.createElement("div");
      item.style.width = "20px";
      item.style.height = `${height}px`;
      item.style.margin = "3px";
      item.style.backgroundColor = "red";
      return item;
    }

    function rectsIntersect(a, b) {
      return a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right;
    }

    it("places an overlay above the line when the decoration asks for that side", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      attachWithWindowHeight(component, () => 100000);

      const item = buildOverlayItem();
      editor.decorateMarker(editor.markScreenPosition([4, 5]), {
        type: "overlay",
        item,
        side: "above",
      });
      await component.getNextUpdatePromise();

      const wrapper = item.parentElement;
      expect(wrapper.dataset.overlayPosition).toBe("above");
      expect(wrapper.getBoundingClientRect().bottom).toBeNear(clientTopForLine(component, 4));
    });

    it("uses the other side when the requested one would overflow the window", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      attachWithWindowHeight(component, () => 100000);

      // Too tall to stand above the first row, whatever the window offers below.
      const item = buildOverlayItem(2000);
      editor.decorateMarker(editor.markScreenPosition([0, 0]), {
        type: "overlay",
        item,
        side: "above",
      });
      await component.getNextUpdatePromise();

      const wrapper = item.parentElement;
      expect(wrapper.dataset.overlayPosition).toBe("below");
      expect(wrapper.getBoundingClientRect().top).toBeNear(clientTopForLine(component, 1));
    });

    it("keeps overlays on the same row off each other, highest priority first", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      attachWithWindowHeight(component, () => 100000);

      const high = buildOverlayItem();
      const low = buildOverlayItem();
      editor.decorateMarker(editor.markScreenPosition([4, 5]), {
        type: "overlay",
        item: high,
        priority: 1,
      });
      editor.decorateMarker(editor.markScreenPosition([4, 5]), {
        type: "overlay",
        item: low,
        priority: 0,
      });
      await component.getNextUpdatePromise();

      expect(high.parentElement.dataset.overlayPosition).toBe("below");
      expect(low.parentElement.dataset.overlayPosition).toBe("above");
      expect(
        rectsIntersect(
          high.parentElement.getBoundingClientRect(),
          low.parentElement.getBoundingClientRect(),
        ),
      ).toBe(false);
    });

    it("gives the contested side to the higher priority overlay regardless of creation order", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      attachWithWindowHeight(component, () => 100000);

      // The low-priority overlay is created first this time; the markers also
      // arrive in spatial order rather than creation order, so nothing about
      // the outcome may depend on either.
      const low = buildOverlayItem();
      const high = buildOverlayItem();
      editor.decorateMarker(editor.markScreenPosition([4, 5]), {
        type: "overlay",
        item: low,
        priority: 0,
      });
      editor.decorateMarker(editor.markScreenPosition([4, 5]), {
        type: "overlay",
        item: high,
        priority: 1,
      });
      await component.getNextUpdatePromise();

      expect(high.parentElement.dataset.overlayPosition).toBe("below");
      expect(low.parentElement.dataset.overlayPosition).toBe("above");
    });

    it("orders overlay elements by priority so the higher one paints last", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      attachWithWindowHeight(component, () => 100000);

      const low = buildOverlayItem();
      const high = buildOverlayItem();
      editor.decorateMarker(editor.markScreenPosition([4, 5]), {
        type: "overlay",
        item: low,
        priority: 0,
      });
      editor.decorateMarker(editor.markScreenPosition([6, 5]), {
        type: "overlay",
        item: high,
        priority: 1,
      });
      await component.getNextUpdatePromise();

      const wrappers = Array.from(component.element.querySelectorAll("lumine-overlay"));
      expect(wrappers).toEqual([low.parentElement, high.parentElement]);
    });

    it("pushes an overlay past the one blocking its side when the other side will not fit", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      attachWithWindowHeight(component, () => 100000);

      const high = buildOverlayItem();
      // On the first row and far too tall to stand above it, so the side it
      // asked for is taken and the other one is not available.
      const low = buildOverlayItem(2000);
      editor.decorateMarker(editor.markScreenPosition([0, 0]), {
        type: "overlay",
        item: high,
        priority: 1,
      });
      editor.decorateMarker(editor.markScreenPosition([0, 0]), {
        type: "overlay",
        item: low,
        priority: 0,
      });
      await component.getNextUpdatePromise();

      const highRect = high.parentElement.getBoundingClientRect();
      const lowRect = low.parentElement.getBoundingClientRect();
      expect(high.parentElement.dataset.overlayPosition).toBe("below");
      expect(low.parentElement.dataset.overlayPosition).toBe("below");
      expect(lowRect.top).toBeNear(highRect.bottom);
      expect(rectsIntersect(highRect, lowRect)).toBe(false);
    });

    it("marks a displaced overlay, and only a displaced one", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      attachWithWindowHeight(component, () => 100000);

      const high = buildOverlayItem();
      const pushed = buildOverlayItem(2000);
      // This one is contended with too, but has a free side to go to, so it
      // yields rather than being pushed.
      const yielded = buildOverlayItem();
      editor.decorateMarker(editor.markScreenPosition([0, 0]), {
        type: "overlay",
        item: high,
        priority: 1,
      });
      editor.decorateMarker(editor.markScreenPosition([0, 0]), {
        type: "overlay",
        item: pushed,
        priority: 0,
      });
      editor.decorateMarker(editor.markScreenPosition([6, 5]), {
        type: "overlay",
        item: yielded,
        priority: 1,
      });
      editor.decorateMarker(editor.markScreenPosition([6, 5]), {
        type: "overlay",
        item: buildOverlayItem(),
        priority: 0,
      });
      await component.getNextUpdatePromise();

      expect(pushed.parentElement.hasAttribute("data-overlay-displaced")).toBe(true);
      expect(high.parentElement.hasAttribute("data-overlay-displaced")).toBe(false);
      expect(yielded.parentElement.hasAttribute("data-overlay-displaced")).toBe(false);
    });

    it("overlaps rather than leaving the window when displacement will not fit either", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      let windowInnerHeight = 100000;
      const contentTop = attachWithWindowHeight(component, () => windowInnerHeight);

      // Room below for the tall overlay where it belongs, but not for it pushed
      // past the one already there. Half an overlay can be read; one past the
      // window edge cannot, so it takes the overlap.
      windowInnerHeight = contentTop() + 2030;

      const high = buildOverlayItem();
      // Asks for the side it cannot have — too tall to stand above the first
      // row — so the side it settles for is the one it did not ask for. That is
      // what separates taking the overlap from staying where it asked to be:
      // for an overlay whose own side still fits, the two are the same place.
      const low = buildOverlayItem(2000);
      editor.decorateMarker(editor.markScreenPosition([0, 0]), {
        type: "overlay",
        item: high,
        priority: 1,
      });
      editor.decorateMarker(editor.markScreenPosition([0, 0]), {
        type: "overlay",
        item: low,
        side: "above",
        priority: 0,
      });
      await component.getNextUpdatePromise();

      const lowWrapper = low.parentElement;
      expect(lowWrapper.dataset.overlayPosition).toBe("below");
      expect(lowWrapper.hasAttribute("data-overlay-displaced")).toBe(false);
      expect(lowWrapper.getBoundingClientRect().top).toBeNear(clientTopForLine(component, 1));
      expect(
        rectsIntersect(
          high.parentElement.getBoundingClientRect(),
          lowWrapper.getBoundingClientRect(),
        ),
      ).toBe(true);
    });

    it("does not let an overlay that opted out of overflow avoidance claim or block a side", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      attachWithWindowHeight(component, () => 100000);

      const optedOut = buildOverlayItem();
      const normal = buildOverlayItem();
      editor.decorateMarker(editor.markScreenPosition([4, 5]), {
        type: "overlay",
        item: optedOut,
        avoidOverflow: false,
        priority: 1,
      });
      editor.decorateMarker(editor.markScreenPosition([4, 5]), {
        type: "overlay",
        item: normal,
        priority: 0,
      });
      await component.getNextUpdatePromise();

      expect(normal.parentElement.dataset.overlayPosition).toBe("below");
      expect(normal.parentElement.getBoundingClientRect().top).toBeNear(
        clientTopForLine(component, 5),
      );
      expect(optedOut.parentElement.getBoundingClientRect().top).toBeNear(
        clientTopForLine(component, 5),
      );
    });

    it("does not treat an overlay with no size as an obstacle", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      attachWithWindowHeight(component, () => 100000);

      // Nothing drawn, but margins of its own — which must claim nothing.
      const empty = buildOverlayItem(0);
      empty.style.width = "0px";
      const normal = buildOverlayItem();
      editor.decorateMarker(editor.markScreenPosition([4, 5]), {
        type: "overlay",
        item: empty,
        priority: 1,
      });
      editor.decorateMarker(editor.markScreenPosition([4, 5]), {
        type: "overlay",
        item: normal,
        priority: 0,
      });
      await component.getNextUpdatePromise();

      expect(normal.parentElement.dataset.overlayPosition).toBe("below");
      expect(normal.parentElement.getBoundingClientRect().top).toBeNear(
        clientTopForLine(component, 5),
      );
    });

    it("re-places every overlay when one of them resizes", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      let windowInnerHeight = 100000;
      const contentTop = attachWithWindowHeight(component, () => windowInnerHeight);

      // Room below row 10 for a 20px overlay, but not for a 40px one.
      windowInnerHeight = contentTop() + 200;

      const high = buildOverlayItem();
      const low = buildOverlayItem();
      editor.decorateMarker(editor.markScreenPosition([10, 0]), {
        type: "overlay",
        item: high,
        priority: 1,
      });
      editor.decorateMarker(editor.markScreenPosition([10, 0]), {
        type: "overlay",
        item: low,
        priority: 0,
      });
      await component.getNextUpdatePromise();

      expect(high.parentElement.dataset.overlayPosition).toBe("below");
      expect(low.parentElement.dataset.overlayPosition).toBe("above");

      // The high-priority overlay grows out of the space below the line and
      // flips over it, which frees that space for the one that had yielded.
      const highComponent = component.overlayComponentsByElement.get(high);
      high.style.height = "40px";
      {
        const nextOverlayUpdate = highComponent.getNextUpdatePromise();
        highComponent.props.didResize(highComponent);
        await nextOverlayUpdate;
      }

      expect(high.parentElement.dataset.overlayPosition).toBe("above");
      expect(low.parentElement.dataset.overlayPosition).toBe("below");
    });

    it("resolves the resized overlay's update promise when its placement is unchanged", async () => {
      const { component, element, editor } = buildComponent({
        width: 200,
        height: 300,
        attach: false,
      });
      element.style.lineHeight = "16px";
      attachWithWindowHeight(component, () => 100000);

      const item = buildOverlayItem();
      editor.decorateMarker(editor.markScreenPosition([4, 5]), { type: "overlay", item });
      await component.getNextUpdatePromise();

      // Nothing about the placement changes here. The overlay that reported the
      // resize is waiting on this promise all the same, so it is always updated
      // — skipping it because it did not move would hang rather than fail.
      const overlayComponent = component.overlayComponentsByElement.get(item);
      const nextOverlayUpdate = overlayComponent.getNextUpdatePromise();
      overlayComponent.props.didResize(overlayComponent);
      await nextOverlayUpdate;

      expect(item.parentElement.dataset.overlayPosition).toBe("below");
    });
  });

  describe("custom gutter decorations", () => {
    it("arranges custom gutters based on their priority", async () => {
      const { component, editor } = buildComponent();
      editor.addGutter({ name: "e", priority: 2 });
      editor.addGutter({ name: "a", priority: -2 });
      editor.addGutter({ name: "d", priority: 1 });
      editor.addGutter({ name: "b", priority: -1 });
      editor.addGutter({ name: "c", priority: 0 });

      await component.getNextUpdatePromise();
      const gutters = component.refs.gutterContainer.element.querySelectorAll(".gutter");
      expect(Array.from(gutters).map((g) => g.getAttribute("gutter-name"))).toEqual([
        "a",
        "b",
        "c",
        "line-number",
        "d",
        "e",
      ]);
    });

    it("adjusts the left edge of the scroll container based on changes to the gutter container width", async () => {
      const { component, editor } = buildComponent();
      const { scrollContainer, gutterContainer } = component.refs;

      function checkScrollContainerLeft() {
        expect(scrollContainer.getBoundingClientRect().left).toBeNear(
          Math.round(gutterContainer.element.getBoundingClientRect().right),
        );
      }

      checkScrollContainerLeft();
      const gutterA = editor.addGutter({ name: "a" });
      await component.getNextUpdatePromise();
      checkScrollContainerLeft();

      const gutterB = editor.addGutter({ name: "b" });
      await component.getNextUpdatePromise();
      checkScrollContainerLeft();

      gutterA.getElement().style.width = 100 + "px";
      // Drive the resize directly instead of racing ResizeObserver delivery.
      // didResizeGutterContainer measures the new gutter width and schedules
      // the same component update that the observer callback would schedule.
      component.didResizeGutterContainer();
      await component.getNextUpdatePromise();
      checkScrollContainerLeft();

      gutterA.hide();
      await component.getNextUpdatePromise();
      checkScrollContainerLeft();

      gutterA.show();
      await component.getNextUpdatePromise();
      checkScrollContainerLeft();

      gutterA.destroy();
      await component.getNextUpdatePromise();
      checkScrollContainerLeft();

      gutterB.destroy();
      await component.getNextUpdatePromise();
      checkScrollContainerLeft();
    });

    it("allows the element of custom gutters to be retrieved before being rendered in the editor component", async () => {
      const { component, element, editor } = buildComponent();
      const [lineNumberGutter] = editor.getGutters();
      const gutterA = editor.addGutter({ name: "a", priority: -1 });
      const gutterB = editor.addGutter({ name: "b", priority: 1 });

      const lineNumberGutterElement = lineNumberGutter.getElement();
      const gutterAElement = gutterA.getElement();
      const gutterBElement = gutterB.getElement();

      await component.getNextUpdatePromise();

      expect(element.contains(lineNumberGutterElement)).toBe(true);
      expect(element.contains(gutterAElement)).toBe(true);
      expect(element.contains(gutterBElement)).toBe(true);
    });

    it("can show and hide custom gutters", async () => {
      const { component, editor } = buildComponent();
      const gutterA = editor.addGutter({ name: "a", priority: -1 });
      const gutterB = editor.addGutter({ name: "b", priority: 1 });
      const gutterAElement = gutterA.getElement();
      const gutterBElement = gutterB.getElement();

      await component.getNextUpdatePromise();
      expect(gutterAElement.style.display).toBe("");
      expect(gutterBElement.style.display).toBe("");

      gutterA.hide();
      await component.getNextUpdatePromise();
      expect(gutterAElement.style.display).toBe("none");
      expect(gutterBElement.style.display).toBe("");

      gutterB.hide();
      await component.getNextUpdatePromise();
      expect(gutterAElement.style.display).toBe("none");
      expect(gutterBElement.style.display).toBe("none");

      gutterA.show();
      await component.getNextUpdatePromise();
      expect(gutterAElement.style.display).toBe("");
      expect(gutterBElement.style.display).toBe("none");
    });

    it("renders decorations in custom gutters", async () => {
      const { component, element, editor } = buildComponent();
      const gutterA = editor.addGutter({ name: "a", priority: -1 });
      const gutterB = editor.addGutter({ name: "b", priority: 1 });
      const marker1 = editor.markScreenRange([
        [2, 0],
        [4, 0],
      ]);
      const marker2 = editor.markScreenRange([
        [6, 0],
        [7, 0],
      ]);
      const marker3 = editor.markScreenRange([
        [9, 0],
        [12, 0],
      ]);
      const decorationElement1 = document.createElement("div");
      const decorationElement2 = document.createElement("div");
      // Packages may adopt this class name for decorations to be styled the same as line numbers
      decorationElement2.className = "line-number";

      const decoration1 = gutterA.decorateMarker(marker1, { class: "a" });
      const decoration2 = gutterA.decorateMarker(marker2, {
        class: "b",
        item: decorationElement1,
      });
      const decoration3 = gutterB.decorateMarker(marker3, {
        item: decorationElement2,
      });
      await component.getNextUpdatePromise();

      let [decorationNode1, decorationNode2] = gutterA.getElement().firstChild.children;
      const [decorationNode3] = gutterB.getElement().firstChild.children;

      expect(decorationNode1.className).toBe("decoration a");
      expect(decorationNode1.getBoundingClientRect().top).toBeNear(clientTopForLine(component, 2));
      expect(decorationNode1.getBoundingClientRect().bottom).toBeNear(
        clientTopForLine(component, 5),
      );
      expect(decorationNode1.firstChild).toBeNull();

      expect(decorationNode2.className).toBe("decoration b");
      expect(decorationNode2.getBoundingClientRect().top).toBeNear(clientTopForLine(component, 6));
      expect(decorationNode2.getBoundingClientRect().bottom).toBeNear(
        clientTopForLine(component, 8),
      );
      expect(decorationNode2.firstChild).toBe(decorationElement1);
      expect(decorationElement1.offsetHeight).toBe(decorationNode2.offsetHeight);
      expect(decorationElement1.offsetWidth).toBe(decorationNode2.offsetWidth);

      expect(decorationNode3.className).toBe("decoration");
      expect(decorationNode3.getBoundingClientRect().top).toBeNear(clientTopForLine(component, 9));
      expect(decorationNode3.getBoundingClientRect().bottom).toBeNear(
        clientTopForLine(component, 12) + component.getLineHeight(),
      );
      expect(decorationNode3.firstChild).toBe(decorationElement2);
      expect(decorationElement2.offsetHeight).toBe(decorationNode3.offsetHeight);
      expect(decorationElement2.offsetWidth).toBe(decorationNode3.offsetWidth);

      // Inline styled height is updated when line height changes
      element.style.fontSize = parseInt(getComputedStyle(element).fontSize) + 10 + "px";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      expect(decorationElement1.offsetHeight).toBe(decorationNode2.offsetHeight);
      expect(decorationElement2.offsetHeight).toBe(decorationNode3.offsetHeight);

      decoration1.setProperties({
        type: "gutter",
        gutterName: "a",
        class: "c",
        item: decorationElement1,
      });
      decoration2.setProperties({ type: "gutter", gutterName: "a" });
      decoration3.destroy();
      await component.getNextUpdatePromise();
      expect(decorationNode1.className).toBe("decoration c");
      expect(decorationNode1.firstChild).toBe(decorationElement1);
      expect(decorationElement1.offsetHeight).toBe(decorationNode1.offsetHeight);
      expect(decorationNode2.className).toBe("decoration");
      expect(decorationNode2.firstChild).toBeNull();
      expect(gutterB.getElement().firstChild.children.length).toBe(0);
    });

    it("renders custom line number gutters", async () => {
      const { component, editor } = buildComponent();
      const gutterA = editor.addGutter({
        name: "a",
        priority: 1,
        type: "line-number",
        class: "a-number",
        labelFn: ({ bufferRow }) => `a - ${bufferRow}`,
      });
      const gutterB = editor.addGutter({
        name: "b",
        priority: 1,
        type: "line-number",
        class: "b-number",
        labelFn: ({ bufferRow }) => `b - ${bufferRow}`,
      });
      editor.setText("0000\n0001\n0002\n0003\n0004\n");

      await component.getNextUpdatePromise();

      const gutterAElement = gutterA.getElement();
      const aNumbers = gutterAElement.querySelectorAll("div.line-number[data-buffer-row]");
      const aLabels = Array.from(aNumbers, (e) => e.textContent);
      expect(aLabels).toEqual(["a - 0", "a - 1", "a - 2", "a - 3", "a - 4", "a - 5"]);

      const gutterBElement = gutterB.getElement();
      const bNumbers = gutterBElement.querySelectorAll("div.line-number[data-buffer-row]");
      const bLabels = Array.from(bNumbers, (e) => e.textContent);
      expect(bLabels).toEqual(["b - 0", "b - 1", "b - 2", "b - 3", "b - 4", "b - 5"]);
    });

    it("only renders fold controls in the default line number gutter", async () => {
      const { component, editor } = buildComponent({ text: "parent\nchild\nsibling" });
      const foldability = [];
      const gutter = editor.addGutter({
        name: "custom-line-numbers",
        type: "line-number",
        labelFn({ bufferRow, foldable }) {
          foldability[bufferRow] = foldable;
          return foldable ? "fold" : "";
        },
      });

      await component.getNextUpdatePromise();

      const defaultGutter = editor.getLineNumberGutter().getElement();
      const customGutter = gutter.getElement();
      expect(defaultGutter.querySelector('[data-buffer-row="0"]')).not.toHaveClass("foldable");
      expect(defaultGutter.querySelectorAll(".icon-right").length).toBeGreaterThan(0);
      expect(customGutter.querySelector(".foldable")).toBeNull();
      expect(customGutter.querySelector(".icon-right")).toBeNull();
      expect(customGutter.querySelector('[data-buffer-row="0"]').textContent).toBe("");
      expect(foldability[0]).toBe(false);

      editor.setCursorBufferPosition([1, 0]);
      editor.insertText("  ");
      await component.getNextUpdatePromise();

      expect(defaultGutter.querySelector('[data-buffer-row="0"]')).toHaveClass("foldable");
      expect(customGutter.querySelector(".foldable")).toBeNull();
      expect(customGutter.querySelector(".icon-right")).toBeNull();
      expect(customGutter.querySelector('[data-buffer-row="0"]').textContent).toBe("fold");
      expect(foldability[0]).toBe(true);
    });

    it("reports custom line number gutter events for child targets and ignores non-row targets", async () => {
      const mouseDownEvents = [];
      const mouseMoveEvents = [];
      const { component, editor } = buildComponent();
      const gutter = editor.addGutter({
        name: "custom-line-numbers",
        type: "line-number",
        onMouseDown(event) {
          mouseDownEvents.push(event);
        },
        onMouseMove(event) {
          mouseMoveEvents.push(event);
        },
      });

      await component.getNextUpdatePromise();

      const gutterElement = gutter.getElement();
      const lineNumber = gutterElement.querySelector('[data-buffer-row="2"]');
      const child = document.createElement("span");
      lineNumber.appendChild(child);

      const mouseDown = new MouseEvent("mousedown", { bubbles: true });
      const mouseMove = new MouseEvent("mousemove", { bubbles: true });
      child.dispatchEvent(mouseDown);
      child.dispatchEvent(mouseMove);

      expect(mouseDownEvents).toEqual([{ bufferRow: 2, screenRow: 2, domEvent: mouseDown }]);
      expect(mouseMoveEvents).toEqual([{ bufferRow: 2, screenRow: 2, domEvent: mouseMove }]);

      const dummy = gutterElement.querySelector(".line-number.dummy");
      dummy.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      dummy.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      gutterElement.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      gutterElement.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      expect(mouseDownEvents.length).toBe(1);
      expect(mouseMoveEvents.length).toBe(1);
    });

    it("updates the editor's soft wrap width when a custom gutter's measurement is available", () => {
      const { component, element, editor } = buildComponent({
        lineNumberGutterVisible: false,
        width: 400,
        softWrapped: true,
        attach: false,
      });
      const gutter = editor.addGutter({ name: "a", priority: 10 });
      gutter.getElement().style.width = "100px";

      jasmine.attachToDOM(element);

      expect(component.getGutterContainerWidth()).toBe(100);

      // Component client width - gutter container width - vertical scrollbar width
      const softWrapColumn = Math.floor(
        (400 - 100 - component.getVerticalScrollbarWidth()) / component.getBaseCharacterWidth(),
      );
      expect(editor.getSoftWrapColumn()).toBe(softWrapColumn);
    });
  });

  describe("block decorations", () => {
    it("renders visible block decorations between the appropriate lines, refreshing and measuring them as needed", async () => {
      const editor = buildEditor({ autoHeight: false });
      const { item: item1, decoration: decoration1 } = createBlockDecorationAtScreenRow(editor, 0, {
        height: 11,
        position: "before",
      });
      const { item: item2, decoration: decoration2 } = createBlockDecorationAtScreenRow(editor, 2, {
        height: 22,
        margin: 10,
        position: "before",
      });

      // render an editor that already contains some block decorations
      const { component, element } = buildComponent({ editor, rowsPerTile: 3 });
      element.style.height = 4 * component.getLineHeight() + horizontalScrollbarHeight + "px";
      // Drive the resize directly instead of racing ResizeObserver delivery.
      component.didResize();
      expect(component.getRenderedStartRow()).toBe(0);
      expect(component.getRenderedEndRow()).toBe(9);
      expect(component.getScrollHeight()).toBeNear(
        editor.getScreenLineCount() * component.getLineHeight() +
          getElementHeight(item1) +
          getElementHeight(item2),
      );
      assertTilesAreSizedAndPositionedCorrectly(component, [
        {
          tileStartRow: 0,
          height: 3 * component.getLineHeight() + getElementHeight(item1) + getElementHeight(item2),
        },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
      ]);
      assertLinesAreAlignedWithLineNumbers(component);
      expect(queryOnScreenLineElements(element).length).toBe(9);
      expect(item1.previousSibling).toBeNull();
      expect(item1.nextSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item2.previousSibling).toBe(lineNodeForScreenRow(component, 1));
      expect(item2.nextSibling).toBe(lineNodeForScreenRow(component, 2));

      // add block decorations
      const { item: item3, decoration: decoration3 } = createBlockDecorationAtScreenRow(editor, 4, {
        height: 33,
        position: "before",
      });
      const { item: item4 } = createBlockDecorationAtScreenRow(editor, 7, {
        height: 44,
        position: "before",
      });
      const { item: item5 } = createBlockDecorationAtScreenRow(editor, 7, {
        height: 50,
        marginBottom: 5,
        position: "after",
      });
      const { item: item6 } = createBlockDecorationAtScreenRow(editor, 12, {
        height: 60,
        marginTop: 6,
        position: "after",
      });
      await component.getNextUpdatePromise();
      expect(component.getRenderedStartRow()).toBe(0);
      expect(component.getRenderedEndRow()).toBe(9);
      expect(component.getScrollHeight()).toBeNear(
        editor.getScreenLineCount() * component.getLineHeight() +
          getElementHeight(item1) +
          getElementHeight(item2) +
          getElementHeight(item3) +
          getElementHeight(item4) +
          getElementHeight(item5) +
          getElementHeight(item6),
      );
      assertTilesAreSizedAndPositionedCorrectly(component, [
        {
          tileStartRow: 0,
          height: 3 * component.getLineHeight() + getElementHeight(item1) + getElementHeight(item2),
        },
        {
          tileStartRow: 3,
          height: 3 * component.getLineHeight() + getElementHeight(item3),
        },
      ]);
      assertLinesAreAlignedWithLineNumbers(component);
      expect(queryOnScreenLineElements(element).length).toBe(9);
      expect(item1.previousSibling).toBeNull();
      expect(item1.nextSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item2.previousSibling).toBe(lineNodeForScreenRow(component, 1));
      expect(item2.nextSibling).toBe(lineNodeForScreenRow(component, 2));
      expect(item3.previousSibling).toBe(lineNodeForScreenRow(component, 3));
      expect(item3.nextSibling).toBe(lineNodeForScreenRow(component, 4));
      expect(item4.nextSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(item5.previousSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(element.contains(item6)).toBe(false);

      // destroy decoration1
      decoration1.destroy();
      await component.getNextUpdatePromise();
      expect(component.getRenderedStartRow()).toBe(0);
      expect(component.getRenderedEndRow()).toBe(9);
      expect(component.getScrollHeight()).toBeNear(
        editor.getScreenLineCount() * component.getLineHeight() +
          getElementHeight(item2) +
          getElementHeight(item3) +
          getElementHeight(item4) +
          getElementHeight(item5) +
          getElementHeight(item6),
      );
      assertTilesAreSizedAndPositionedCorrectly(component, [
        {
          tileStartRow: 0,
          height: 3 * component.getLineHeight() + getElementHeight(item2),
        },
        {
          tileStartRow: 3,
          height: 3 * component.getLineHeight() + getElementHeight(item3),
        },
      ]);
      assertLinesAreAlignedWithLineNumbers(component);
      expect(queryOnScreenLineElements(element).length).toBe(9);
      expect(element.contains(item1)).toBe(false);
      expect(item2.previousSibling).toBe(lineNodeForScreenRow(component, 1));
      expect(item2.nextSibling).toBe(lineNodeForScreenRow(component, 2));
      expect(item3.previousSibling).toBe(lineNodeForScreenRow(component, 3));
      expect(item3.nextSibling).toBe(lineNodeForScreenRow(component, 4));
      expect(item4.nextSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(item5.previousSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(element.contains(item6)).toBe(false);

      // move decoration2 and decoration3
      decoration2.getMarker().setHeadScreenPosition([1, 0]);
      decoration3.getMarker().setHeadScreenPosition([0, 0]);
      await component.getNextUpdatePromise();
      expect(component.getRenderedStartRow()).toBe(0);
      expect(component.getRenderedEndRow()).toBe(9);
      expect(component.getScrollHeight()).toBeNear(
        editor.getScreenLineCount() * component.getLineHeight() +
          getElementHeight(item2) +
          getElementHeight(item3) +
          getElementHeight(item4) +
          getElementHeight(item5) +
          getElementHeight(item6),
      );
      assertTilesAreSizedAndPositionedCorrectly(component, [
        {
          tileStartRow: 0,
          height: 3 * component.getLineHeight() + getElementHeight(item2) + getElementHeight(item3),
        },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
      ]);
      assertLinesAreAlignedWithLineNumbers(component);
      expect(queryOnScreenLineElements(element).length).toBe(9);
      expect(element.contains(item1)).toBe(false);
      expect(item2.previousSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item2.nextSibling).toBe(lineNodeForScreenRow(component, 1));
      expect(item3.previousSibling).toBeNull();
      expect(item3.nextSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item4.nextSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(item5.previousSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(element.contains(item6)).toBe(false);

      // change the text
      editor.getBuffer().setTextInRange(
        [
          [0, 5],
          [0, 5],
        ],
        "\n\n",
      );
      await component.getNextUpdatePromise();
      expect(component.getRenderedStartRow()).toBe(0);
      expect(component.getRenderedEndRow()).toBe(9);
      expect(component.getScrollHeight()).toBeNear(
        editor.getScreenLineCount() * component.getLineHeight() +
          getElementHeight(item2) +
          getElementHeight(item3) +
          getElementHeight(item4) +
          getElementHeight(item5) +
          getElementHeight(item6),
      );
      assertTilesAreSizedAndPositionedCorrectly(component, [
        {
          tileStartRow: 0,
          height: 3 * component.getLineHeight() + getElementHeight(item3),
        },
        {
          tileStartRow: 3,
          height: 3 * component.getLineHeight() + getElementHeight(item2),
        },
      ]);
      assertLinesAreAlignedWithLineNumbers(component);
      expect(queryOnScreenLineElements(element).length).toBe(9);
      expect(element.contains(item1)).toBe(false);
      expect(item2.previousSibling).toBeNull();
      expect(item2.nextSibling).toBe(lineNodeForScreenRow(component, 3));
      expect(item3.previousSibling).toBeNull();
      expect(item3.nextSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(element.contains(item4)).toBe(false);
      expect(element.contains(item5)).toBe(false);
      expect(element.contains(item6)).toBe(false);

      // scroll past the first tile
      await setScrollTop(component, 3 * component.getLineHeight() + getElementHeight(item3));
      await wait(100);
      expect(component.getRenderedStartRow()).toBe(3);
      expect(component.getRenderedEndRow()).toBe(12);
      expect(component.getScrollHeight()).toBeNear(
        editor.getScreenLineCount() * component.getLineHeight() +
          getElementHeight(item2) +
          getElementHeight(item3) +
          getElementHeight(item4) +
          getElementHeight(item5) +
          getElementHeight(item6),
      );
      assertTilesAreSizedAndPositionedCorrectly(component, [
        {
          tileStartRow: 3,
          height: 3 * component.getLineHeight() + getElementHeight(item2),
        },
        { tileStartRow: 6, height: 3 * component.getLineHeight() },
      ]);
      assertLinesAreAlignedWithLineNumbers(component);
      expect(queryOnScreenLineElements(element).length).toBe(9);
      expect(element.contains(item1)).toBe(false);
      expect(item2.previousSibling).toBeNull();
      expect(item2.nextSibling).toBe(lineNodeForScreenRow(component, 3));
      expect(element.contains(item3)).toBe(false);
      expect(item4.nextSibling).toBe(lineNodeForScreenRow(component, 9));
      expect(item5.previousSibling).toBe(lineNodeForScreenRow(component, 9));
      expect(element.contains(item6)).toBe(false);
      await setScrollTop(component, 0);

      // undo the previous change
      editor.undo();
      await component.getNextUpdatePromise();
      expect(component.getRenderedStartRow()).toBe(0);
      expect(component.getRenderedEndRow()).toBe(9);
      expect(component.getScrollHeight()).toBeNear(
        editor.getScreenLineCount() * component.getLineHeight() +
          getElementHeight(item2) +
          getElementHeight(item3) +
          getElementHeight(item4) +
          getElementHeight(item5) +
          getElementHeight(item6),
      );
      assertTilesAreSizedAndPositionedCorrectly(component, [
        {
          tileStartRow: 0,
          height: 3 * component.getLineHeight() + getElementHeight(item2) + getElementHeight(item3),
        },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
      ]);
      assertLinesAreAlignedWithLineNumbers(component);
      expect(queryOnScreenLineElements(element).length).toBe(9);
      expect(element.contains(item1)).toBe(false);
      expect(item2.previousSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item2.nextSibling).toBe(lineNodeForScreenRow(component, 1));
      expect(item3.previousSibling).toBeNull();
      expect(item3.nextSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item4.nextSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(item5.previousSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(element.contains(item6)).toBe(false);

      // invalidate decorations. this also tests a case where two decorations in
      // the same tile change their height without affecting the tile height nor
      // the content height.
      item3.style.height = "22px";
      item3.style.margin = "10px";
      item2.style.height = "33px";
      item2.style.margin = "0px";
      component.didResizeBlockDecorations([
        { target: item2, contentRect: { height: item2.getBoundingClientRect().height } },
        { target: item3, contentRect: { height: item3.getBoundingClientRect().height } },
      ]);
      await component.getNextUpdatePromise();
      expect(component.getRenderedStartRow()).toBe(0);
      expect(component.getRenderedEndRow()).toBe(9);
      expect(component.getScrollHeight()).toBeNear(
        editor.getScreenLineCount() * component.getLineHeight() +
          getElementHeight(item2) +
          getElementHeight(item3) +
          getElementHeight(item4) +
          getElementHeight(item5) +
          getElementHeight(item6),
      );
      assertTilesAreSizedAndPositionedCorrectly(component, [
        {
          tileStartRow: 0,
          height: 3 * component.getLineHeight() + getElementHeight(item2) + getElementHeight(item3),
        },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
      ]);
      assertLinesAreAlignedWithLineNumbers(component);
      expect(queryOnScreenLineElements(element).length).toBe(9);
      expect(element.contains(item1)).toBe(false);
      expect(item2.previousSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item2.nextSibling).toBe(lineNodeForScreenRow(component, 1));
      expect(item3.previousSibling).toBeNull();
      expect(item3.nextSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item4.nextSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(item5.previousSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(element.contains(item6)).toBe(false);

      // make decoration before row 0 as wide as the editor, and insert some text into it so that it wraps.
      item3.style.height = "";
      item3.style.margin = "";
      item3.style.width = "";
      item3.style.wordWrap = "break-word";
      const contentWidthInCharacters = Math.floor(
        component.getScrollContainerClientWidth() / component.getBaseCharacterWidth(),
      );
      item3.textContent = "x".repeat(contentWidthInCharacters * 2);
      component.didResizeBlockDecorations([
        { target: item3, contentRect: { height: item3.getBoundingClientRect().height } },
      ]);
      await component.getNextUpdatePromise();

      // make the editor wider, so that the decoration doesn't wrap anymore.
      component.element.style.width =
        component.getGutterContainerWidth() +
        component.getScrollContainerClientWidth() * 2 +
        verticalScrollbarWidth +
        "px";
      // Drive the resize directly instead of waiting on ResizeObserver
      // delivery; didResize performs the update synchronously, so awaiting
      // getNextUpdatePromise() here would hang.
      component.didResize();
      expect(component.getRenderedStartRow()).toBe(0);
      expect(component.getRenderedEndRow()).toBe(9);
      expect(component.getScrollHeight()).toBeNear(
        editor.getScreenLineCount() * component.getLineHeight() +
          getElementHeight(item2) +
          getElementHeight(item3) +
          getElementHeight(item4) +
          getElementHeight(item5) +
          getElementHeight(item6),
      );
      assertTilesAreSizedAndPositionedCorrectly(component, [
        {
          tileStartRow: 0,
          height: 3 * component.getLineHeight() + getElementHeight(item2) + getElementHeight(item3),
        },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
      ]);
      assertLinesAreAlignedWithLineNumbers(component);
      expect(queryOnScreenLineElements(element).length).toBe(9);
      expect(element.contains(item1)).toBe(false);
      expect(item2.previousSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item2.nextSibling).toBe(lineNodeForScreenRow(component, 1));
      expect(item3.previousSibling).toBeNull();
      expect(item3.nextSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item3.nextSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item4.nextSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(element.contains(item6)).toBe(false);

      // make the editor taller and wider and the same time, ensuring the number
      // of rendered lines is correct.
      setEditorHeightInLines(component, 13);
      setEditorWidthInCharacters(component, 50);
      await conditionPromise(
        () => component.getRenderedStartRow() === 0 && component.getRenderedEndRow() === 13,
      );
      expect(component.getScrollHeight()).toBeNear(
        editor.getScreenLineCount() * component.getLineHeight() +
          getElementHeight(item2) +
          getElementHeight(item3) +
          getElementHeight(item4) +
          getElementHeight(item5) +
          getElementHeight(item6),
      );
      assertTilesAreSizedAndPositionedCorrectly(component, [
        {
          tileStartRow: 0,
          height: 3 * component.getLineHeight() + getElementHeight(item2) + getElementHeight(item3),
        },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
        {
          tileStartRow: 6,
          height: 3 * component.getLineHeight() + getElementHeight(item4) + getElementHeight(item5),
        },
      ]);
      assertLinesAreAlignedWithLineNumbers(component);
      expect(queryOnScreenLineElements(element).length).toBe(13);
      expect(element.contains(item1)).toBe(false);
      expect(item2.previousSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item2.nextSibling).toBe(lineNodeForScreenRow(component, 1));
      expect(item3.previousSibling).toBeNull();
      expect(item3.nextSibling).toBe(lineNodeForScreenRow(component, 0));
      expect(item4.previousSibling).toBe(lineNodeForScreenRow(component, 6));
      expect(item4.nextSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(item5.previousSibling).toBe(lineNodeForScreenRow(component, 7));
      expect(item5.nextSibling).toBe(lineNodeForScreenRow(component, 8));
      expect(item6.previousSibling).toBe(lineNodeForScreenRow(component, 12));
    });

    it("correctly positions line numbers when block decorations are located at tile boundaries", async () => {
      const { editor, component } = buildComponent({ rowsPerTile: 3 });
      createBlockDecorationAtScreenRow(editor, 0, {
        height: 5,
        position: "before",
      });
      createBlockDecorationAtScreenRow(editor, 2, {
        height: 7,
        position: "after",
      });
      createBlockDecorationAtScreenRow(editor, 3, {
        height: 9,
        position: "before",
      });
      createBlockDecorationAtScreenRow(editor, 3, {
        height: 11,
        position: "after",
      });
      createBlockDecorationAtScreenRow(editor, 5, {
        height: 13,
        position: "after",
      });

      await component.getNextUpdatePromise();
      assertLinesAreAlignedWithLineNumbers(component);
      assertTilesAreSizedAndPositionedCorrectly(component, [
        { tileStartRow: 0, height: 3 * component.getLineHeight() + 5 + 7 },
        {
          tileStartRow: 3,
          height: 3 * component.getLineHeight() + 9 + 11 + 13,
        },
        { tileStartRow: 6, height: 3 * component.getLineHeight() },
      ]);
    });

    it("keeps the viewport top stable while a block below it is added, resized, moved, and removed", async () => {
      const { editor, component } = buildComponent({ autoHeight: false });
      await setEditorHeightInLines(component, 8);
      // The cursor is deliberately visible, below the block: block geometry
      // anchors the top of the viewport, never the cursor, so the block pushes
      // the cursor's row around while the top edge holds still.
      editor.setCursorScreenPosition([12, 0], { autoscroll: false });
      await setScrollTop(
        component,
        component.pixelPositionBeforeBlocksForRow(12) - 3 * component.getLineHeight(),
      );

      const topRow = component.getFirstVisibleRow();
      const topOffset = () =>
        component.pixelPositionBeforeBlocksForRow(topRow) - component.getScrollTop();
      const cursorOffset = () =>
        component.pixelPositionBeforeBlocksForRow(editor.getCursorScreenPosition().row) -
        component.getScrollTop();
      const expectedOffset = topOffset();
      const cursorOffsetBefore = cursorOffset();

      const { item, decoration, marker } = createBlockDecorationAtScreenRow(editor, 10, {
        height: 30,
        position: "before",
      });
      await component.getNextUpdatePromise();
      expect(topOffset()).toBeNear(expectedOffset);
      // The block sits between the viewport top and the cursor, so the cursor
      // is what moves — by exactly the block's height.
      expect(cursorOffset()).toBeNear(cursorOffsetBefore + 30);

      item.style.height = "70px";
      component.didResizeBlockDecorations([{ target: item, contentRect: { height: 70 } }]);
      await component.getNextUpdatePromise();
      expect(topOffset()).toBeNear(expectedOffset);

      item.style.height = "15px";
      component.didResizeBlockDecorations([{ target: item, contentRect: { height: 15 } }]);
      await component.getNextUpdatePromise();
      expect(topOffset()).toBeNear(expectedOffset);

      marker.setHeadScreenPosition([14, 0]);
      await component.getNextUpdatePromise();
      expect(topOffset()).toBeNear(expectedOffset);

      marker.setHeadScreenPosition([10, 0]);
      await component.getNextUpdatePromise();
      expect(topOffset()).toBeNear(expectedOffset);

      decoration.destroy();
      marker.destroy();
      await component.getNextUpdatePromise();
      expect(topOffset()).toBeNear(expectedOffset);

      // The original regression accumulated one displacement per run/clear
      // cycle, so exercise the lifecycle repeatedly rather than only once.
      for (let i = 0; i < 3; i++) {
        const result = createBlockDecorationAtScreenRow(editor, 10, {
          height: 20 + i * 5,
          position: "before",
        });
        await component.getNextUpdatePromise();
        expect(topOffset()).toBeNear(expectedOffset);
        result.decoration.destroy();
        result.marker.destroy();
        await component.getNextUpdatePromise();
        expect(topOffset()).toBeNear(expectedOffset);
      }
    });

    it("anchors one batch of block measurements without scrolling for blocks below the viewport top", async () => {
      const { editor, component } = buildComponent({ autoHeight: false });
      await setEditorHeightInLines(component, 8);
      editor.setCursorScreenPosition([12, 0], { autoscroll: false });
      await setScrollTop(
        component,
        component.pixelPositionBeforeBlocksForRow(12) - 3 * component.getLineHeight(),
      );

      // A `before` block on the top row itself inserts below that row's anchor
      // pixel, so even it needs no compensation: everything lands below the
      // viewport's top edge, and nothing scrolls.
      const scrollTopBefore = component.getScrollTop();
      createBlockDecorationAtScreenRow(editor, 9, { height: 12, position: "before" });
      createBlockDecorationAtScreenRow(editor, 10, { height: 18, position: "before" });
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBe(scrollTopBefore);

      const { item } = createBlockDecorationAtScreenRow(editor, 14, {
        height: 25,
        position: "before",
      });
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBe(scrollTopBefore);

      item.style.height = "50px";
      component.didResizeBlockDecorations([{ target: item, contentRect: { height: 50 } }]);
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBe(scrollTopBefore);
    });

    it("keeps the viewport top stable when a block marker is invalidated", async () => {
      const { editor, component } = buildComponent({ autoHeight: false });
      await setEditorHeightInLines(component, 8);
      // Visible cursor below the block on purpose: the top edge, not the
      // cursor, is what the removal must hold still.
      editor.setCursorScreenPosition([12, 0], { autoscroll: false });
      await setScrollTop(
        component,
        component.pixelPositionBeforeBlocksForRow(12) - 3 * component.getLineHeight(),
      );
      const { marker } = createBlockDecorationAtScreenRow(editor, 10, {
        height: 35,
        position: "before",
        invalidate: "touch",
      });
      await component.getNextUpdatePromise();

      const topRow = component.getFirstVisibleRow();
      const offsetBefore =
        component.pixelPositionBeforeBlocksForRow(topRow) - component.getScrollTop();
      const range = marker.bufferMarker.getRange();
      marker.bufferMarker.update(range, { valid: false });
      await component.getNextUpdatePromise();
      expect(component.pixelPositionBeforeBlocksForRow(topRow) - component.getScrollTop()).toBeNear(
        offsetBefore,
      );
    });

    it("keeps the viewport top stable when block geometry changes while scrolled past the end", async () => {
      // Scrolled more than half a screen past the end, a growing block at the
      // end of the file must extend into the empty past-end gap below it, not
      // scroll the text up to keep the gap's size. The reflow paths preserve
      // the gap deliberately; the block path anchors the first visible row
      // like everywhere else.
      const { editor, component } = buildComponent({ autoHeight: false });
      editor.update({ scrollPastEnd: true });
      await setEditorHeightInLines(component, 8);
      await setScrollTop(component, component.getMaxScrollTop());

      const scrollTopBefore = component.getScrollTop();
      const maxScrollTopBefore = component.getMaxScrollTop();
      const { item, decoration } = createBlockDecorationAtScreenRow(
        editor,
        editor.getLastScreenRow(),
        {
          height: 30,
          position: "before",
        },
      );
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBe(scrollTopBefore);
      // The growth went into the scroll extent — the gap absorbed it.
      expect(component.getMaxScrollTop()).toBe(maxScrollTopBefore + 30);

      item.style.height = "60px";
      component.didResizeBlockDecorations([{ target: item, contentRect: { height: 60 } }]);
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBe(scrollTopBefore);

      decoration.destroy();
      await component.getNextUpdatePromise();
      expect(component.getScrollTop()).toBe(scrollTopBefore);
      expect(component.getScrollTop()).toBe(component.getMaxScrollTop());
    });

    it("removes block decorations whose markers have been destroyed", async () => {
      const { editor, component } = buildComponent({ rowsPerTile: 3 });
      const { marker } = createBlockDecorationAtScreenRow(editor, 2, {
        height: 5,
        position: "before",
      });
      await component.getNextUpdatePromise();
      assertLinesAreAlignedWithLineNumbers(component);
      assertTilesAreSizedAndPositionedCorrectly(component, [
        { tileStartRow: 0, height: 3 * component.getLineHeight() + 5 },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
        { tileStartRow: 6, height: 3 * component.getLineHeight() },
      ]);

      marker.destroy();
      await component.getNextUpdatePromise();
      assertLinesAreAlignedWithLineNumbers(component);
      assertTilesAreSizedAndPositionedCorrectly(component, [
        { tileStartRow: 0, height: 3 * component.getLineHeight() },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
        { tileStartRow: 6, height: 3 * component.getLineHeight() },
      ]);
    });

    it("removes block decorations whose markers are invalidated, and adds them back when they become valid again", async () => {
      const editor = buildEditor({ rowsPerTile: 3, autoHeight: false });
      const { item, decoration, marker } = createBlockDecorationAtScreenRow(editor, 3, {
        height: 44,
        position: "before",
        invalidate: "touch",
      });
      const { component } = buildComponent({ editor, rowsPerTile: 3 });

      // Invalidating the marker removes the block decoration.
      editor.getBuffer().deleteRows(2, 3);
      await component.getNextUpdatePromise();
      expect(item.parentElement).toBeNull();
      assertLinesAreAlignedWithLineNumbers(component);
      assertTilesAreSizedAndPositionedCorrectly(component, [
        { tileStartRow: 0, height: 3 * component.getLineHeight() },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
        { tileStartRow: 6, height: 3 * component.getLineHeight() },
      ]);

      // Moving invalid markers is ignored.
      marker.setScreenRange([
        [2, 0],
        [2, 0],
      ]);
      await component.getNextUpdatePromise();
      expect(item.parentElement).toBeNull();
      assertLinesAreAlignedWithLineNumbers(component);
      assertTilesAreSizedAndPositionedCorrectly(component, [
        { tileStartRow: 0, height: 3 * component.getLineHeight() },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
        { tileStartRow: 6, height: 3 * component.getLineHeight() },
      ]);

      // Making the marker valid again adds back the block decoration.
      marker.bufferMarker.valid = true;
      marker.setScreenRange([
        [3, 0],
        [3, 0],
      ]);
      await component.getNextUpdatePromise();
      expect(item.nextSibling).toBe(lineNodeForScreenRow(component, 3));
      assertLinesAreAlignedWithLineNumbers(component);
      assertTilesAreSizedAndPositionedCorrectly(component, [
        { tileStartRow: 0, height: 3 * component.getLineHeight() },
        { tileStartRow: 3, height: 3 * component.getLineHeight() + 44 },
        { tileStartRow: 6, height: 3 * component.getLineHeight() },
      ]);

      // Destroying the decoration and invalidating the marker at the same time
      // removes the block decoration correctly.
      editor.getBuffer().deleteRows(2, 3);
      decoration.destroy();
      await component.getNextUpdatePromise();
      expect(item.parentElement).toBeNull();
      assertLinesAreAlignedWithLineNumbers(component);
      assertTilesAreSizedAndPositionedCorrectly(component, [
        { tileStartRow: 0, height: 3 * component.getLineHeight() },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
        { tileStartRow: 6, height: 3 * component.getLineHeight() },
      ]);
    });

    it("does not render block decorations when decorating invalid markers", async () => {
      const editor = buildEditor({ rowsPerTile: 3, autoHeight: false });
      const { component } = buildComponent({ editor, rowsPerTile: 3 });

      const marker = editor.markScreenPosition([3, 0], { invalidate: "touch" });
      const item = document.createElement("div");
      item.style.height = 30 + "px";
      item.style.width = 30 + "px";
      editor.getBuffer().deleteRows(1, 4);

      editor.decorateMarker(marker, {
        type: "block",
        item,
        position: "before",
      });
      await component.getNextUpdatePromise();
      expect(item.parentElement).toBeNull();
      assertLinesAreAlignedWithLineNumbers(component);
      assertTilesAreSizedAndPositionedCorrectly(component, [
        { tileStartRow: 0, height: 3 * component.getLineHeight() },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
        { tileStartRow: 6, height: 3 * component.getLineHeight() },
      ]);

      // Making the marker valid again causes the corresponding block decoration
      // to be added to the editor.
      marker.bufferMarker.valid = true;
      marker.setScreenRange([
        [2, 0],
        [2, 0],
      ]);
      await component.getNextUpdatePromise();
      expect(item.nextSibling).toBe(lineNodeForScreenRow(component, 2));
      assertLinesAreAlignedWithLineNumbers(component);
      assertTilesAreSizedAndPositionedCorrectly(component, [
        { tileStartRow: 0, height: 3 * component.getLineHeight() + 30 },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
        { tileStartRow: 6, height: 3 * component.getLineHeight() },
      ]);
    });

    it("does not try to remeasure block decorations whose markers are invalid (regression)", async () => {
      const editor = buildEditor({ rowsPerTile: 3, autoHeight: false });
      const { component } = buildComponent({ editor, rowsPerTile: 3 });
      createBlockDecorationAtScreenRow(editor, 2, {
        height: "12px",
        invalidate: "touch",
      });
      editor.getBuffer().deleteRows(0, 3);
      await component.getNextUpdatePromise();

      // Trigger a re-measurement of all block decorations.
      await setEditorWidthInCharacters(component, 20);
      assertLinesAreAlignedWithLineNumbers(component);
      assertTilesAreSizedAndPositionedCorrectly(component, [
        { tileStartRow: 0, height: 3 * component.getLineHeight() },
        { tileStartRow: 3, height: 3 * component.getLineHeight() },
        { tileStartRow: 6, height: 3 * component.getLineHeight() },
      ]);
    });

    it("does not throw exceptions when destroying a block decoration inside a marker change event (regression)", async () => {
      const { editor, component } = buildComponent({ rowsPerTile: 3 });

      const marker = editor.markScreenPosition([2, 0]);
      marker.onDidChange(() => {
        marker.destroy();
      });
      const item = document.createElement("div");
      editor.decorateMarker(marker, { type: "block", item });

      await component.getNextUpdatePromise();
      expect(item.nextSibling).toBe(lineNodeForScreenRow(component, 2));

      marker.setBufferRange([
        [0, 0],
        [0, 0],
      ]);
      expect(marker.isDestroyed()).toBe(true);

      await component.getNextUpdatePromise();
      expect(item.parentElement).toBeNull();
    });

    it("does not attempt to render block decorations located outside the visible range", async () => {
      // Build a text editor with only two rows per tile.
      const { editor, element, component } = buildComponent({
        autoHeight: false,
        rowsPerTile: 2,
      });

      // Set `line-height` to an integer to save us headaches later. (We
      // believe that Chromium used to guarantee fixed increments of line
      // height, but doesn't anymore — so we must specify it as an integer
      // value ourselves if we want the math to be simpler.)
      element.style.lineHeight = "20px";
      component.measureCharacterDimensions();

      // Make the editor tall enough to fit only two lines at a time.
      await setEditorHeightInLines(component, 2);

      expect(component.getRenderedStartRow()).toBe(0);

      // This suggests one extra tile is rendered below the viewport just out
      // of view. (But why is this `4` rather than `3`, since we're
      // zero-indexed? This seems like a mistake in `getRenderedEndRow` logic.)
      expect(component.getRenderedEndRow()).toBe(4);

      // Create a marker spanning the fourth and fifth rows…
      const marker1 = editor.markScreenRange(
        [
          [3, 0],
          [5, 0],
        ],
        {
          reversed: false,
        },
      );

      // …and decorate it with a DIV.
      const item1 = document.createElement("div");
      editor.decorateMarker(marker1, { type: "block", item: item1 });

      // Repeat, but with the marker reversed.
      const marker2 = editor.markScreenRange(
        [
          [3, 0],
          [5, 0],
        ],
        {
          reversed: true,
        },
      );
      const item2 = document.createElement("div");
      editor.decorateMarker(marker2, { type: "block", item: item2 });

      await component.getNextUpdatePromise();

      // We do not expect the first block decoration to be rendered; its head
      // is outside the renderered range.
      expect(item1.parentElement).toBeNull();

      // But we expect the second decoration to be present because its head
      // _is_ within the rendered range. (Remember that a “reversed” marker has
      // its head _before_ its tail, but a non-reversed marker starts with its
      // tail and ends with its head. Read the text-buffer docs for `Marker`
      // for further understanding.)
      //
      // This comment does not imply understanding of the reasoning behind
      // this — just that this is the relevant difference in behavior between
      // the two decorations.
      expect(item2.nextSibling).toBe(lineNodeForScreenRow(component, 3));

      // Scroll down so that the fifth line is the first one visible.
      await setScrollTop(component, 4 * component.getLineHeight());

      // Again, lines 4-5-6-7 (zero-indexed) are understood to be visible, but
      // `getRenderedEndRow` will report an end row of `8`, which is its own
      // quirk.
      expect(component.getRenderedStartRow()).toBe(4);
      expect(component.getRenderedEndRow()).toBe(8);

      // Now the logic is reversed; the rendered range includes the head of
      // the first decoration, but not of the second decoration. Hence the
      // first decoration is renderered and the second isn't.
      expect(item1.nextSibling).toBe(lineNodeForScreenRow(component, 5));
      expect(item2.parentElement).toBeNull();
    });

    it("computes sane derived dimensions when revealed with a block decoration added while detached (regression)", () => {
      const { editor, component, element } = buildComponent({
        autoHeight: false,
        attach: false,
      });
      const marker = editor.markScreenPosition([0, 0]);
      const item = document.createElement("div");
      item.textContent = "block decoration";
      editor.decorateMarker(marker, { type: "block", item });

      // The constructor's initial renderSync runs before any measurements and
      // caches a NaN firstVisibleRow. Revealing the editor with this block
      // decoration pending measures it under a scroll anchor before that
      // cache is reset, so the anchor used to build Point(NaN, 0) and throw -
      // swallowed by the custom-element callback boundary, visible only as an
      // uncaught error on the console.
      jasmine.attachToDOM(element);
      expect(component.getFirstVisibleRow()).toBe(0);
    });

    it("measures block decorations correctly when they are added before the component width has been updated", async () => {
      {
        const { editor, component, element } = buildComponent({
          autoHeight: false,
          width: 500,
          attach: false,
        });
        const marker = editor.markScreenPosition([0, 0]);
        const item = document.createElement("div");
        item.textContent = "block decoration";
        editor.decorateMarker(marker, {
          type: "block",
          item,
        });

        jasmine.attachToDOM(element);
        assertLinesAreAlignedWithLineNumbers(component);
        // Detach this editor once verified. Leaving it attached pushes the next
        // editor below the window's fold, where the IntersectionObserver can
        // hide it before its scheduled update flushes — updateSync then bails
        // without resolving getNextUpdatePromise(), hanging the spec (observed
        // as a deterministic 120s timeout on macOS CI).
        element.remove();
      }

      {
        const { editor, component, element } = buildComponent({
          autoHeight: false,
          width: 800,
        });
        const marker = editor.markScreenPosition([0, 0]);
        const item = document.createElement("div");
        item.textContent = "block decoration that could wrap many times";
        editor.decorateMarker(marker, {
          type: "block",
          item,
        });

        element.style.width = "50px";
        // Drive the resize directly instead of waiting on ResizeObserver
        // delivery; didResize performs the update synchronously.
        component.didResize();
        assertLinesAreAlignedWithLineNumbers(component);
      }
    });

    it("bases the width of the block decoration measurement area on the editor scroll width", async () => {
      const { component, element } = buildComponent({
        autoHeight: false,
        width: 150,
      });
      expect(component.refs.blockDecorationMeasurementArea.offsetWidth).toBe(
        component.getScrollWidth(),
      );

      element.style.width = "800px";
      // Drive the resize directly instead of waiting on ResizeObserver
      // delivery; didResize performs the update synchronously.
      component.didResize();
      expect(component.refs.blockDecorationMeasurementArea.offsetWidth).toBe(
        component.getScrollWidth(),
      );
    });

    it("does not change the cursor position when clicking on a block decoration", async () => {
      const { editor, component } = buildComponent();

      const decorationElement = document.createElement("div");
      decorationElement.textContent = "Parent";
      const childElement = document.createElement("div");
      childElement.textContent = "Child";
      decorationElement.appendChild(childElement);
      const marker = editor.markScreenPosition([4, 0]);
      editor.decorateMarker(marker, { type: "block", item: decorationElement });
      await component.getNextUpdatePromise();

      const decorationElementClientRect = decorationElement.getBoundingClientRect();
      component.didMouseDownOnContent({
        target: decorationElement,
        detail: 1,
        button: 0,
        clientX: decorationElementClientRect.left,
        clientY: decorationElementClientRect.top,
      });
      expect(editor.getCursorScreenPosition()).toEqual([0, 0]);

      const childElementClientRect = childElement.getBoundingClientRect();
      component.didMouseDownOnContent({
        target: childElement,
        detail: 1,
        button: 0,
        clientX: childElementClientRect.left,
        clientY: childElementClientRect.top,
      });
      expect(editor.getCursorScreenPosition()).toEqual([0, 0]);
    });

    it("uses the order property to control the order of block decorations at the same screen row", async () => {
      const editor = buildEditor({ autoHeight: false });
      const { component, element } = buildComponent({ editor });
      element.style.height = 10 * component.getLineHeight() + horizontalScrollbarHeight + "px";
      await component.getNextUpdatePromise();

      // Order parameters that differ from creation order; that collide; and that are not provided.
      const [beforeItems, beforeDecorations] = [30, 20, undefined, 20, 10, undefined]
        .map((order) => {
          return createBlockDecorationAtScreenRow(editor, 2, {
            height: 10,
            position: "before",
            order,
          });
        })
        .reduce(
          (lists, result) => {
            lists[0].push(result.item);
            lists[1].push(result.decoration);
            return lists;
          },
          [[], []],
        );

      const [afterItems] = [undefined, 1, 6, undefined, 6, 2]
        .map((order) => {
          return createBlockDecorationAtScreenRow(editor, 2, {
            height: 10,
            position: "after",
            order,
          });
        })
        .reduce(
          (lists, result) => {
            lists[0].push(result.item);
            lists[1].push(result.decoration);
            return lists;
          },
          [[], []],
        );

      await component.getNextUpdatePromise();

      expect(beforeItems[4].previousSibling).toBe(lineNodeForScreenRow(component, 1));
      expect(beforeItems[4].nextSibling).toBe(beforeItems[1]);
      expect(beforeItems[1].nextSibling).toBe(beforeItems[3]);
      expect(beforeItems[3].nextSibling).toBe(beforeItems[0]);
      expect(beforeItems[0].nextSibling).toBe(beforeItems[2]);
      expect(beforeItems[2].nextSibling).toBe(beforeItems[5]);
      expect(beforeItems[5].nextSibling).toBe(lineNodeForScreenRow(component, 2));
      expect(afterItems[1].previousSibling).toBe(lineNodeForScreenRow(component, 2));
      expect(afterItems[1].nextSibling).toBe(afterItems[5]);
      expect(afterItems[5].nextSibling).toBe(afterItems[2]);
      expect(afterItems[2].nextSibling).toBe(afterItems[4]);
      expect(afterItems[4].nextSibling).toBe(afterItems[0]);
      expect(afterItems[0].nextSibling).toBe(afterItems[3]);

      // Create a decoration somewhere else and move it to the same screen row as the existing decorations
      const { item: later, decoration } = createBlockDecorationAtScreenRow(editor, 4, {
        height: 20,
        position: "after",
        order: 3,
      });
      await component.getNextUpdatePromise();
      expect(later.previousSibling).toBe(lineNodeForScreenRow(component, 4));
      expect(later.nextSibling).toBe(lineNodeForScreenRow(component, 5));

      decoration.getMarker().setHeadScreenPosition([2, 0]);
      await component.getNextUpdatePromise();
      expect(later.previousSibling).toBe(afterItems[5]);
      expect(later.nextSibling).toBe(afterItems[2]);

      // Move a decoration away from its screen row and ensure the rest maintain their order
      beforeDecorations[3].getMarker().setHeadScreenPosition([5, 0]);
      await component.getNextUpdatePromise();
      expect(beforeItems[3].previousSibling).toBe(lineNodeForScreenRow(component, 4));
      expect(beforeItems[3].nextSibling).toBe(lineNodeForScreenRow(component, 5));

      expect(beforeItems[4].previousSibling).toBe(lineNodeForScreenRow(component, 1));
      expect(beforeItems[4].nextSibling).toBe(beforeItems[1]);
      expect(beforeItems[1].nextSibling).toBe(beforeItems[0]);
      expect(beforeItems[0].nextSibling).toBe(beforeItems[2]);
      expect(beforeItems[2].nextSibling).toBe(beforeItems[5]);
      expect(beforeItems[5].nextSibling).toBe(lineNodeForScreenRow(component, 2));
    });

    it("does not throw when a block decoration is destroyed during an update cycle", async () => {
      const editor = buildEditor({ autoHeight: false });
      const { component } = buildComponent({ editor, rowsPerTile: 3 });
      const { decoration, marker } = createBlockDecorationAtScreenRow(editor, 2, {
        height: 20,
        position: "after",
      });
      await component.getNextUpdatePromise();

      decoration.destroy();
      marker.destroy();
      expect(() => {
        component.updateSync();
      }).not.toThrow();
    });

    function createBlockDecorationAtScreenRow(
      editor,
      screenRow,
      { height, margin, marginTop, marginBottom, position, order, invalidate },
    ) {
      const marker = editor.markScreenPosition([screenRow, 0], {
        invalidate: invalidate || "never",
      });
      const item = document.createElement("div");
      item.style.height = height + "px";
      if (margin != null) item.style.margin = margin + "px";
      if (marginTop != null) item.style.marginTop = marginTop + "px";
      if (marginBottom != null) item.style.marginBottom = marginBottom + "px";
      item.style.width = 30 + "px";
      const decoration = editor.decorateMarker(marker, {
        type: "block",
        item,
        position,
        order,
      });
      return { item, decoration, marker };
    }

    function assertTilesAreSizedAndPositionedCorrectly(component, tiles) {
      let top = 0;
      for (let tile of tiles) {
        const linesTileElement = lineNodeForScreenRow(component, tile.tileStartRow).parentElement;
        const linesTileBoundingRect = linesTileElement.getBoundingClientRect();
        expect(linesTileBoundingRect.height).toBeNear(tile.height);
        expect(linesTileBoundingRect.top).toBeNear(top);

        const lineNumbersTileElement = lineNumberNodeForScreenRow(
          component,
          tile.tileStartRow,
        ).parentElement;
        const lineNumbersTileBoundingRect = lineNumbersTileElement.getBoundingClientRect();
        expect(lineNumbersTileBoundingRect.height).toBeNear(tile.height);
        expect(lineNumbersTileBoundingRect.top).toBeNear(top);

        top += tile.height;
      }
    }

    function assertLinesAreAlignedWithLineNumbers(component) {
      const startRow = component.getRenderedStartRow();
      const endRow = component.getRenderedEndRow();
      for (let row = startRow; row < endRow; row++) {
        const lineNode = lineNodeForScreenRow(component, row);
        const lineNumberNode = lineNumberNodeForScreenRow(component, row);
        expect(lineNumberNode.getBoundingClientRect().top).toBeNear(
          lineNode.getBoundingClientRect().top,
        );
      }
    }
  });

  describe("cursor decorations", () => {
    it("allows default cursors to be customized", async () => {
      const { component, element, editor } = buildComponent();

      editor.addCursorAtScreenPosition([1, 0]);
      const [cursorMarker1, cursorMarker2] = editor.getCursors().map((c) => c.getMarker());

      editor.decorateMarker(cursorMarker1, { type: "cursor", class: "a" });
      editor.decorateMarker(cursorMarker2, {
        type: "cursor",
        class: "b",
        style: { visibility: "hidden" },
      });
      editor.decorateMarker(cursorMarker2, {
        type: "cursor",
        style: { backgroundColor: "red" },
      });
      await component.getNextUpdatePromise();

      const cursorNodes = element.querySelectorAll(".cursor");
      expect(cursorNodes.length).toBe(2);

      expect(cursorNodes[0].className).toBe("cursor a");
      expect(cursorNodes[1].className).toBe("cursor b");
      expect(cursorNodes[1].style.visibility).toBe("hidden");
      expect(cursorNodes[1].style.backgroundColor).toBe("red");
    });

    it("allows markers that are not actually associated with cursors to be decorated as if they were cursors", async () => {
      const { component, element, editor } = buildComponent();
      const marker = editor.markScreenPosition([1, 0]);
      editor.decorateMarker(marker, { type: "cursor", class: "a" });
      await component.getNextUpdatePromise();

      const cursorNodes = element.querySelectorAll(".cursor");
      expect(cursorNodes.length).toBe(2);
      expect(cursorNodes[0].className).toBe("cursor");
      expect(cursorNodes[1].className).toBe("cursor a");
    });
  });

  describe("text decorations", () => {
    it("injects spans with custom class names and inline styles based on text decorations", async () => {
      const { component, element, editor } = buildComponent({ rowsPerTile: 2 });

      const markerLayer = editor.addMarkerLayer();
      const marker1 = markerLayer.markBufferRange([
        [0, 2],
        [2, 7],
      ]);
      const marker2 = markerLayer.markBufferRange([
        [0, 2],
        [3, 8],
      ]);
      const marker3 = markerLayer.markBufferRange([
        [1, 13],
        [2, 7],
      ]);
      editor.decorateMarker(marker1, {
        type: "text",
        class: "a",
        style: { color: "red" },
      });
      editor.decorateMarker(marker2, {
        type: "text",
        class: "b",
        style: { color: "blue" },
      });
      editor.decorateMarker(marker3, {
        type: "text",
        class: "c",
        style: { color: "green" },
      });
      await component.getNextUpdatePromise();

      expect(textContentOnRowMatchingSelector(component, 0, ".a")).toBe(
        editor.lineTextForScreenRow(0).slice(2),
      );
      expect(textContentOnRowMatchingSelector(component, 1, ".a")).toBe(
        editor.lineTextForScreenRow(1),
      );
      expect(textContentOnRowMatchingSelector(component, 2, ".a")).toBe(
        editor.lineTextForScreenRow(2).slice(0, 7),
      );
      expect(textContentOnRowMatchingSelector(component, 3, ".a")).toBe("");

      expect(textContentOnRowMatchingSelector(component, 0, ".b")).toBe(
        editor.lineTextForScreenRow(0).slice(2),
      );
      expect(textContentOnRowMatchingSelector(component, 1, ".b")).toBe(
        editor.lineTextForScreenRow(1),
      );
      expect(textContentOnRowMatchingSelector(component, 2, ".b")).toBe(
        editor.lineTextForScreenRow(2),
      );
      expect(textContentOnRowMatchingSelector(component, 3, ".b")).toBe(
        editor.lineTextForScreenRow(3).slice(0, 8),
      );

      expect(textContentOnRowMatchingSelector(component, 0, ".c")).toBe("");
      expect(textContentOnRowMatchingSelector(component, 1, ".c")).toBe(
        editor.lineTextForScreenRow(1).slice(13),
      );
      expect(textContentOnRowMatchingSelector(component, 2, ".c")).toBe(
        editor.lineTextForScreenRow(2).slice(0, 7),
      );
      expect(textContentOnRowMatchingSelector(component, 3, ".c")).toBe("");

      for (const span of element.querySelectorAll(".a:not(.c)")) {
        expect(span.style.color).toBe("red");
      }
      for (const span of element.querySelectorAll(".b:not(.c):not(.a)")) {
        expect(span.style.color).toBe("blue");
      }
      for (const span of element.querySelectorAll(".c")) {
        expect(span.style.color).toBe("green");
      }

      marker2.setHeadScreenPosition([3, 10]);
      await component.getNextUpdatePromise();
      expect(textContentOnRowMatchingSelector(component, 3, ".b")).toBe(
        editor.lineTextForScreenRow(3).slice(0, 10),
      );
    });

    it("correctly handles text decorations starting before the first rendered row and/or ending after the last rendered row", async () => {
      const { component, element, editor } = buildComponent({
        autoHeight: false,
        rowsPerTile: 1,
      });
      element.style.height = 4 * component.getLineHeight() + "px";
      await component.getNextUpdatePromise();
      // Fully past row 4: the fractional row position snaps to the nearest
      // physical pixel, and half a pixel short of it row 3 is rightly still
      // rendered.
      await setScrollTop(component, Math.ceil(4 * component.getLineHeight()));
      expect(component.getRenderedStartRow()).toBeNear(4);
      expect(component.getRenderedEndRow()).toBeNear(9);

      const markerLayer = editor.addMarkerLayer();
      const marker1 = markerLayer.markBufferRange([
        [0, 0],
        [4, 5],
      ]);
      const marker2 = markerLayer.markBufferRange([
        [7, 2],
        [10, 8],
      ]);
      editor.decorateMarker(marker1, { type: "text", class: "a" });
      editor.decorateMarker(marker2, { type: "text", class: "b" });
      await component.getNextUpdatePromise();

      expect(textContentOnRowMatchingSelector(component, 4, ".a")).toBe(
        editor.lineTextForScreenRow(4).slice(0, 5),
      );
      expect(textContentOnRowMatchingSelector(component, 5, ".a")).toBe("");
      expect(textContentOnRowMatchingSelector(component, 6, ".a")).toBe("");
      expect(textContentOnRowMatchingSelector(component, 7, ".a")).toBe("");
      expect(textContentOnRowMatchingSelector(component, 8, ".a")).toBe("");

      expect(textContentOnRowMatchingSelector(component, 4, ".b")).toBe("");
      expect(textContentOnRowMatchingSelector(component, 5, ".b")).toBe("");
      expect(textContentOnRowMatchingSelector(component, 6, ".b")).toBe("");
      expect(textContentOnRowMatchingSelector(component, 7, ".b")).toBe(
        editor.lineTextForScreenRow(7).slice(2),
      );
      expect(textContentOnRowMatchingSelector(component, 8, ".b")).toBe(
        editor.lineTextForScreenRow(8),
      );
    });

    it("does not create empty spans when a text decoration contains a row but another text decoration starts or ends at the beginning of it", async () => {
      const { component, element, editor } = buildComponent();
      const markerLayer = editor.addMarkerLayer();
      const marker1 = markerLayer.markBufferRange([
        [0, 2],
        [4, 0],
      ]);
      const marker2 = markerLayer.markBufferRange([
        [2, 0],
        [5, 8],
      ]);
      editor.decorateMarker(marker1, { type: "text", class: "a" });
      editor.decorateMarker(marker2, { type: "text", class: "b" });
      await component.getNextUpdatePromise();
      for (const decorationSpan of element.querySelectorAll(".a, .b")) {
        expect(decorationSpan.textContent).not.toBe("");
      }
    });

    it("does not create empty text nodes when a text decoration ends right after a text tag", async () => {
      const { component, editor } = buildComponent();
      const marker = editor.markBufferRange([
        [0, 8],
        [0, 29],
      ]);
      editor.decorateMarker(marker, { type: "text", class: "a" });
      await component.getNextUpdatePromise();
      for (const textNode of textNodesForScreenRow(component, 0)) {
        expect(textNode.textContent).not.toBe("");
      }
    });

    it("does not leak placeholder text nodes when text decorations change on an empty line", async () => {
      const { component, editor } = buildComponent({ text: "a\n\nb" });
      const markerLayer = editor.addMarkerLayer();
      editor.decorateMarkerLayer(markerLayer, { type: "text", class: "a" });

      // Toggle a layer-level text decoration across the empty line without
      // ever editing it, so the screen line id — and therefore the line
      // component — is reused (an async linter republishing diagnostics).
      for (let i = 0; i < 3; i++) {
        const marker = markerLayer.markBufferRange([
          [0, 0],
          [2, 1],
        ]);
        await component.getNextUpdatePromise();
        marker.destroy();
        await component.getNextUpdatePromise();
      }

      const lineNode = lineNodeForScreenRow(component, 1);
      expect(lineNode.textContent).toBe(" ");
      expect(lineNode.childNodes.length).toBe(2);
      expect(clientLeftForCharacter(component, 1, 0)).toBe(lineNode.getBoundingClientRect().left);
    });

    it("applies and clears CSS custom properties in text decoration styles", async () => {
      const { component, element, editor } = buildComponent();
      const markerLayer = editor.addMarkerLayer();
      const marker = markerLayer.markBufferRange([
        [0, 2],
        [0, 6],
      ]);
      const decoration = editor.decorateMarker(marker, {
        type: "text",
        class: "hint",
        style: { "--hint-text": '"label"', color: "red" },
      });
      await component.getNextUpdatePromise();
      let span = element.querySelector(".hint");
      expect(span.style.getPropertyValue("--hint-text")).toBe('"label"');
      expect(span.style.color).toBe("red");

      // The value must change on the reused span, and dropped plain
      // properties must clear.
      decoration.destroy();
      const replacement = editor.decorateMarker(marker, {
        type: "text",
        class: "hint",
        style: { "--hint-text": '"other"' },
      });
      await component.getNextUpdatePromise();
      span = element.querySelector(".hint");
      expect(span.style.getPropertyValue("--hint-text")).toBe('"other"');
      expect(span.style.color).toBe("");

      // A style-less decoration must not inherit the pooled span's
      // custom property.
      replacement.destroy();
      editor.decorateMarker(marker, { type: "text", class: "hint" });
      await component.getNextUpdatePromise();
      span = element.querySelector(".hint");
      expect(span.style.getPropertyValue("--hint-text")).toBe("");
    });

    it("re-measures horizontal pixel positions when text decorations change rendered widths", async () => {
      const { component, editor } = buildComponent();
      const before = component.pixelPositionForScreenPosition(Point(0, 6));
      const screenLineId = editor.screenLineForScreenRow(0).id;
      expect(component.horizontalPixelPositionsByScreenLineId.has(screenLineId)).toBe(true);

      // letter-spacing widens every glyph deterministically, independent of
      // font rasterization: 10px after each of the 6 decorated characters.
      const marker = editor.addMarkerLayer().markBufferRange([
        [0, 0],
        [0, 6],
      ]);
      editor.decorateMarker(marker, {
        type: "text",
        class: "wide",
        style: { letterSpacing: "10px" },
      });
      await component.getNextUpdatePromise();

      const after = component.pixelPositionForScreenPosition(Point(0, 6));
      expect(after.left).toBeCloseTo(before.left + 60, 0);
    });

    function textContentOnRowMatchingSelector(component, row, selector) {
      return Array.from(lineNodeForScreenRow(component, row).querySelectorAll(selector))
        .map((span) => span.textContent)
        .join("");
    }
  });

  describe("mouse input", () => {
    describe("on the lines", () => {
      describe("when there is only one cursor", () => {
        it("positions the cursor on single-click or when middle-clicking", async () => {
          lumine.config.set("editor.selectionClipboard", false);
          for (const button of [0, 1]) {
            const { component, editor } = buildComponent();
            const { lineHeight } = component.measurements;

            editor.setCursorScreenPosition([Infinity, Infinity], {
              autoscroll: false,
            });
            component.didMouseDownOnContent({
              detail: 1,
              button,
              clientX: clientLeftForCharacter(component, 0, 0) - 1,
              clientY: clientTopForLine(component, 0) - 1,
            });
            expect(editor.getCursorScreenPosition()).toEqual([0, 0]);

            const maxRow = editor.getLastScreenRow();
            editor.setCursorScreenPosition([Infinity, Infinity], {
              autoscroll: false,
            });
            component.didMouseDownOnContent({
              detail: 1,
              button,
              clientX:
                clientLeftForCharacter(component, maxRow, editor.lineLengthForScreenRow(maxRow)) +
                1,
              clientY: clientTopForLine(component, maxRow) + 1,
            });
            expect(editor.getCursorScreenPosition()).toEqual([
              maxRow,
              editor.lineLengthForScreenRow(maxRow),
            ]);

            component.didMouseDownOnContent({
              detail: 1,
              button,
              clientX: clientLeftForCharacter(component, 0, editor.lineLengthForScreenRow(0)) + 1,
              clientY: clientTopForLine(component, 0) + lineHeight / 2,
            });
            expect(editor.getCursorScreenPosition()).toEqual([0, editor.lineLengthForScreenRow(0)]);

            component.didMouseDownOnContent({
              detail: 1,
              button,
              clientX:
                (clientLeftForCharacter(component, 3, 0) +
                  clientLeftForCharacter(component, 3, 1)) /
                2,
              clientY: clientTopForLine(component, 1) + lineHeight / 2,
            });
            expect(editor.getCursorScreenPosition()).toEqual([1, 0]);

            component.didMouseDownOnContent({
              detail: 1,
              button,
              clientX:
                (clientLeftForCharacter(component, 3, 14) +
                  clientLeftForCharacter(component, 3, 15)) /
                2,
              clientY: clientTopForLine(component, 3) + lineHeight / 2,
            });
            expect(editor.getCursorScreenPosition()).toEqual([3, 14]);

            component.didMouseDownOnContent({
              detail: 1,
              button,
              clientX:
                (clientLeftForCharacter(component, 3, 14) +
                  clientLeftForCharacter(component, 3, 15)) /
                  2 +
                1,
              clientY: clientTopForLine(component, 3) + lineHeight / 2,
            });
            expect(editor.getCursorScreenPosition()).toEqual([3, 15]);

            editor.getBuffer().setTextInRange(
              [
                [3, 14],
                [3, 15],
              ],
              "🐣",
            );
            await component.getNextUpdatePromise();

            component.didMouseDownOnContent({
              detail: 1,
              button,
              clientX:
                (clientLeftForCharacter(component, 3, 14) +
                  clientLeftForCharacter(component, 3, 16)) /
                2,
              clientY: clientTopForLine(component, 3) + lineHeight / 2,
            });
            expect(editor.getCursorScreenPosition()).toEqual([3, 14]);

            component.didMouseDownOnContent({
              detail: 1,
              button,
              clientX:
                (clientLeftForCharacter(component, 3, 14) +
                  clientLeftForCharacter(component, 3, 16)) /
                  2 +
                1,
              clientY: clientTopForLine(component, 3) + lineHeight / 2,
            });
            expect(editor.getCursorScreenPosition()).toEqual([3, 16]);

            expect(editor.testAutoscrollRequests).toEqual([]);
          }
        });
      });

      describe("when the input is for the primary mouse button", () => {
        it("selects words on double-click", () => {
          const { component, editor } = buildComponent();
          const { clientX, clientY } = clientPositionForCharacter(component, 1, 16);
          component.didMouseDownOnContent({
            detail: 1,
            button: 0,
            clientX,
            clientY,
          });
          component.didMouseDownOnContent({
            detail: 2,
            button: 0,
            clientX,
            clientY,
          });
          expect(editor.getSelectedScreenRange()).toEqual([
            [1, 13],
            [1, 21],
          ]);
          expect(editor.testAutoscrollRequests).toEqual([]);
        });

        it("selects lines on triple-click", () => {
          const { component, editor } = buildComponent();
          const { clientX, clientY } = clientPositionForCharacter(component, 1, 16);
          component.didMouseDownOnContent({
            detail: 1,
            button: 0,
            clientX,
            clientY,
          });
          component.didMouseDownOnContent({
            detail: 2,
            button: 0,
            clientX,
            clientY,
          });
          component.didMouseDownOnContent({
            detail: 3,
            button: 0,
            clientX,
            clientY,
          });
          expect(editor.getSelectedScreenRange()).toEqual([
            [1, 0],
            [2, 0],
          ]);
          expect(editor.testAutoscrollRequests).toEqual([]);
        });

        it("adds or removes cursors when holding cmd or ctrl when single-clicking", () => {
          lumine.config.set("editor.multiCursorOnClick", true);
          const { component, editor } = buildComponent({ platform: "darwin" });
          expect(editor.getCursorScreenPositions()).toEqual([[0, 0]]);

          // add cursor at 1, 16
          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 1, 16), {
              detail: 1,
              button: 0,
              metaKey: true,
            }),
          );
          expect(editor.getCursorScreenPositions()).toEqual([
            [0, 0],
            [1, 16],
          ]);

          // remove cursor at 0, 0
          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 0, 0), {
              detail: 1,
              button: 0,
              metaKey: true,
            }),
          );
          expect(editor.getCursorScreenPositions()).toEqual([[1, 16]]);

          // cmd-click cursor at 1, 16 but don't remove it because it's the last one
          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 1, 16), {
              detail: 1,
              button: 0,
              metaKey: true,
            }),
          );
          expect(editor.getCursorScreenPositions()).toEqual([[1, 16]]);

          // cmd-clicking within a selection destroys it
          editor.addSelectionForScreenRange(
            [
              [2, 10],
              [2, 15],
            ],
            {
              autoscroll: false,
            },
          );
          expect(editor.getSelectedScreenRanges()).toEqual([
            [
              [1, 16],
              [1, 16],
            ],
            [
              [2, 10],
              [2, 15],
            ],
          ]);
          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 2, 13), {
              detail: 1,
              button: 0,
              metaKey: true,
            }),
          );
          expect(editor.getSelectedScreenRanges()).toEqual([
            [
              [1, 16],
              [1, 16],
            ],
          ]);

          // ctrl-click does not add cursors on macOS, nor does it move the cursor
          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 1, 4), {
              detail: 1,
              button: 0,
              ctrlKey: true,
            }),
          );
          expect(editor.getSelectedScreenRanges()).toEqual([
            [
              [1, 16],
              [1, 16],
            ],
          ]);

          // ctrl-click adds cursors on platforms *other* than macOS
          component.props.platform = "win32";
          editor.setCursorScreenPosition([1, 4], { autoscroll: false });
          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 1, 16), {
              detail: 1,
              button: 0,
              ctrlKey: true,
            }),
          );
          expect(editor.getCursorScreenPositions()).toEqual([
            [1, 4],
            [1, 16],
          ]);

          expect(editor.testAutoscrollRequests).toEqual([]);
        });

        it("adds word selections when holding cmd or ctrl when double-clicking", () => {
          lumine.config.set("editor.multiCursorOnClick", true);
          const { component, editor } = buildComponent();
          editor.addCursorAtScreenPosition([1, 16], { autoscroll: false });
          expect(editor.getCursorScreenPositions()).toEqual([
            [0, 0],
            [1, 16],
          ]);

          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 1, 16), {
              detail: 1,
              button: 0,
              metaKey: true,
            }),
          );
          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 1, 16), {
              detail: 2,
              button: 0,
              metaKey: true,
            }),
          );
          expect(editor.getSelectedScreenRanges()).toEqual([
            [
              [0, 0],
              [0, 0],
            ],
            [
              [1, 13],
              [1, 21],
            ],
          ]);
          expect(editor.testAutoscrollRequests).toEqual([]);
        });

        it("adds line selections when holding cmd or ctrl when triple-clicking", () => {
          lumine.config.set("editor.multiCursorOnClick", true);
          const { component, editor } = buildComponent();
          editor.addCursorAtScreenPosition([1, 16], { autoscroll: false });
          expect(editor.getCursorScreenPositions()).toEqual([
            [0, 0],
            [1, 16],
          ]);

          const { clientX, clientY } = clientPositionForCharacter(component, 1, 16);
          component.didMouseDownOnContent({
            detail: 1,
            button: 0,
            metaKey: true,
            clientX,
            clientY,
          });
          component.didMouseDownOnContent({
            detail: 2,
            button: 0,
            metaKey: true,
            clientX,
            clientY,
          });
          component.didMouseDownOnContent({
            detail: 3,
            button: 0,
            metaKey: true,
            clientX,
            clientY,
          });

          expect(editor.getSelectedScreenRanges()).toEqual([
            [
              [0, 0],
              [0, 0],
            ],
            [
              [1, 0],
              [2, 0],
            ],
          ]);
          expect(editor.testAutoscrollRequests).toEqual([]);
        });

        it("does not add cursors when holding cmd or ctrl when single-clicking", () => {
          lumine.config.set("editor.multiCursorOnClick", false);
          const { component, editor } = buildComponent({ platform: "darwin" });
          expect(editor.getCursorScreenPositions()).toEqual([[0, 0]]);

          // moves cursor to 1, 16
          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 1, 16), {
              detail: 1,
              button: 0,
              metaKey: true,
            }),
          );
          expect(editor.getCursorScreenPositions()).toEqual([[1, 16]]);

          // ctrl-click does not add cursors on macOS, nor does it move the cursor
          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 1, 4), {
              detail: 1,
              button: 0,
              ctrlKey: true,
            }),
          );
          expect(editor.getSelectedScreenRanges()).toEqual([
            [
              [1, 16],
              [1, 16],
            ],
          ]);

          // ctrl-click does not add cursors on platforms *other* than macOS
          component.props.platform = "win32";
          editor.setCursorScreenPosition([1, 4], { autoscroll: false });
          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 1, 16), {
              detail: 1,
              button: 0,
              ctrlKey: true,
            }),
          );
          expect(editor.getCursorScreenPositions()).toEqual([[1, 16]]);

          expect(editor.testAutoscrollRequests).toEqual([]);
        });

        it("does not add word selections when holding cmd or ctrl when double-clicking", () => {
          lumine.config.set("editor.multiCursorOnClick", false);
          const { component, editor } = buildComponent();

          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 1, 16), {
              detail: 1,
              button: 0,
              metaKey: true,
            }),
          );
          component.didMouseDownOnContent(
            Object.assign(clientPositionForCharacter(component, 1, 16), {
              detail: 2,
              button: 0,
              metaKey: true,
            }),
          );
          expect(editor.getSelectedScreenRanges()).toEqual([
            [
              [1, 13],
              [1, 21],
            ],
          ]);
          expect(editor.testAutoscrollRequests).toEqual([]);
        });

        it("does not add line selections when holding cmd or ctrl when triple-clicking", () => {
          lumine.config.set("editor.multiCursorOnClick", false);
          const { component, editor } = buildComponent();

          const { clientX, clientY } = clientPositionForCharacter(component, 1, 16);
          component.didMouseDownOnContent({
            detail: 1,
            button: 0,
            metaKey: true,
            clientX,
            clientY,
          });
          component.didMouseDownOnContent({
            detail: 2,
            button: 0,
            metaKey: true,
            clientX,
            clientY,
          });
          component.didMouseDownOnContent({
            detail: 3,
            button: 0,
            metaKey: true,
            clientX,
            clientY,
          });

          expect(editor.getSelectedScreenRanges()).toEqual([
            [
              [1, 0],
              [2, 0],
            ],
          ]);
          expect(editor.testAutoscrollRequests).toEqual([]);
        });

        it("expands the last selection on shift-click", () => {
          const { component, editor } = buildComponent();

          editor.setCursorScreenPosition([2, 18], { autoscroll: false });
          component.didMouseDownOnContent(
            Object.assign(
              {
                detail: 1,
                button: 0,
                shiftKey: true,
              },
              clientPositionForCharacter(component, 1, 4),
            ),
          );
          expect(editor.getSelectedScreenRange()).toEqual([
            [1, 4],
            [2, 18],
          ]);

          component.didMouseDownOnContent(
            Object.assign(
              {
                detail: 1,
                button: 0,
                shiftKey: true,
              },
              clientPositionForCharacter(component, 4, 4),
            ),
          );
          expect(editor.getSelectedScreenRange()).toEqual([
            [2, 18],
            [4, 4],
          ]);

          // reorients word-wise selections to keep the word selected regardless of
          // where the subsequent shift-click occurs
          editor.setCursorScreenPosition([2, 18], { autoscroll: false });
          editor.getLastSelection().selectWord({ autoscroll: false });
          component.didMouseDownOnContent(
            Object.assign(
              {
                detail: 1,
                button: 0,
                shiftKey: true,
              },
              clientPositionForCharacter(component, 1, 4),
            ),
          );
          expect(editor.getSelectedScreenRange()).toEqual([
            [1, 2],
            [2, 20],
          ]);

          component.didMouseDownOnContent(
            Object.assign(
              {
                detail: 1,
                button: 0,
                shiftKey: true,
              },
              clientPositionForCharacter(component, 3, 11),
            ),
          );
          expect(editor.getSelectedScreenRange()).toEqual([
            [2, 14],
            [3, 13],
          ]);

          // reorients line-wise selections to keep the line selected regardless of
          // where the subsequent shift-click occurs
          editor.setCursorScreenPosition([2, 18], { autoscroll: false });
          editor.getLastSelection().selectLine(null, { autoscroll: false });
          component.didMouseDownOnContent(
            Object.assign(
              {
                detail: 1,
                button: 0,
                shiftKey: true,
              },
              clientPositionForCharacter(component, 1, 4),
            ),
          );
          expect(editor.getSelectedScreenRange()).toEqual([
            [1, 0],
            [3, 0],
          ]);

          component.didMouseDownOnContent(
            Object.assign(
              {
                detail: 1,
                button: 0,
                shiftKey: true,
              },
              clientPositionForCharacter(component, 3, 11),
            ),
          );
          expect(editor.getSelectedScreenRange()).toEqual([
            [2, 0],
            [4, 0],
          ]);

          expect(editor.testAutoscrollRequests).toEqual([]);
        });

        it("expands the last selection on drag", () => {
          lumine.config.set("editor.multiCursorOnClick", true);
          const { component, editor } = buildComponent({ updatedSynchronously: true });
          spyOn(component, "handleMouseDragUntilMouseUp");

          component.didMouseDownOnContent(
            Object.assign(
              {
                detail: 1,
                button: 0,
              },
              clientPositionForCharacter(component, 1, 4),
            ),
          );

          {
            const { didDrag, didStopDragging } =
              component.handleMouseDragUntilMouseUp.calls.argsFor(0)[0];
            didDrag(clientPositionForCharacter(component, 8, 8));
            expect(editor.getSelectedScreenRange()).toEqual([
              [1, 4],
              [8, 8],
            ]);
            didDrag(clientPositionForCharacter(component, 4, 8));
            expect(editor.getSelectedScreenRange()).toEqual([
              [1, 4],
              [4, 8],
            ]);
            didStopDragging();
            expect(editor.getSelectedScreenRange()).toEqual([
              [1, 4],
              [4, 8],
            ]);
          }

          // Click-drag a second selection... selections are not merged until the
          // drag stops.
          component.didMouseDownOnContent(
            Object.assign(
              {
                detail: 1,
                button: 0,
                metaKey: 1,
              },
              clientPositionForCharacter(component, 8, 8),
            ),
          );
          {
            const { didDrag, didStopDragging } =
              component.handleMouseDragUntilMouseUp.calls.argsFor(1)[0];
            didDrag(clientPositionForCharacter(component, 2, 8));
            expect(editor.getSelectedScreenRanges()).toEqual([
              [
                [1, 4],
                [4, 8],
              ],
              [
                [2, 8],
                [8, 8],
              ],
            ]);
            expect(clientLeftForCharacter(component, 6, 8)).not.toEqual(
              clientLeftForCharacter(component, 6, 0),
            );
            didDrag(clientPositionForCharacter(component, 6, 8));
            expect(editor.getSelectedScreenRanges()).toEqual([
              [
                [1, 4],
                [4, 8],
              ],
              [
                [6, 8],
                [8, 8],
              ],
            ]);
            didDrag(clientPositionForCharacter(component, 2, 8));
            expect(editor.getSelectedScreenRanges()).toEqual([
              [
                [1, 4],
                [4, 8],
              ],
              [
                [2, 8],
                [8, 8],
              ],
            ]);
            didStopDragging();
            expect(editor.getSelectedScreenRanges()).toEqual([
              [
                [1, 4],
                [8, 8],
              ],
            ]);
          }
        });

        it("expands the selection word-wise on double-click-drag", () => {
          const { component, editor } = buildComponent();
          spyOn(component, "handleMouseDragUntilMouseUp");

          component.didMouseDownOnContent(
            Object.assign(
              {
                detail: 1,
                button: 0,
              },
              clientPositionForCharacter(component, 1, 4),
            ),
          );
          component.didMouseDownOnContent(
            Object.assign(
              {
                detail: 2,
                button: 0,
              },
              clientPositionForCharacter(component, 1, 4),
            ),
          );

          const { didDrag } = component.handleMouseDragUntilMouseUp.calls.argsFor(1)[0];
          didDrag(clientPositionForCharacter(component, 0, 8));
          expect(editor.getSelectedScreenRange()).toEqual([
            [0, 4],
            [1, 5],
          ]);
          didDrag(clientPositionForCharacter(component, 2, 10));
          expect(editor.getSelectedScreenRange()).toEqual([
            [1, 2],
            [2, 13],
          ]);
        });

        it("expands the selection line-wise on triple-click-drag", () => {
          const { component, editor } = buildComponent();
          spyOn(component, "handleMouseDragUntilMouseUp");

          const tripleClickPosition = clientPositionForCharacter(component, 2, 8);
          component.didMouseDownOnContent(
            Object.assign({ detail: 1, button: 0 }, tripleClickPosition),
          );
          component.didMouseDownOnContent(
            Object.assign({ detail: 2, button: 0 }, tripleClickPosition),
          );
          component.didMouseDownOnContent(
            Object.assign({ detail: 3, button: 0 }, tripleClickPosition),
          );

          const { didDrag } = component.handleMouseDragUntilMouseUp.calls.argsFor(2)[0];
          didDrag(clientPositionForCharacter(component, 1, 8));
          expect(editor.getSelectedScreenRange()).toEqual([
            [1, 0],
            [3, 0],
          ]);
          didDrag(clientPositionForCharacter(component, 4, 10));
          expect(editor.getSelectedScreenRange()).toEqual([
            [2, 0],
            [5, 0],
          ]);
        });

        it("destroys folds when clicking on their fold markers", async () => {
          const { component, element, editor } = buildComponent();
          editor.foldBufferRow(1);
          await component.getNextUpdatePromise();

          const target = element.querySelector(".fold-marker");
          const { clientX, clientY } = clientPositionForCharacter(
            component,
            1,
            editor.lineLengthForScreenRow(1),
          );
          component.didMouseDownOnContent({
            detail: 1,
            button: 0,
            target,
            clientX,
            clientY,
          });
          expect(editor.isFoldedAtBufferRow(1)).toBe(false);
          expect(editor.getCursorScreenPosition()).toEqual([0, 0]);
        });

        it("autoscrolls the content when dragging near the edge of the scroll container", async () => {
          const { component } = buildComponent({
            width: 200,
            height: 200,
          });
          spyOn(component, "handleMouseDragUntilMouseUp");

          let previousScrollTop = 0;
          let previousScrollLeft = 0;
          function assertScrolledDownAndRight() {
            expect(component.getScrollTop()).toBeGreaterThan(previousScrollTop);
            previousScrollTop = component.getScrollTop();
            expect(component.getScrollLeft()).toBeGreaterThan(previousScrollLeft);
            previousScrollLeft = component.getScrollLeft();
          }

          function assertScrolledUpAndLeft() {
            expect(component.getScrollTop()).toBeLessThan(previousScrollTop);
            previousScrollTop = component.getScrollTop();
            expect(component.getScrollLeft()).toBeLessThan(previousScrollLeft);
            previousScrollLeft = component.getScrollLeft();
          }

          component.didMouseDownOnContent({
            detail: 1,
            button: 0,
            clientX: 100,
            clientY: 100,
          });
          const { didDrag } = component.handleMouseDragUntilMouseUp.calls.argsFor(0)[0];

          didDrag({ clientX: 199, clientY: 199 });
          assertScrolledDownAndRight();
          didDrag({ clientX: 199, clientY: 199 });
          assertScrolledDownAndRight();
          didDrag({ clientX: 199, clientY: 199 });
          assertScrolledDownAndRight();
          didDrag({
            clientX: component.getGutterContainerWidth() + 1,
            clientY: 1,
          });
          assertScrolledUpAndLeft();
          didDrag({
            clientX: component.getGutterContainerWidth() + 1,
            clientY: 1,
          });
          assertScrolledUpAndLeft();
          didDrag({
            clientX: component.getGutterContainerWidth() + 1,
            clientY: 1,
          });
          assertScrolledUpAndLeft();

          // Don't artificially update scroll position beyond possible values
          expect(component.getScrollTop()).toBe(0);
          expect(component.getScrollLeft()).toBe(0);
          didDrag({
            clientX: component.getGutterContainerWidth() + 1,
            clientY: 1,
          });
          expect(component.getScrollTop()).toBe(0);
          expect(component.getScrollLeft()).toBe(0);

          const maxScrollTop = component.getMaxScrollTop();
          const maxScrollLeft = component.getMaxScrollLeft();
          setScrollTop(component, maxScrollTop);
          await setScrollLeft(component, maxScrollLeft);

          didDrag({ clientX: 199, clientY: 199 });
          didDrag({ clientX: 199, clientY: 199 });
          didDrag({ clientX: 199, clientY: 199 });
          expect(component.getScrollTop()).toBeNear(maxScrollTop);
          expect(component.getScrollLeft()).toBeNear(maxScrollLeft);
        });
      });

      it("pastes the previously selected text when clicking the middle mouse button on Linux", async () => {
        spyOn(electron.ipcRenderer, "send").and.callFake(function (eventName, selectedText) {
          if (eventName === "write-text-to-selection-clipboard") {
            clipboardBridge.writeText(selectedText, "selection");
          }
        });

        const { component, editor } = buildComponent({ platform: "linux" });

        // Middle mouse pasting.
        lumine.config.set("editor.selectionClipboard", true);
        editor.setSelectedBufferRange([
          [1, 6],
          [1, 10],
        ]);
        await conditionPromise(() => TextEditor.clipboard.read() === "sort");
        component.didMouseDownOnContent({
          button: 1,
          clientX: clientLeftForCharacter(component, 10, 0),
          clientY: clientTopForLine(component, 10),
        });
        expect(TextEditor.clipboard.read()).toBe("sort");
        expect(editor.lineTextForBufferRow(10)).toBe("sort");
        editor.undo();

        // Doesn't paste when middle mouse button is clicked
        lumine.config.set("editor.selectionClipboard", false);
        editor.setSelectedBufferRange([
          [1, 6],
          [1, 10],
        ]);
        component.didMouseDownOnContent({
          button: 1,
          clientX: clientLeftForCharacter(component, 10, 0),
          clientY: clientTopForLine(component, 10),
        });
        expect(TextEditor.clipboard.read()).toBe("sort");
        expect(editor.lineTextForBufferRow(10)).toBe("");

        // Ensure left clicks don't interfere.
        lumine.config.set("editor.selectionClipboard", true);
        editor.setSelectedBufferRange([
          [1, 2],
          [1, 5],
        ]);
        await conditionPromise(() => TextEditor.clipboard.read() === "var");
        component.didMouseDownOnContent({
          button: 0,
          detail: 1,
          clientX: clientLeftForCharacter(component, 10, 0),
          clientY: clientTopForLine(component, 10),
        });
        component.didMouseDownOnContent({
          button: 1,
          clientX: clientLeftForCharacter(component, 10, 0),
          clientY: clientTopForLine(component, 10),
        });
        expect(editor.lineTextForBufferRow(10)).toBe("var");
      });

      it("does not paste into a read only editor when clicking the middle mouse button on Linux", async () => {
        spyOn(electron.ipcRenderer, "send").and.callFake(function (eventName, selectedText) {
          if (eventName === "write-text-to-selection-clipboard") {
            clipboardBridge.writeText(selectedText, "selection");
          }
        });

        const { component, editor } = buildComponent({
          platform: "linux",
          readOnly: true,
        });

        // Select the word 'sort' on line 2 and copy to clipboard
        editor.setSelectedBufferRange([
          [1, 6],
          [1, 10],
        ]);
        await conditionPromise(() => TextEditor.clipboard.read() === "sort");

        // Middle-click in the buffer at line 11, column 1
        component.didMouseDownOnContent({
          button: 1,
          clientX: clientLeftForCharacter(component, 10, 0),
          clientY: clientTopForLine(component, 10),
        });

        // Ensure that the correct text was copied but not pasted
        expect(TextEditor.clipboard.read()).toBe("sort");
        expect(editor.lineTextForBufferRow(10)).toBe("");
      });
    });

    describe("on the line number gutter", () => {
      it("selects all buffer rows intersecting the clicked screen row when a line number is clicked", async () => {
        const { component, editor } = buildComponent();
        spyOn(component, "handleMouseDragUntilMouseUp");
        editor.setSoftWrapped(true);
        await component.getNextUpdatePromise();

        await setEditorWidthInCharacters(component, 50);
        editor.foldBufferRange([
          [4, Infinity],
          [7, Infinity],
        ]);
        await component.getNextUpdatePromise();

        // Selects entire buffer line when clicked screen line is soft-wrapped
        component.didMouseDownOnLineNumberGutter({
          button: 0,
          clientX: clientLeftForCharacter(component, 3, 0) - 15,
          clientY: clientTopForLine(component, 3),
        });
        expect(editor.getSelectedScreenRange()).toEqual([
          [3, 0],
          [5, 0],
        ]);
        expect(editor.getSelectedBufferRange()).toEqual([
          [3, 0],
          [4, 0],
        ]);

        // Selects entire screen line, even if folds cause that selection to
        // span multiple buffer lines
        component.didMouseDownOnLineNumberGutter({
          button: 0,
          clientX: clientLeftForCharacter(component, 5, 0) - 15,
          clientY: clientTopForLine(component, 5),
        });
        expect(editor.getSelectedScreenRange()).toEqual([
          [5, 0],
          [6, 0],
        ]);
        expect(editor.getSelectedBufferRange()).toEqual([
          [4, 0],
          [8, 0],
        ]);
      });

      it("adds new selections when a line number is meta-clicked", async () => {
        const { component, editor } = buildComponent();
        editor.setSoftWrapped(true);
        await component.getNextUpdatePromise();

        await setEditorWidthInCharacters(component, 50);
        editor.foldBufferRange([
          [4, Infinity],
          [7, Infinity],
        ]);
        await component.getNextUpdatePromise();

        // Selects entire buffer line when clicked screen line is soft-wrapped
        component.didMouseDownOnLineNumberGutter({
          button: 0,
          metaKey: true,
          clientX: clientLeftForCharacter(component, 3, 0) - 15,
          clientY: clientTopForLine(component, 3),
        });
        expect(editor.getSelectedScreenRanges()).toEqual([
          [
            [0, 0],
            [0, 0],
          ],
          [
            [3, 0],
            [5, 0],
          ],
        ]);
        expect(editor.getSelectedBufferRanges()).toEqual([
          [
            [0, 0],
            [0, 0],
          ],
          [
            [3, 0],
            [4, 0],
          ],
        ]);

        // Selects entire screen line, even if folds cause that selection to
        // span multiple buffer lines
        component.didMouseDownOnLineNumberGutter({
          button: 0,
          metaKey: true,
          clientX: clientLeftForCharacter(component, 3, 0) - 15,
          clientY: clientTopForLine(component, 5),
        });
        expect(editor.getSelectedScreenRanges()).toEqual([
          [
            [0, 0],
            [0, 0],
          ],
          [
            [3, 0],
            [5, 0],
          ],
          [
            [5, 0],
            [6, 0],
          ],
        ]);
        expect(editor.getSelectedBufferRanges()).toEqual([
          [
            [0, 0],
            [0, 0],
          ],
          [
            [3, 0],
            [4, 0],
          ],
          [
            [4, 0],
            [8, 0],
          ],
        ]);
      });

      it("expands the last selection when a line number is shift-clicked", async () => {
        const { component, editor } = buildComponent();
        spyOn(component, "handleMouseDragUntilMouseUp");
        editor.setSoftWrapped(true);
        await component.getNextUpdatePromise();

        await setEditorWidthInCharacters(component, 50);
        editor.foldBufferRange([
          [4, Infinity],
          [7, Infinity],
        ]);
        await component.getNextUpdatePromise();

        editor.setSelectedScreenRange([
          [3, 4],
          [3, 8],
        ]);
        editor.addCursorAtScreenPosition([2, 10]);
        component.didMouseDownOnLineNumberGutter({
          button: 0,
          shiftKey: true,
          clientX: clientLeftForCharacter(component, 3, 0) - 15,
          clientY: clientTopForLine(component, 5),
        });

        expect(editor.getSelectedBufferRanges()).toEqual([
          [
            [3, 4],
            [3, 8],
          ],
          [
            [2, 10],
            [8, 0],
          ],
        ]);

        // Original selection is preserved when shift-click-dragging
        const { didDrag, didStopDragging } =
          component.handleMouseDragUntilMouseUp.calls.argsFor(0)[0];
        didDrag({
          clientX: clientLeftForCharacter(component, 1, 0) - 15,
          clientY: clientTopForLine(component, 1),
        });
        expect(editor.getSelectedBufferRanges()).toEqual([
          [
            [3, 4],
            [3, 8],
          ],
          [
            [1, 0],
            [2, 10],
          ],
        ]);

        didDrag({
          clientX: clientLeftForCharacter(component, 5, 0) - 15,
          clientY: clientTopForLine(component, 5),
        });

        didStopDragging();
        expect(editor.getSelectedBufferRanges()).toEqual([
          [
            [2, 10],
            [8, 0],
          ],
        ]);
      });

      it("expands the selection when dragging", async () => {
        const { component, editor } = buildComponent();
        spyOn(component, "handleMouseDragUntilMouseUp");
        editor.setSoftWrapped(true);
        await component.getNextUpdatePromise();

        await setEditorWidthInCharacters(component, 50);
        editor.foldBufferRange([
          [4, Infinity],
          [7, Infinity],
        ]);
        await component.getNextUpdatePromise();

        editor.setSelectedScreenRange([
          [3, 4],
          [3, 6],
        ]);

        component.didMouseDownOnLineNumberGutter({
          button: 0,
          metaKey: true,
          clientX: clientLeftForCharacter(component, 2, 0) - 15,
          clientY: clientTopForLine(component, 2),
        });

        const { didDrag, didStopDragging } =
          component.handleMouseDragUntilMouseUp.calls.argsFor(0)[0];

        didDrag({
          clientX: clientLeftForCharacter(component, 1, 0) - 15,
          clientY: clientTopForLine(component, 1),
        });
        expect(editor.getSelectedScreenRanges()).toEqual([
          [
            [3, 4],
            [3, 6],
          ],
          [
            [1, 0],
            [3, 0],
          ],
        ]);

        didDrag({
          clientX: clientLeftForCharacter(component, 5, 0) - 15,
          clientY: clientTopForLine(component, 5),
        });
        expect(editor.getSelectedScreenRanges()).toEqual([
          [
            [3, 4],
            [3, 6],
          ],
          [
            [2, 0],
            [6, 0],
          ],
        ]);
        expect(editor.isFoldedAtBufferRow(4)).toBe(true);

        didDrag({
          clientX: clientLeftForCharacter(component, 3, 0) - 15,
          clientY: clientTopForLine(component, 3),
        });
        expect(editor.getSelectedScreenRanges()).toEqual([
          [
            [3, 4],
            [3, 6],
          ],
          [
            [2, 0],
            [4, 4],
          ],
        ]);

        didStopDragging();
        expect(editor.getSelectedScreenRanges()).toEqual([
          [
            [2, 0],
            [4, 4],
          ],
        ]);
      });

      it("toggles folding when clicking on the right icon of a foldable line number", async () => {
        const { component, element, editor } = buildComponent();
        let target = element.querySelectorAll(".line-number")[1].querySelector(".icon-right");
        expect(editor.isFoldedAtScreenRow(1)).toBe(false);

        component.didMouseDownOnLineNumberGutter({
          target,
          button: 0,
          clientX: clientLeftForCharacter(component, 1, 0) - 15,
          clientY: clientTopForLine(component, 1),
        });
        expect(editor.isFoldedAtScreenRow(1)).toBe(true);
        await component.getNextUpdatePromise();

        component.didMouseDownOnLineNumberGutter({
          target,
          button: 0,
          clientX: clientLeftForCharacter(component, 1, 0) - 15,
          clientY: clientTopForLine(component, 1),
        });
        await component.getNextUpdatePromise();
        expect(editor.isFoldedAtScreenRow(1)).toBe(false);

        editor.foldBufferRange([
          [5, 12],
          [5, 17],
        ]);
        await component.getNextUpdatePromise();
        expect(editor.isFoldedAtScreenRow(5)).toBe(true);

        target = element.querySelectorAll(".line-number")[4].querySelector(".icon-right");
        component.didMouseDownOnLineNumberGutter({
          target,
          button: 0,
          clientX: clientLeftForCharacter(component, 4, 0) - 15,
          clientY: clientTopForLine(component, 4),
        });
        expect(editor.isFoldedAtScreenRow(4)).toBe(false);
      });

      it("autoscrolls when dragging near the top or bottom of the gutter", async () => {
        const { component } = buildComponent({
          width: 200,
          height: 200,
        });
        spyOn(component, "handleMouseDragUntilMouseUp");

        let previousScrollTop = 0;
        let previousScrollLeft = 0;
        function assertScrolledDown() {
          expect(component.getScrollTop()).toBeGreaterThan(previousScrollTop);
          previousScrollTop = component.getScrollTop();
          expect(component.getScrollLeft()).toBe(previousScrollLeft);
          previousScrollLeft = component.getScrollLeft();
        }

        function assertScrolledUp() {
          expect(component.getScrollTop()).toBeLessThan(previousScrollTop);
          previousScrollTop = component.getScrollTop();
          expect(component.getScrollLeft()).toBe(previousScrollLeft);
          previousScrollLeft = component.getScrollLeft();
        }

        component.didMouseDownOnLineNumberGutter({
          detail: 1,
          button: 0,
          clientX: 0,
          clientY: 100,
        });
        const { didDrag } = component.handleMouseDragUntilMouseUp.calls.argsFor(0)[0];
        didDrag({ clientX: 199, clientY: 199 });
        assertScrolledDown();
        didDrag({ clientX: 199, clientY: 199 });
        assertScrolledDown();
        didDrag({ clientX: 199, clientY: 199 });
        assertScrolledDown();
        didDrag({
          clientX: component.getGutterContainerWidth() + 1,
          clientY: 1,
        });
        assertScrolledUp();
        didDrag({
          clientX: component.getGutterContainerWidth() + 1,
          clientY: 1,
        });
        assertScrolledUp();
        didDrag({
          clientX: component.getGutterContainerWidth() + 1,
          clientY: 1,
        });
        assertScrolledUp();

        // Don't artificially update scroll measurements beyond the minimum or
        // maximum possible scroll positions
        expect(component.getScrollTop()).toBe(0);
        expect(component.getScrollLeft()).toBe(0);
        didDrag({
          clientX: component.getGutterContainerWidth() + 1,
          clientY: 1,
        });
        expect(component.getScrollTop()).toBe(0);
        expect(component.getScrollLeft()).toBe(0);

        const maxScrollTop = component.getMaxScrollTop();
        const maxScrollLeft = component.getMaxScrollLeft();
        setScrollTop(component, maxScrollTop);
        await setScrollLeft(component, maxScrollLeft);

        didDrag({ clientX: 199, clientY: 199 });
        didDrag({ clientX: 199, clientY: 199 });
        didDrag({ clientX: 199, clientY: 199 });
        expect(component.getScrollTop()).toBeNear(maxScrollTop);
        expect(component.getScrollLeft()).toBeNear(maxScrollLeft);
      });
    });

    describe("on the scrollbars", () => {
      it("delegates the mousedown events to the parent component unless the mousedown was on the actual scrollbar", async () => {
        const { component, editor } = buildComponent({ height: 100 });
        await setEditorWidthInCharacters(component, 6);

        const verticalScrollbar = component.refs.verticalScrollbar;
        const horizontalScrollbar = component.refs.horizontalScrollbar;
        const leftEdgeOfVerticalScrollbar =
          verticalScrollbar.element.getBoundingClientRect().right - verticalScrollbarWidth;
        const topEdgeOfHorizontalScrollbar =
          horizontalScrollbar.element.getBoundingClientRect().bottom - horizontalScrollbarHeight;

        verticalScrollbar.didMouseDown({
          button: 0,
          detail: 1,
          clientY: clientTopForLine(component, 4),
          clientX: leftEdgeOfVerticalScrollbar,
        });
        expect(editor.getCursorScreenPosition()).toEqual([0, 0]);

        verticalScrollbar.didMouseDown({
          button: 0,
          detail: 1,
          clientY: clientTopForLine(component, 4),
          clientX: leftEdgeOfVerticalScrollbar - 1,
        });
        expect(editor.getCursorScreenPosition()).toEqual([4, 6]);

        horizontalScrollbar.didMouseDown({
          button: 0,
          detail: 1,
          clientY: topEdgeOfHorizontalScrollbar,
          clientX: component.refs.content.getBoundingClientRect().left,
        });
        expect(editor.getCursorScreenPosition()).toEqual([4, 6]);

        horizontalScrollbar.didMouseDown({
          button: 0,
          detail: 1,
          clientY: topEdgeOfHorizontalScrollbar - 1,
          clientX: component.refs.content.getBoundingClientRect().left,
        });
        expect(editor.getCursorScreenPosition()).toEqual([4, 0]);
      });
    });
  });

  describe("clipboard events", () => {
    it("writes linewise copy metadata to the current VS Code clipboard format", () => {
      const { component, editor } = buildComponent({ text: "first\nsecond" });
      editor.setCursorBufferPosition([0, 2]);
      const clipboardData = createClipboardData();
      const event = { clipboardData, preventDefault: jasmine.createSpy("preventDefault") };

      component.didCopy(event);

      expect(clipboardData.getData("text/plain").replace(/\r\n/g, "\n")).toBe("first\n");
      expect(
        JSON.parse(clipboardData.getData("application/vnd.code.copymetadata")).defaultPastePayload
          .pasteOnNewLine,
      ).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it("pastes a linewise copy from another renderer at the start of the line", () => {
      const clipboardData = createClipboardData();
      TextEditor.clipboard
        .createDataTransferClipboard(clipboardData)
        .write("first\n", { indentBasis: 0, fullLine: true });
      TextEditor.clipboard.reset();

      const { component, editor } = buildComponent({ text: "target" });
      editor.setCursorBufferPosition([0, 3]);
      const event = { clipboardData, preventDefault: jasmine.createSpy("preventDefault") };

      // A real Ctrl+V aborts the key binding and records a pending native
      // paste operation before the browser fires the paste event. Without it,
      // Linux suppresses the event (middle-click protection), so simulate it
      // here to exercise the same cross-platform path the keystroke uses.
      component.pendingNativePasteOperation = { options: {} };
      component.didPaste(event);

      expect(editor.getText().replace(/\r\n/g, "\n")).toBe("first\ntarget");
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it("offers clipboard event data to paste providers before inserting text", () => {
      const { component, editor } = buildComponent({ text: "target" });
      const clipboardData = createClipboardData({ "text/plain": "replacement" });
      const provider = {
        handlePaste: jasmine.createSpy("handlePaste").and.callFake((context) => {
          expect(context.target).toEqual({ type: "text-editor", editor });
          expect(context.clipboardData).toBe(clipboardData);
          expect(context.clipboard.readWithMetadata()).toEqual({ text: "replacement" });
          return true;
        }),
      };
      const registration = TextEditor.pasteProviderRegistry.add(provider);
      const event = { clipboardData, preventDefault: jasmine.createSpy("preventDefault") };

      // Simulate the pending operation a real Ctrl+V establishes so the paste
      // event is honored on Linux as well (see the linewise paste spec above).
      component.pendingNativePasteOperation = { options: {} };
      component.didPaste(event);

      expect(provider.handlePaste).toHaveBeenCalled();
      expect(editor.getText()).toBe("target");
      expect(event.preventDefault).toHaveBeenCalled();
      registration.dispose();
    });

    it("bypasses paste providers when pasting without reformatting", () => {
      const { component, editor } = buildComponent({ text: "target" });
      editor.setCursorBufferPosition([0, 0]);
      const clipboardData = createClipboardData({ "text/plain": "one\ttwo" });
      const provider = {
        handlePaste: jasmine.createSpy("handlePaste").and.returnValue(true),
      };
      const registration = TextEditor.pasteProviderRegistry.add(provider);
      const event = { clipboardData, preventDefault: jasmine.createSpy("preventDefault") };

      component.pendingNativePasteOperation = {
        options: {
          normalizeLineEndings: false,
          autoIndent: false,
          preserveTrailingLineIndentation: true,
          skipPasteProviders: true,
        },
      };
      component.didPaste(event);

      expect(provider.handlePaste).not.toHaveBeenCalled();
      expect(editor.getText()).toBe("one\ttwotarget");
      expect(event.preventDefault).toHaveBeenCalled();
      registration.dispose();
    });

    it("keeps this window's copy metadata when Chromium strips the custom formats", () => {
      // Ctrl+Shift+V natively means "paste and match style", so Chromium
      // delivers the paste event with only text/plain. Multi-selection
      // metadata from the window's own copy must still distribute one copied
      // selection per cursor.
      const { component, editor } = buildComponent({ text: "alpha beta\ngamma delta" });
      editor.setSelectedBufferRanges([
        [
          [0, 0],
          [0, 5],
        ],
        [
          [1, 0],
          [1, 5],
        ],
      ]);
      const copyData = createClipboardData();
      component.didCopy({ clipboardData: copyData, preventDefault: () => {} });

      editor.setSelectedBufferRanges([
        [
          [0, 10],
          [0, 10],
        ],
        [
          [1, 11],
          [1, 11],
        ],
      ]);
      const strippedData = createClipboardData({
        "text/plain": copyData.getData("text/plain"),
      });
      const event = {
        clipboardData: strippedData,
        preventDefault: jasmine.createSpy("preventDefault"),
      };
      component.pendingNativePasteOperation = {
        options: {
          normalizeLineEndings: false,
          autoIndent: false,
          preserveTrailingLineIndentation: true,
          skipPasteProviders: true,
        },
      };
      component.didPaste(event);

      expect(editor.getText()).toBe("alpha betaalpha\ngamma deltagamma");
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it("prevents the browser's default processing for the event on Linux", () => {
      const { component } = buildComponent({ platform: "linux" });
      const event = { preventDefault: () => {} };
      spyOn(event, "preventDefault");

      component.didPaste(event);
      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe("keyboard input", () => {
    it("handles inserted accented characters via the press-and-hold menu on macOS correctly", () => {
      const { editor, component } = buildComponent({
        text: "",
        chromeVersion: 57,
      });
      editor.insertText("x");
      editor.setCursorBufferPosition([0, 1]);

      // Simulate holding the A key to open the press-and-hold menu,
      // then closing it via ESC.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeydown({ code: "KeyA" });
      component.didKeydown({ code: "KeyA" });
      component.didKeyup({ code: "KeyA" });
      component.didKeydown({ code: "Escape" });
      component.didKeyup({ code: "Escape" });
      expect(editor.getText()).toBe("xa");
      // Ensure another "a" can be typed correctly.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeyup({ code: "KeyA" });
      expect(editor.getText()).toBe("xaa");
      editor.undo();
      expect(editor.getText()).toBe("x");

      // Simulate holding the A key to open the press-and-hold menu,
      // then selecting an alternative by typing a number.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeydown({ code: "KeyA" });
      component.didKeydown({ code: "KeyA" });
      component.didKeyup({ code: "KeyA" });
      component.didKeydown({ code: "Digit2" });
      component.didKeyup({ code: "Digit2" });
      component.didTextInput({
        data: "á",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      expect(editor.getText()).toBe("xá");
      // Ensure another "a" can be typed correctly.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeyup({ code: "KeyA" });
      expect(editor.getText()).toBe("xáa");
      editor.undo();
      expect(editor.getText()).toBe("x");

      // Simulate holding the A key to open the press-and-hold menu,
      // then selecting an alternative by clicking on it.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeydown({ code: "KeyA" });
      component.didKeydown({ code: "KeyA" });
      component.didKeyup({ code: "KeyA" });
      component.didTextInput({
        data: "á",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      expect(editor.getText()).toBe("xá");
      // Ensure another "a" can be typed correctly.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeyup({ code: "KeyA" });
      expect(editor.getText()).toBe("xáa");
      editor.undo();
      expect(editor.getText()).toBe("x");

      // Simulate holding the A key to open the press-and-hold menu,
      // cycling through the alternatives with the arrows, then selecting one of them with Enter.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeydown({ code: "KeyA" });
      component.didKeydown({ code: "KeyA" });
      component.didKeyup({ code: "KeyA" });
      component.didKeydown({ code: "ArrowRight" });
      component.didCompositionStart({ data: "" });
      component.didCompositionUpdate({ data: "à" });
      component.didKeyup({ code: "ArrowRight" });
      expect(editor.getText()).toBe("xà");
      component.didKeydown({ code: "ArrowRight" });
      component.didCompositionUpdate({ data: "á" });
      component.didKeyup({ code: "ArrowRight" });
      expect(editor.getText()).toBe("xá");
      component.didKeydown({ code: "Enter" });
      component.didCompositionUpdate({ data: "á" });
      component.didTextInput({
        data: "á",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didCompositionEnd({
        data: "á",
        target: component.refs.cursorsAndInput.refs.hiddenInput,
      });
      component.didKeyup({ code: "Enter" });
      expect(editor.getText()).toBe("xá");
      // Ensure another "a" can be typed correctly.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeyup({ code: "KeyA" });
      expect(editor.getText()).toBe("xáa");
      editor.undo();
      expect(editor.getText()).toBe("x");

      // Simulate holding the A key to open the press-and-hold menu,
      // cycling through the alternatives with the arrows, then closing it via ESC.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeydown({ code: "KeyA" });
      component.didKeydown({ code: "KeyA" });
      component.didKeyup({ code: "KeyA" });
      component.didKeydown({ code: "ArrowRight" });
      component.didCompositionStart({ data: "" });
      component.didCompositionUpdate({ data: "à" });
      component.didKeyup({ code: "ArrowRight" });
      expect(editor.getText()).toBe("xà");
      component.didKeydown({ code: "ArrowRight" });
      component.didCompositionUpdate({ data: "á" });
      component.didKeyup({ code: "ArrowRight" });
      expect(editor.getText()).toBe("xá");
      component.didKeydown({ code: "Escape" });
      component.didCompositionUpdate({ data: "a" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didCompositionEnd({
        data: "a",
        target: component.refs.cursorsAndInput.refs.hiddenInput,
      });
      component.didKeyup({ code: "Escape" });
      expect(editor.getText()).toBe("xa");
      // Ensure another "a" can be typed correctly.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeyup({ code: "KeyA" });
      expect(editor.getText()).toBe("xaa");
      editor.undo();
      expect(editor.getText()).toBe("x");

      // Simulate pressing the O key and holding the A key to open the press-and-hold menu right before releasing the O key,
      // cycling through the alternatives with the arrows, then closing it via ESC.
      component.didKeydown({ code: "KeyO" });
      component.didKeypress({ code: "KeyO" });
      component.didTextInput({
        data: "o",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeyup({ code: "KeyO" });
      component.didKeydown({ code: "KeyA" });
      component.didKeydown({ code: "KeyA" });
      component.didKeydown({ code: "ArrowRight" });
      component.didCompositionStart({ data: "" });
      component.didCompositionUpdate({ data: "à" });
      component.didKeyup({ code: "ArrowRight" });
      expect(editor.getText()).toBe("xoà");
      component.didKeydown({ code: "ArrowRight" });
      component.didCompositionUpdate({ data: "á" });
      component.didKeyup({ code: "ArrowRight" });
      expect(editor.getText()).toBe("xoá");
      component.didKeydown({ code: "Escape" });
      component.didCompositionUpdate({ data: "a" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didCompositionEnd({
        data: "a",
        target: component.refs.cursorsAndInput.refs.hiddenInput,
      });
      component.didKeyup({ code: "Escape" });
      expect(editor.getText()).toBe("xoa");
      // Ensure another "a" can be typed correctly.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeyup({ code: "KeyA" });
      editor.undo();
      expect(editor.getText()).toBe("x");

      // Simulate holding the A key to open the press-and-hold menu,
      // cycling through the alternatives with the arrows, then closing it by changing focus.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeydown({ code: "KeyA" });
      component.didKeydown({ code: "KeyA" });
      component.didKeyup({ code: "KeyA" });
      component.didKeydown({ code: "ArrowRight" });
      component.didCompositionStart({ data: "" });
      component.didCompositionUpdate({ data: "à" });
      component.didKeyup({ code: "ArrowRight" });
      expect(editor.getText()).toBe("xà");
      component.didKeydown({ code: "ArrowRight" });
      component.didCompositionUpdate({ data: "á" });
      component.didKeyup({ code: "ArrowRight" });
      expect(editor.getText()).toBe("xá");
      component.didCompositionUpdate({ data: "á" });
      component.didTextInput({
        data: "á",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didCompositionEnd({
        data: "á",
        target: component.refs.cursorsAndInput.refs.hiddenInput,
      });
      expect(editor.getText()).toBe("xá");
      // Ensure another "a" can be typed correctly.
      component.didKeydown({ code: "KeyA" });
      component.didKeypress({ code: "KeyA" });
      component.didTextInput({
        data: "a",
        stopPropagation: () => {},
        preventDefault: () => {},
      });
      component.didKeyup({ code: "KeyA" });
      expect(editor.getText()).toBe("xáa");
      editor.undo();
      expect(editor.getText()).toBe("x");
    });
  });

  describe("styling changes", () => {
    // The double/half/Korean width preconditions need a CJK-capable font;
    // the Linux CI job installs fonts-noto-cjk for this spec.
    it("updates the rendered content based on new measurements when the font dimensions change", async () => {
      const { component, element, editor } = buildComponent({
        rowsPerTile: 1,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 3);
      editor.setCursorScreenPosition([1, 29], { autoscroll: false });
      await component.getNextUpdatePromise();

      let cursorNode = element.querySelector(".cursor");
      const initialBaseCharacterWidth = editor.getDefaultCharWidth();
      const initialDoubleCharacterWidth = editor.getDoubleWidthCharWidth();
      const initialHalfCharacterWidth = editor.getHalfWidthCharWidth();
      const initialKoreanCharacterWidth = editor.getKoreanCharWidth();
      const initialRenderedLineCount = queryOnScreenLineElements(element).length;
      const initialFontSize = parseInt(getComputedStyle(element).fontSize);

      expect(initialKoreanCharacterWidth).toBeDefined();
      expect(initialDoubleCharacterWidth).toBeDefined();
      expect(initialHalfCharacterWidth).toBeDefined();
      expect(initialBaseCharacterWidth).toBeDefined();
      expect(initialDoubleCharacterWidth).not.toBe(initialBaseCharacterWidth);
      expect(initialHalfCharacterWidth).not.toBe(initialBaseCharacterWidth);
      expect(initialKoreanCharacterWidth).not.toBe(initialBaseCharacterWidth);
      verifyCursorPosition(component, cursorNode, 1, 29);

      element.style.fontSize = initialFontSize - 5 + "px";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      expect(editor.getDefaultCharWidth()).toBeLessThan(initialBaseCharacterWidth);
      expect(editor.getDoubleWidthCharWidth()).toBeLessThan(initialDoubleCharacterWidth);
      expect(editor.getHalfWidthCharWidth()).toBeLessThan(initialHalfCharacterWidth);
      expect(editor.getKoreanCharWidth()).toBeLessThan(initialKoreanCharacterWidth);
      expect(queryOnScreenLineElements(element).length).toBeGreaterThan(initialRenderedLineCount);
      verifyCursorPosition(component, cursorNode, 1, 29);

      element.style.fontSize = initialFontSize + 10 + "px";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      expect(editor.getDefaultCharWidth()).toBeGreaterThan(initialBaseCharacterWidth);
      expect(editor.getDoubleWidthCharWidth()).toBeGreaterThan(initialDoubleCharacterWidth);
      expect(editor.getHalfWidthCharWidth()).toBeGreaterThan(initialHalfCharacterWidth);
      expect(editor.getKoreanCharWidth()).toBeGreaterThan(initialKoreanCharacterWidth);
      expect(queryOnScreenLineElements(element).length).toBeLessThan(initialRenderedLineCount);
      verifyCursorPosition(component, cursorNode, 1, 29);
    });

    it("maintains the scrollTopRow and scrollLeftColumn when the font size changes", async () => {
      const { component, element } = buildComponent({
        rowsPerTile: 1,
        autoHeight: false,
      });
      // Set the initial line height to match that of the editor font size.
      element.style.lineHeight = Math.ceil(parseFloat(getComputedStyle(element).fontSize)) + "px";
      component.measureCharacterDimensions();
      await setEditorHeightInLines(component, 3);
      await setEditorWidthInCharacters(component, 20);
      component.setScrollTopRow(4);
      component.setScrollLeftColumn(10);
      await component.getNextUpdatePromise();

      const initialFontSize = parseInt(getComputedStyle(element).fontSize);
      element.style.fontSize = initialFontSize - 5 + "px";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      expect(component.getScrollTopRow()).toBe(4);

      element.style.fontSize = initialFontSize + 5 + "px";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
      expect(component.getScrollTopRow()).toBe(4);
    });

    it("keeps the viewport midpoint stable across a soft-wrap reflow when the cursor is not visible", async () => {
      const { component } = buildComponent({
        softWrapped: true,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 10);
      await setEditorWidthInCharacters(component, 40);

      // Scroll into the middle of the document, leaving the cursor at the top
      // of the buffer and outside the viewport.
      await setScrollTop(component, Math.round(component.getMaxScrollTop() / 2));
      expect(component.props.model.getCursorScreenPosition().row).toBeLessThan(
        component.getFirstVisibleRow(),
      );

      // Distance from the viewport top to the top of the row at the midpoint.
      const midPixel = component.getScrollTop() + component.getScrollContainerClientHeight() / 2;
      const midScreenRow = component.rowForPixelPosition(midPixel);
      const midBufferPosition = component.props.model.bufferPositionForScreenPosition([
        midScreenRow,
        0,
      ]);
      const offsetBefore =
        component.pixelPositionBeforeBlocksForRow(midScreenRow) - component.getScrollTop();

      // Narrow the editor to force a soft-wrap reflow.
      await setEditorWidthInCharacters(component, 20);

      const newScreenRow =
        component.props.model.screenPositionForBufferPosition(midBufferPosition).row;
      const offsetAfter =
        component.pixelPositionBeforeBlocksForRow(newScreenRow) - component.getScrollTop();
      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(component.getLineHeight());
    });

    it("keeps a visible cursor stable across a soft-wrap reflow after a manual scroll", async () => {
      const { component, editor } = buildComponent({
        text: ("x".repeat(70) + "\n").repeat(30),
        softWrapped: true,
        autoHeight: false,
        smoothScrolling: false,
      });
      await setEditorHeightInLines(component, 10);
      await setEditorWidthInCharacters(component, 40);

      editor.setCursorBufferPosition([10, 0], { autoscroll: false });
      await component.getNextUpdatePromise();
      const cursorRow = editor.getCursorScreenPosition().row;
      await setScrollTop(
        component,
        component.pixelPositionBeforeBlocksForRow(cursorRow) - 2 * component.getLineHeight(),
      );

      // Manually scroll one row while leaving the cursor visible. Cursor
      // visibility, not this last action, determines the reflow anchor.
      expect(component.applyWheelScroll(0, component.getLineHeight())).toBe(true);
      expect(cursorRow).toBeGreaterThanOrEqual(component.getFirstVisibleRow());
      expect(cursorRow).toBeLessThanOrEqual(component.getLastVisibleRow());
      const offsetBefore =
        component.pixelPositionBeforeBlocksForRow(editor.getCursorScreenPosition().row) -
        component.getScrollTop();

      await setEditorWidthInCharacters(component, 20);

      const offsetAfter =
        component.pixelPositionBeforeBlocksForRow(editor.getCursorScreenPosition().row) -
        component.getScrollTop();
      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(component.getLineHeight());
    });

    it("keeps an unfocused editor stable when another editor on the same buffer edits above its viewport", async () => {
      const editor = buildEditor({ autoHeight: false });
      const { component } = buildComponent({ editor: editor.copy(), autoHeight: false });
      await setEditorHeightInLines(component, 6);
      await setEditorWidthInCharacters(component, 40);

      await setScrollTop(component, Math.round(component.getMaxScrollTop() / 2));

      const scrollTopBefore = component.getScrollTop();
      const lineHeight = component.getLineHeight();

      // Insert three lines at the very top of the shared buffer.
      editor.getBuffer().insert([0, 0], "one\ntwo\nthree\n");
      await component.getNextUpdatePromise();

      expect(component.getScrollTop()).toBeNear(scrollTopBefore + 3 * lineHeight);
    });

    it("keeps the last line stable across a soft-wrap reflow when scrolled past the end", async () => {
      const { component, editor } = buildComponent({
        softWrapped: true,
        autoHeight: false,
      });
      editor.update({ scrollPastEnd: true });
      await setEditorHeightInLines(component, 10);
      await setEditorWidthInCharacters(component, 40);

      // Scroll to the very bottom so the last line sits in the top half of the
      // viewport (more than half a screen past the end).
      await setScrollTop(component, component.getMaxScrollTop());

      const lastRow = editor.getLastScreenRow();
      const offsetBefore =
        component.pixelPositionBeforeBlocksForRow(lastRow) - component.getScrollTop();

      await setEditorWidthInCharacters(component, 20);

      const newLastRow = editor.getLastScreenRow();
      const offsetAfter =
        component.pixelPositionBeforeBlocksForRow(newLastRow) - component.getScrollTop();
      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(component.getLineHeight());
    });

    it("re-wraps immediately when the width changes outside a drag, even when softWrapDebounceInterval is set", async () => {
      jasmine.useRealClock();
      const { component, editor } = buildComponent({
        softWrapped: true,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 10);
      await setEditorWidthInCharacters(component, 40);

      editor.update({ softWrapDebounceInterval: 250 });
      const widthBefore = editor.getEditorWidthInChars();

      // A one-shot layout change — a dock toggle, a pane split, a package
      // resizing the client container — is already the final width, so the
      // interval never applies to it.
      await setEditorWidthInCharacters(component, 30);
      expect(editor.getEditorWidthInChars()).toBeLessThan(widthBefore);
      expect(component.softWrapDebounceTimer).toBeNull();
    });

    it("defers the soft-wrap reflow for the duration of a pane or dock resize drag", async () => {
      jasmine.useRealClock();
      const { component, editor } = buildComponent({
        softWrapped: true,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 10);
      await setEditorWidthInCharacters(component, 40);

      // Enable debouncing only after the initial layout has settled, so the
      // baseline width reflects the 40-character width.
      editor.update({ softWrapDebounceInterval: 250 });
      const widthBefore = editor.getEditorWidthInChars();

      // Stands for the resize handle running the gesture.
      const divider = beginLayoutDrag();
      try {
        // Every change while the button is held is abandoned by the next frame,
        // so none of them re-wraps.
        await setEditorWidthInCharacters(component, 30);
        expect(editor.getEditorWidthInChars()).toBe(widthBefore);
        await setEditorWidthInCharacters(component, 20);
        expect(editor.getEditorWidthInChars()).toBe(widthBefore);
        expect(component.softWrapDebounceTimer).not.toBeNull();
      } finally {
        divider.dispose();
      }

      // Releasing the divider flushes synchronously rather than waiting out the
      // rest of the interval.
      expect(component.softWrapDebounceTimer).toBeNull();
      expect(editor.getEditorWidthInChars()).toBeLessThan(widthBefore);
    });

    it("re-wraps mid-drag once the width has held still for the debounce interval", async () => {
      jasmine.useRealClock();
      const { component, editor } = buildComponent({
        softWrapped: true,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 10);
      await setEditorWidthInCharacters(component, 40);

      editor.update({ softWrapDebounceInterval: 50 });
      const widthBefore = editor.getEditorWidthInChars();

      const divider = beginLayoutDrag();
      try {
        await setEditorWidthInCharacters(component, 20);
        expect(editor.getEditorWidthInChars()).toBe(widthBefore);

        // Pausing the drag without releasing it still settles: the width has
        // stopped moving, so there is nothing left to coalesce.
        await conditionPromise(() => editor.getEditorWidthInChars() !== widthBefore);
        expect(editor.getEditorWidthInChars()).toBeLessThan(widthBefore);
      } finally {
        divider.dispose();
      }
    });

    it("wraps a copied editor at its new pane's width immediately when softWrapDebounceInterval is set", async () => {
      const { component, editor } = buildComponent({
        softWrapped: true,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 10);
      await setEditorWidthInCharacters(component, 40);
      const sourceWidth = editor.getEditorWidthInChars();

      // Copy the editor into a narrower pane, as splitting a pane with
      // copyActiveItem does.
      const copy = editor.copy();
      editors.push(copy);
      const copyElement = copy.getElement();
      const copyComponent = copy.component;
      copy.update({ softWrapDebounceInterval: 50 });
      copyElement.style.height = component.getLineHeight() * 10 + "px";
      copyElement.style.width =
        component.getGutterContainerWidth() +
        25 * component.measurements.baseCharacterWidth +
        verticalScrollbarWidth +
        "px";
      jasmine.attachToDOM(copyElement);

      // The copy must wrap at the narrower width on its first paint instead
      // of waiting out the debounce interval.
      expect(copyComponent.softWrapDebounceTimer).toBeNull();
      expect(copy.getEditorWidthInChars()).toBeLessThan(sourceWidth);
    });

    it("applies the initial soft-wrap synchronously even when softWrapDebounceInterval is set", () => {
      const { component, editor, element } = buildComponent({
        softWrapped: true,
        autoHeight: false,
        attach: false,
      });
      editor.update({ softWrapDebounceInterval: 50 });
      jasmine.attachToDOM(element);

      // Opening a file must wrap at the real width on the first paint; the
      // debounce only coalesces width changes while the editor stays visible.
      expect(component.softWrapDebounceTimer).toBeNull();
      expect(editor.getEditorWidthInChars()).toBe(
        component.getScrollContainerClientWidthInBaseCharacters(),
      );
    });

    it("re-wraps synchronously when the editor returns from the background with a new width", async () => {
      jasmine.useRealClock();
      const { component, editor, element } = buildComponent({
        softWrapped: true,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 10);
      await setEditorWidthInCharacters(component, 40);
      editor.update({ softWrapDebounceInterval: 50 });
      const widthBefore = editor.getEditorWidthInChars();

      // Hide the editor (background pane item) and narrow it while hidden.
      element.style.display = "none";
      component.didHide();
      element.style.width =
        component.getGutterContainerWidth() +
        20 * component.measurements.baseCharacterWidth +
        verticalScrollbarWidth +
        "px";

      // On reveal, the ResizeObserver measures the new size before the
      // IntersectionObserver delivers didShow; the reflow must land on the
      // reveal paint instead of waiting out the debounce interval.
      element.style.display = "";
      component.didResize();
      component.didShow();

      expect(component.softWrapDebounceTimer).toBeNull();
      expect(editor.getEditorWidthInChars()).toBeLessThan(widthBefore);
    });

    it("re-wraps synchronously when a moved editor re-attaches in a differently sized pane", async () => {
      const { component, editor, element } = buildComponent({
        softWrapped: true,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 10);
      await setEditorWidthInCharacters(component, 40);
      editor.update({ softWrapDebounceInterval: 50 });
      const widthBefore = editor.getEditorWidthInChars();

      // Dragging a tab into a split detaches the element and re-attaches it
      // in a pane with a different width.
      element.remove();
      element.style.width =
        component.getGutterContainerWidth() +
        20 * component.measurements.baseCharacterWidth +
        verticalScrollbarWidth +
        "px";
      jasmine.attachToDOM(element);

      // The re-attached editor must wrap at the new pane's width on its first
      // paint, before the ResizeObserver has even fired.
      expect(component.softWrapDebounceTimer).toBeNull();
      expect(editor.getEditorWidthInChars()).toBeLessThan(widthBefore);
    });

    it("preserves the visual scroll position when copied into a pane with a different width", async () => {
      const { component, editor } = buildComponent({
        softWrapped: true,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 10);
      await setEditorWidthInCharacters(component, 40);

      // Put the cursor mid-document and scroll it into view.
      editor.setCursorBufferPosition([12, 0]);
      await component.getNextUpdatePromise();
      const anchorBufferPosition = editor.getCursorBufferPosition();
      const offsetBefore =
        component.pixelPositionBeforeBlocksForRow(editor.getCursorScreenPosition().row) -
        component.getScrollTop();

      // Copy the editor and display it in a narrower pane (different soft wrap).
      const copy = editor.copy();
      editors.push(copy);
      const copyElement = copy.getElement();
      const copyComponent = copy.component;
      copyElement.style.height = component.getLineHeight() * 10 + "px";
      copyElement.style.width =
        component.getGutterContainerWidth() +
        25 * component.measurements.baseCharacterWidth +
        verticalScrollbarWidth +
        "px";
      jasmine.attachToDOM(copyElement);
      await conditionPromise(() => copyComponent.hasInitialMeasurements);

      // The anchored buffer position should keep the same offset from the top
      // of the viewport, even though the narrower width wraps lines differently.
      const copyScreenRow = copy.screenPositionForBufferPosition(anchorBufferPosition).row;
      const offsetAfter =
        copyComponent.pixelPositionBeforeBlocksForRow(copyScreenRow) - copyComponent.getScrollTop();
      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(2 * copyComponent.getLineHeight());
    });

    it("preserves the past-end scroll position when copied into a pane with a different width", async () => {
      const { component, editor } = buildComponent({
        softWrapped: true,
        autoHeight: false,
      });
      editor.update({ scrollPastEnd: true });
      await setEditorHeightInLines(component, 10);
      await setEditorWidthInCharacters(component, 40);

      // Put the cursor on the last line (so a copy doesn't autoscroll away from
      // it) and scroll into the past-end zone.
      editor.setCursorBufferPosition(editor.getEofBufferPosition());
      await setScrollTop(component, component.getMaxScrollTop());

      const lastRow = editor.getLastScreenRow();
      const anchorBufferPosition = editor.bufferPositionForScreenPosition([lastRow, 0]);
      const offsetBefore =
        component.pixelPositionBeforeBlocksForRow(lastRow) - component.getScrollTop();

      const copy = editor.copy();
      editors.push(copy);
      const copyElement = copy.getElement();
      const copyComponent = copy.component;
      copyElement.style.height = component.getLineHeight() * 10 + "px";
      copyElement.style.width =
        component.getGutterContainerWidth() +
        25 * component.measurements.baseCharacterWidth +
        verticalScrollbarWidth +
        "px";
      jasmine.attachToDOM(copyElement);
      await conditionPromise(() => copyComponent.hasInitialMeasurements);

      // The last line should keep the same offset from the viewport top, with
      // the past-end zone reproduced below it.
      const copyLastRow = copy.screenPositionForBufferPosition(anchorBufferPosition).row;
      const offsetAfter =
        copyComponent.pixelPositionBeforeBlocksForRow(copyLastRow) - copyComponent.getScrollTop();
      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(2 * copyComponent.getLineHeight());
    });

    it("gracefully handles the editor being hidden after a styling change", async () => {
      jasmine.useRealClock();
      // Seems to make this test less flaky.
      await wait(0);

      const { component, element } = buildComponent({
        autoHeight: false,
      });
      element.style.fontSize = parseInt(getComputedStyle(element).fontSize) + 5 + "px";
      TextEditor.didUpdateStyles();
      element.style.display = "none";
      await component.getNextUpdatePromise();
    });

    it("resolves getNextUpdatePromise when the component is hidden before a scheduled update flushes", async () => {
      const { component, element } = buildComponent({ autoHeight: false });

      element.style.width = "50px";
      component.scheduleUpdate(); // schedules an update while the component is visible
      // Actually hide the element: the width change also queues an
      // IntersectionObserver recomputation, and a still-intersecting element
      // would race a didShow() against the assertion below.
      element.style.display = "none";
      component.didHide(); // hidden before the scheduled update flushes

      // The bailed-out update must resolve the promise rather than leak it;
      // a component that is never shown again would otherwise hang callers
      // forever.
      await component.getNextUpdatePromise();
      expect(component.visible).toBe(false);

      // Showing the component again performs the deferred update normally.
      element.style.display = "";
      component.didShow();
      expect(component.visible).toBe(true);
    });

    it("does not throw an exception when the editor is soft-wrapped and changing the font size changes also the longest screen line", async () => {
      const { component, element, editor } = buildComponent({
        rowsPerTile: 3,
        autoHeight: false,
      });
      editor.setText(
        "Lorem ipsum dolor sit amet, consectetur adipisicing elit, sed do\n" +
          "eiusmod tempor incididunt ut labore et dolore magna" +
          "aliqua. Ut enim ad minim veniam, quis nostrud exercitation",
      );
      editor.setSoftWrapped(true);
      await setEditorHeightInLines(component, 2);
      await setEditorWidthInCharacters(component, 56);
      await setScrollTop(component, 3 * component.getLineHeight());

      element.style.fontSize = "20px";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();
    });

    it("updates the width of the lines div based on the longest screen line", async () => {
      const { component, element, editor } = buildComponent({
        rowsPerTile: 1,
        autoHeight: false,
      });
      editor.setText(
        "Lorem ipsum dolor sit\n" +
          "amet, consectetur adipisicing\n" +
          "elit, sed do\n" +
          "eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation",
      );
      await setEditorHeightInLines(component, 2);

      element.style.fontSize = "20px";
      TextEditor.didUpdateStyles();
      await component.getNextUpdatePromise();

      // Capture the width of the lines before requesting the width of
      // longest line, because making that request forces a DOM update
      const actualWidth = element.querySelector(".lines").style.width;
      const expectedWidth = Math.ceil(
        component.pixelPositionForScreenPosition(Point(3, Infinity)).left +
          component.getBaseCharacterWidth(),
      );
      expect(actualWidth).toBe(expectedWidth + "px");
    });
  });

  describe("synchronous updates", () => {
    let editorElementWasUpdatedSynchronously;

    beforeEach(() => {
      editorElementWasUpdatedSynchronously = TextEditorElement.prototype.updatedSynchronously;
    });

    afterEach(() => {
      TextEditorElement.prototype.setUpdatedSynchronously(editorElementWasUpdatedSynchronously);
    });

    it("updates synchronously when updatedSynchronously is true", () => {
      const editor = buildEditor();
      const { element } = new TextEditorComponent({
        model: editor,
        updatedSynchronously: true,
      });
      jasmine.attachToDOM(element);

      editor.setText("Lorem ipsum dolor");
      expect(queryOnScreenLineElements(element).map((l) => l.textContent)).toEqual([
        editor.lineTextForScreenRow(0),
      ]);
    });

    it("does not throw an exception on attachment when setting the soft-wrap column", () => {
      const { element, editor } = buildComponent({
        width: 435,
        attach: false,
        updatedSynchronously: true,
      });
      editor.setSoftWrapped(true);
      spyOn(window, "onerror").and.callThrough();
      jasmine.attachToDOM(element); // should not throw an exception
      expect(window.onerror).not.toHaveBeenCalled();
    });

    it("updates synchronously when creating a component via TextEditor and TextEditorElement.prototype.updatedSynchronously is true", () => {
      TextEditorElement.prototype.setUpdatedSynchronously(true);
      const editor = buildEditor();
      const element = editor.element;
      jasmine.attachToDOM(element);

      editor.setText("Lorem ipsum dolor");
      expect(queryOnScreenLineElements(element).map((l) => l.textContent)).toEqual([
        editor.lineTextForScreenRow(0),
      ]);
    });

    it("measures dimensions synchronously when measureDimensions is called on the component", () => {
      TextEditorElement.prototype.setUpdatedSynchronously(true);
      const editor = buildEditor({ autoHeight: false });
      const element = editor.element;
      jasmine.attachToDOM(element);

      element.style.height = "100px";
      expect(element.component.getClientContainerHeight()).not.toBe(100);
      element.component.measureDimensions();
      expect(element.component.getClientContainerHeight()).toBe(100);
    });
  });

  describe("pixelPositionForScreenPosition(point)", () => {
    it("returns the pixel position for the given point, regardless of whether or not it is currently on screen", async () => {
      const { component, editor } = buildComponent({
        rowsPerTile: 2,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 3);
      await setScrollTop(component, 3 * component.getLineHeight());

      const { component: referenceComponent } = buildComponent();
      const referenceContentRect = referenceComponent.refs.content.getBoundingClientRect();

      {
        const { top, left } = component.pixelPositionForScreenPosition({
          row: 0,
          column: 0,
        });
        expect(top).toBe(clientTopForLine(referenceComponent, 0) - referenceContentRect.top);
        expect(left).toBe(
          clientLeftForCharacter(referenceComponent, 0, 0) - referenceContentRect.left,
        );
      }

      {
        const { top, left } = component.pixelPositionForScreenPosition({
          row: 0,
          column: 5,
        });
        expect(top).toBe(clientTopForLine(referenceComponent, 0) - referenceContentRect.top);
        expect(left).toBeNear(
          clientLeftForCharacter(referenceComponent, 0, 5) - referenceContentRect.left,
        );
      }

      {
        const { top, left } = component.pixelPositionForScreenPosition({
          row: 12,
          column: 1,
        });
        expect(top).toBeNear(clientTopForLine(referenceComponent, 12) - referenceContentRect.top);
        expect(left).toBeNear(
          clientLeftForCharacter(referenceComponent, 12, 1) - referenceContentRect.left,
        );
      }

      // Measuring a currently rendered line while an autoscroll that causes
      // that line to go off-screen is in progress.
      {
        editor.setCursorScreenPosition([10, 0]);
        const { top, left } = component.pixelPositionForScreenPosition({
          row: 3,
          column: 5,
        });
        expect(top).toBeNear(clientTopForLine(referenceComponent, 3) - referenceContentRect.top);
        expect(left).toBeNear(
          clientLeftForCharacter(referenceComponent, 3, 5) - referenceContentRect.left,
        );
      }
    });

    it("does not get the component into an inconsistent state when the model has unflushed changes (regression)", async () => {
      const { component, editor } = buildComponent({
        rowsPerTile: 2,
        autoHeight: false,
        text: "",
      });
      await setEditorHeightInLines(component, 10);

      const updatePromise = editor.getBuffer().append("hi\n");
      component.screenPositionForPixelPosition({ top: 800, left: 1 });
      await updatePromise;
    });

    it("does not shift cursors downward or render off-screen content when measuring off-screen lines (regression)", async () => {
      const { component, element } = buildComponent({
        rowsPerTile: 2,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 3);
      component.pixelPositionForScreenPosition({
        row: 12,
        column: 1,
      });

      expect(element.querySelector(".cursor").getBoundingClientRect().top).toBe(
        component.refs.lineTiles.getBoundingClientRect().top,
      );
      expect(element.querySelector('.line[data-screen-row="12"]').style.visibility).toBe("hidden");

      // Ensure previously measured off screen lines don't have any weird
      // styling when they come on screen in the next frame
      await setEditorHeightInLines(component, 13);
      const previouslyMeasuredLineElement = element.querySelector('.line[data-screen-row="12"]');
      expect(previouslyMeasuredLineElement.style.display).toBe("");
      expect(previouslyMeasuredLineElement.style.visibility).toBe("");
    });

    it("does not throw when called with a row far beyond the rendered range", async () => {
      const { component } = buildComponent({
        rowsPerTile: 2,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 3);

      const outOfRangeRow = component.getRenderedEndRow() + 1000;
      expect(() => {
        component.pixelPositionForScreenPosition({ row: outOfRangeRow, column: 0 });
      }).not.toThrow();
    });

    it("does not throw when requestHorizontalMeasurement targets a non-rendered row", async () => {
      const { component } = buildComponent({
        rowsPerTile: 2,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 3);

      const outOfRangeRow = component.getRenderedEndRow() + 1000;
      component.requestHorizontalMeasurement(outOfRangeRow, 0);
      expect(() => {
        component.measureHorizontalPositions();
      }).not.toThrow();
    });
  });

  describe("screenPositionForPixelPosition", () => {
    it("returns the screen position for the given pixel position, regardless of whether or not it is currently on screen", async () => {
      const { component, editor } = buildComponent({
        rowsPerTile: 2,
        autoHeight: false,
      });
      await setEditorHeightInLines(component, 3);
      await setScrollTop(component, 3 * component.getLineHeight());
      const { component: referenceComponent } = buildComponent();

      {
        const pixelPosition = referenceComponent.pixelPositionForScreenPosition({
          row: 0,
          column: 0,
        });
        pixelPosition.top += component.getLineHeight() / 3;
        pixelPosition.left += component.getBaseCharacterWidth() / 3;
        expect(component.screenPositionForPixelPosition(pixelPosition)).toEqual([0, 0]);
      }

      {
        const pixelPosition = referenceComponent.pixelPositionForScreenPosition({
          row: 0,
          column: 5,
        });
        pixelPosition.top += component.getLineHeight() / 3;
        pixelPosition.left += component.getBaseCharacterWidth() / 3;
        expect(component.screenPositionForPixelPosition(pixelPosition)).toEqual([0, 5]);
      }

      {
        const pixelPosition = referenceComponent.pixelPositionForScreenPosition({
          row: 5,
          column: 7,
        });
        pixelPosition.top += component.getLineHeight() / 3;
        pixelPosition.left += component.getBaseCharacterWidth() / 3;
        expect(component.screenPositionForPixelPosition(pixelPosition)).toEqual([5, 7]);
      }

      {
        const pixelPosition = referenceComponent.pixelPositionForScreenPosition({
          row: 12,
          column: 1,
        });
        pixelPosition.top += component.getLineHeight() / 3;
        pixelPosition.left += component.getBaseCharacterWidth() / 3;
        expect(component.screenPositionForPixelPosition(pixelPosition)).toEqual([12, 1]);
      }

      // Measuring a currently rendered line while an autoscroll that causes
      // that line to go off-screen is in progress.
      {
        const pixelPosition = referenceComponent.pixelPositionForScreenPosition({
          row: 3,
          column: 4,
        });
        pixelPosition.top += component.getLineHeight() / 3;
        pixelPosition.left += component.getBaseCharacterWidth() / 3;
        editor.setCursorBufferPosition([10, 0]);
        expect(component.screenPositionForPixelPosition(pixelPosition)).toEqual([3, 4]);
      }
    });

    it("counts characters rather than character widths across a decoration that renders width of its own", async () => {
      // A text decoration can draw a label through a pseudo-element, which is
      // how an inlay hint renders: horizontal space inside the line that
      // belongs to no column at all. Columns past it are no longer where a
      // character count would put them, and the label itself covers pixels
      // that no character occupies. Packages that convert a pointer to a
      // column lean on both answers below.
      const style = document.createElement("style");
      style.textContent = '.spec-label::before { content: "LLLLLLLL"; }';
      document.head.appendChild(style);

      try {
        const { component, editor } = buildComponent({ text: "0123456789\n" });
        editor.decorateMarker(
          editor.markScreenRange([
            [0, 5],
            [0, 6],
          ]),
          { type: "text", class: "spec-label" },
        );
        await component.getNextUpdatePromise();

        const charWidth = component.getBaseCharacterWidth();
        const top = component.getLineHeight() / 2;
        const labelStart =
          component.pixelPositionForScreenPosition({ row: 0, column: 4 }).left + charWidth;
        const labelEnd = component.pixelPositionForScreenPosition({ row: 0, column: 5 }).left;
        expect(labelEnd - labelStart).toBeGreaterThan(charWidth);

        // Every point on the label names the column it decorates, both of its
        // edges being the same boundary in column space.
        expect(
          component.screenPositionForPixelPosition({ top, left: (labelStart + labelEnd) / 2 }),
        ).toEqual([0, 5]);
        expect(component.screenPositionForPixelPosition({ top, left: labelStart + 1 })).toEqual([
          0, 5,
        ]);

        // And a column drawn past the label is still its own column, where
        // dividing by the character width would have named a later one.
        const seventh = component.pixelPositionForScreenPosition({ row: 0, column: 7 }).left;
        expect(seventh).toBeGreaterThan(8 * charWidth);
        expect(
          component.screenPositionForPixelPosition({ top, left: seventh + charWidth / 2 }),
        ).toEqual([0, 7]);

        // Past the end of the line there is nothing left to measure against,
        // so the position clamps: extending a rectangle out here is the
        // caller's job.
        const end = component.pixelPositionForScreenPosition({ row: 0, column: 10 }).left;
        expect(
          component.screenPositionForPixelPosition({ top, left: end + 20 * charWidth }),
        ).toEqual([0, 10]);
      } finally {
        style.remove();
      }
    });

    it("returns a position rather than throwing when bidi layout defies the RTL fragment pattern", async () => {
      // Both probed rows are scrolled out of view, forcing the second-strategy
      // drill-down, and both render a single text node as more than one
      // DOMRect. Row 0 starts with an RTL run at index 0. Row 1 reorders plain
      // ASCII with a bidi override the RTL character pattern cannot see at
      // all, which is the shape a binary file misdecoded as text takes.
      const text =
        "\u05e9\u05dc\u05d5\u05dd abcdef\n\u202eabcdef\u202c ghijk\n" + "filler\n".repeat(8);
      const { component } = buildComponent({ text, rowsPerTile: 2, autoHeight: false });
      await setEditorHeightInLines(component, 3);
      await setScrollTop(component, 5 * component.getLineHeight());
      const { component: referenceComponent, editor: referenceEditor } = buildComponent({ text });

      const charWidth = component.getBaseCharacterWidth();
      for (let row = 0; row <= 1; row++) {
        const lineLength = referenceEditor.lineLengthForScreenRow(row);
        const top =
          referenceComponent.pixelPositionForScreenPosition({ row, column: 0 }).top +
          component.getLineHeight() / 3;
        const lineEnd = referenceComponent.pixelPositionForScreenPosition({
          row,
          column: lineLength,
        }).left;
        for (let left = 0; left <= lineEnd; left += charWidth / 2) {
          const position = component.screenPositionForPixelPosition({ top, left });
          expect(position.row).toBe(row);
          expect(position.column).toBeGreaterThanOrEqual(0);
          expect(position.column).toBeLessThanOrEqual(lineLength);
        }
      }
    });
  });

  describe("model methods that delegate to the component / element", () => {
    it("delegates getFirstVisibleScreenRow, getLastVisibleScreenRow, and getVisibleRowRange to the component", async () => {
      const { component, element, editor } = buildComponent({
        rowsPerTile: 3,
        autoHeight: false,
      });
      element.style.height = 4 * component.measurements.lineHeight + "px";
      await component.getNextUpdatePromise();
      await setScrollTop(component, 5 * component.getLineHeight());

      expect(editor.getFirstVisibleScreenRow()).toBe(component.getFirstVisibleRow());
      expect(editor.getLastVisibleScreenRow()).toBe(component.getLastVisibleRow());
      expect(editor.getVisibleRowRange()).toEqual([
        component.getFirstVisibleRow(),
        component.getLastVisibleRow(),
      ]);
    });

    it("assigns scrollTop on the component when calling setFirstVisibleScreenRow", async () => {
      const { component, element, editor } = buildComponent({
        rowsPerTile: 3,
        autoHeight: false,
      });
      element.style.lineHeight = "20px";
      component.measureCharacterDimensions();
      element.style.height =
        4 * component.measurements.lineHeight + horizontalScrollbarHeight + "px";
      await component.getNextUpdatePromise();

      expect(component.getMaxScrollTop() / component.getLineHeight()).toBeNear(9);
      expect(component.refs.verticalScrollbar.element.scrollTop).toBe(
        0 * component.getLineHeight(),
      );

      editor.setFirstVisibleScreenRow(1);
      expect(component.getFirstVisibleRow()).toBe(1);
      await component.getNextUpdatePromise();
      expect(component.refs.verticalScrollbar.element.scrollTop).toBeNear(
        1 * component.getLineHeight(),
      );

      editor.setFirstVisibleScreenRow(5);
      expect(component.getFirstVisibleRow()).toBe(5);
      await component.getNextUpdatePromise();
      expect(component.refs.verticalScrollbar.element.scrollTop).toBeNear(
        5 * component.getLineHeight(),
      );

      editor.setFirstVisibleScreenRow(11);
      expect(component.getFirstVisibleRow()).toBe(9);
      await component.getNextUpdatePromise();
      expect(component.refs.verticalScrollbar.element.scrollTop).toBeNear(
        9 * component.getLineHeight(),
      );
    });

    it("delegates setFirstVisibleScreenColumn and getFirstVisibleScreenColumn to the component", async () => {
      const { component, element, editor } = buildComponent({
        rowsPerTile: 3,
        autoHeight: false,
      });
      element.style.width = 30 * component.getBaseCharacterWidth() + "px";
      await component.getNextUpdatePromise();
      expect(editor.getFirstVisibleScreenColumn()).toBe(0);
      expect(component.refs.horizontalScrollbar.element.scrollLeft).toBe(0);

      setScrollLeft(component, 5.5 * component.getBaseCharacterWidth());
      expect(editor.getFirstVisibleScreenColumn()).toBe(5);
      await component.getNextUpdatePromise();
      expect(component.refs.horizontalScrollbar.element.scrollLeft).toBeCloseTo(
        5.5 * component.getBaseCharacterWidth(),
        -1,
      );

      editor.setFirstVisibleScreenColumn(12);
      expect(component.getScrollLeft()).toBeCloseTo(12 * component.getBaseCharacterWidth(), -1);
      await component.getNextUpdatePromise();
      expect(component.refs.horizontalScrollbar.element.scrollLeft).toBeCloseTo(
        12 * component.getBaseCharacterWidth(),
        -1,
      );
    });
  });

  describe("handleMouseDragUntilMouseUp", () => {
    it("does not process drag frames while the editor has no visible layout", async () => {
      const { component, element } = buildComponent();
      spyOn(console, "error");
      const didDrag = jasmine
        .createSpy("didDrag")
        .and.callFake((event) => component.screenPositionForMouseEvent(event));
      component.handleMouseDragUntilMouseUp({
        didDrag,
        didStopDragging: () => {},
      });

      element.style.display = "none";
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 0, clientY: 0 }));
      await getNextAnimationFramePromise();

      expect(didDrag).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
      window.dispatchEvent(new MouseEvent("mouseup"));
    });

    it("repeatedly schedules `didDrag` calls on new animation frames after moving the mouse, and calls `didStopDragging` on mouseup", async () => {
      const { component } = buildComponent();

      let dragEvents;
      let dragging = false;
      component.handleMouseDragUntilMouseUp({
        didDrag: (event) => {
          dragging = true;
          dragEvents.push(event);
        },
        didStopDragging: () => {
          dragging = false;
        },
      });
      expect(dragging).toBe(false);

      dragEvents = [];
      const moveEvent1 = new MouseEvent("mousemove");
      window.dispatchEvent(moveEvent1);
      expect(dragging).toBe(false);
      await getNextAnimationFramePromise();
      expect(dragging).toBe(true);
      expect(dragEvents).toEqual([moveEvent1]);
      await getNextAnimationFramePromise();
      expect(dragging).toBe(true);
      expect(dragEvents).toEqual([moveEvent1, moveEvent1]);

      dragEvents = [];
      const moveEvent2 = new MouseEvent("mousemove");
      window.dispatchEvent(moveEvent2);
      expect(dragging).toBe(true);
      expect(dragEvents).toEqual([]);
      await getNextAnimationFramePromise();
      expect(dragging).toBe(true);
      expect(dragEvents).toEqual([moveEvent2]);
      await getNextAnimationFramePromise();
      expect(dragging).toBe(true);
      expect(dragEvents).toEqual([moveEvent2, moveEvent2]);

      dragEvents = [];
      window.dispatchEvent(new MouseEvent("mouseup"));
      expect(dragging).toBe(false);
      expect(dragEvents).toEqual([]);
      window.dispatchEvent(new MouseEvent("mousemove"));
      await getNextAnimationFramePromise();
      expect(dragging).toBe(false);
      expect(dragEvents).toEqual([]);
    });

    it("calls `didStopDragging` if the user interacts with the keyboard while dragging", async () => {
      const { component, editor } = buildComponent();

      let dragging = false;
      function startDragging() {
        component.handleMouseDragUntilMouseUp({
          didDrag: (_event) => {
            dragging = true;
          },
          didStopDragging: () => {
            dragging = false;
          },
        });
      }

      startDragging();
      window.dispatchEvent(new MouseEvent("mousemove"));
      await getNextAnimationFramePromise();
      expect(dragging).toBe(true);

      // Buffer changes don't cause dragging to be stopped.
      editor.insertText("X");
      expect(dragging).toBe(true);

      // Keyboard interaction prevents users from dragging further.
      component.didKeydown({ code: "KeyX" });
      expect(dragging).toBe(false);

      window.dispatchEvent(new MouseEvent("mousemove"));
      await getNextAnimationFramePromise();
      expect(dragging).toBe(false);

      // Pressing a modifier key does not terminate dragging, (to ensure we can add new selections with the mouse)
      startDragging();
      window.dispatchEvent(new MouseEvent("mousemove"));
      await getNextAnimationFramePromise();
      expect(dragging).toBe(true);
      component.didKeydown({ key: "Control" });
      component.didKeydown({ key: "Alt" });
      component.didKeydown({ key: "Shift" });
      component.didKeydown({ key: "Meta" });
      expect(dragging).toBe(true);
    });

    function getNextAnimationFramePromise() {
      return new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });

  describe("RTL text handling", () => {
    it("renders multiple decorations for a contiguous selection if line contains bidirectional text", async () => {
      const { component, element, editor } = buildComponent({ text: SAMPLE_WITH_RTL_TEXT });
      editor.setSoftWrapped(true);
      await component.getNextUpdatePromise();
      await setEditorWidthInCharacters(component, 60);

      const marker = editor.markScreenRange([
        [1, 15],
        [1, 39],
      ]);
      editor.decorateMarker(marker, { type: "highlight", class: "a" });
      await component.getNextUpdatePromise();

      // Selection begins in an LTR text region and ends in an RTL text region;
      // therefore there will be two non-contiguous highlights on the line.
      {
        let regions = Array.from(element.querySelectorAll(".highlight.a .region.a"));
        expect(regions.length).toBe(2);
        const regionRects = regions.map((r) => r.getBoundingClientRect());
        expect(regionRects[0].top).toBe(
          lineNodeForScreenRow(component, 1).getBoundingClientRect().top,
        );
        expect(regionRects[1].top).toBe(
          lineNodeForScreenRow(component, 1).getBoundingClientRect().top,
        );
        expect(Math.round(regionRects[0].left)).toBeNear(clientLeftForCharacter(component, 1, 15));
        expect(Math.round(regionRects[1].left)).toBeNear(clientLeftForCharacter(component, 1, 39));
      }

      marker.setScreenRange([
        [1, 36],
        [1, 39],
      ]);
      await component.getNextUpdatePromise();

      // Selection begins and ends in an RTL text region; therefore there will
      // be one contiguous highlight on the line.

      {
        let regions = element.querySelectorAll(".highlight.a .region.a");
        expect(regions.length).toBe(1);
        const regionRect = regions[0].getBoundingClientRect();
        expect(regionRect.top).toBe(lineNodeForScreenRow(component, 1).getBoundingClientRect().top);
        expect(regionRect.bottom).toBe(
          lineNodeForScreenRow(component, 1).getBoundingClientRect().bottom,
        );
        // The text rendering is “backwards,” so the left side of the selection
        // will match the _later_ column index.
        expect(Math.round(regionRect.left)).toBeNear(clientLeftForCharacter(component, 1, 39));
        expect(Math.round(regionRect.right)).toBeNear(
          clientRectAroundCharacter(component, 1, 36).right,
        );
      }

      marker.setScreenRange([
        [1, 23],
        [1, 59],
      ]);
      await component.getNextUpdatePromise();

      // Selection starts in LTR, passes through RTL, then ends in LTR. DOM
      // methods on the actual text would report that it was drawn with three
      // different `DOMRects`, but since they touch one another, we consolidate
      // them into a single region.
      {
        let regions = element.querySelectorAll(".highlight.a .region.a");
        expect(regions.length).toBe(1);
        const regionRect = regions[0].getBoundingClientRect();
        expect(regionRect.top).toBe(lineNodeForScreenRow(component, 1).getBoundingClientRect().top);
        expect(regionRect.bottom).toBe(
          lineNodeForScreenRow(component, 1).getBoundingClientRect().bottom,
        );

        expect(Math.round(regionRect.left)).toBeNear(clientLeftForCharacter(component, 1, 23));
        expect(Math.round(regionRect.right)).toBeNear(
          clientRectAroundRange(component, 1, 58, 59).right,
        );
      }
    });

    it("handles multi-line selections", async () => {
      const { component, element, editor } = buildComponent({ text: SAMPLE_WITH_RTL_TEXT });
      editor.setSoftWrapped(true);
      await component.getNextUpdatePromise();
      await setEditorWidthInCharacters(component, 60);

      const marker = editor.markScreenRange([
        [1, 39],
        [2, 24],
      ]);
      editor.decorateMarker(marker, { type: "highlight", class: "a" });
      await component.getNextUpdatePromise();

      // Selection starts in RTL text and goes to the end of the line, passing
      // through LTR text along the way. It ends at the end of a line that
      // holds only LTR text.
      //
      // Thus the selection should have two regions on its initial line, the
      // rightmost of which should extend all the way to the edge of the
      // editor.
      {
        let regions = element.querySelectorAll(".highlight.a .region.a");
        expect(regions.length).toBe(3);
        let regionRects = Array.from(regions).map((r) => r.getBoundingClientRect());
        // At least one of the first two regions should have a CSS `right` of
        // `0px` to signify that it goes all the way to the right edge of the
        // editor.
        expect([regions[0], regions[1]].some((rect) => rect.style.right === "0px")).toBe(true);
        // First two `DOMRect`s should align with line 1…
        expect(regionRects[0].top).toBe(
          lineNodeForScreenRow(component, 1).getBoundingClientRect().top,
        );
        expect(regionRects[1].top).toBe(
          lineNodeForScreenRow(component, 1).getBoundingClientRect().top,
        );
        // …and the third should align with line 2.
        expect(regionRects[2].top).toBe(
          lineNodeForScreenRow(component, 2).getBoundingClientRect().top,
        );
      }

      marker.setScreenRange([
        [11, 27],
        [14, 33],
      ]);

      await component.getNextUpdatePromise();

      // Starts on an LTR line and ends on a line that contains RTL text. The
      // ending line should have two highlighted regions. Starting and ending
      // lines are nonconsecutive, so there'll be an extra selection
      // representing the middle rows.
      {
        let regions = element.querySelectorAll(".highlight.a .region.a");
        expect(regions.length).toBe(4);
        let regionRects = Array.from(regions).map((r) => r.getBoundingClientRect());
        expect(regionRects[0].top).toBe(
          lineNodeForScreenRow(component, 11).getBoundingClientRect().top,
        );
        // Second `DOMRect` should represent the middle rows.
        expect(regionRects[1].top).toBe(
          lineNodeForScreenRow(component, 12).getBoundingClientRect().top,
        );
        expect(regionRects[1].bottom).toBe(
          lineNodeForScreenRow(component, 14).getBoundingClientRect().top,
        );
        // Last two should represent the discontiguous selections on the last
        // row.
        expect(regionRects[2].top).toBe(
          lineNodeForScreenRow(component, 14).getBoundingClientRect().top,
        );
        expect(regionRects[3].top).toBe(
          lineNodeForScreenRow(component, 14).getBoundingClientRect().top,
        );
      }
    });

    it("extends a multi-line highlight to the left edge of a mixed-direction ending row", async () => {
      const { component, element, editor } = buildComponent({
        text: "start\nاین یک متن فارسی است English",
      });
      await component.getNextUpdatePromise();

      const marker = editor.markScreenRange([
        [0, 1],
        [1, 5],
      ]);
      editor.decorateMarker(marker, { type: "highlight", class: "a" });
      await component.getNextUpdatePromise();

      const regions = Array.from(element.querySelectorAll(".highlight.a .region.a"));
      expect(regions.length).toBe(2);
      expect(regions[0].style.right).toBe("0px");
      expect(regions[1].getBoundingClientRect().left).toBe(
        lineNodeForScreenRow(component, 1).getBoundingClientRect().left,
      );
      expect(regions[1].getBoundingClientRect().right).toBeNear(
        clientRectAroundRange(component, 1, 0, 5).right,
      );
    });

    it("measures each column of a bidirectional-text line at a different X-axis position", async () => {
      const { component, editor } = buildComponent({ text: SAMPLE_WITH_RTL_TEXT });
      editor.setSoftWrapped(true);
      await component.getNextUpdatePromise();
      await setEditorWidthInCharacters(component, 60);

      let width = editor.lineLengthForScreenRow(14);
      let positions = new Set();
      // Schedule measurement of each position on the line.
      for (let i = 0; i < width; i++) {
        component.requestHorizontalMeasurement(14, i);
      }
      await component.getNextUpdatePromise();
      for (let i = 0; i < width; i++) {
        positions.add(component.pixelLeftForRowAndColumn(14, i));
      }
      // Previous faulty logic for determining the pixel positions of RTL
      // characters meant that multiple RTL characters incorrectly shared an
      // X-axis pixel measurement. Here we're asserting that we get 46 distinct
      // values for 46 columns.
      expect(positions.size).toBe(width);

      let original = [...positions];
      let sorted = [...original].sort((a, b) => a - b);

      // Here we're asserting that the pixel positions _do not_ monotonically
      // increase as we'd expect on a line with only LTR text. Sorting the list
      // by ascending pixel value should produce a different ordering than what
      // we already have.
      expect(original).not.toEqual(sorted);
    });
  });
});

function buildEditor(params = {}) {
  const text = params.text != null ? params.text : SAMPLE_TEXT;
  const buffer = new TextBuffer({ text });
  const editorParams = { buffer, readOnly: params.readOnly };
  if (params.height != null) params.autoHeight = false;
  for (const paramName of [
    "mini",
    "autoHeight",
    "autoWidth",
    "lineNumberGutterVisible",
    "showLineNumbers",
    "placeholderText",
    "softWrapped",
    "scrollSensitivity",
    "smoothScrolling",
    "wheelSmoothness",
    "commandSmoothness",
    "altWheelMultiplier",
  ]) {
    if (params[paramName] != null) editorParams[paramName] = params[paramName];
  }
  lumine.grammars.autoAssignLanguageMode(buffer);
  const editor = new TextEditor(editorParams);
  editor.testAutoscrollRequests = [];
  editor.onDidRequestAutoscroll((request) => {
    editor.testAutoscrollRequests.push(request);
  });
  editors.push(editor);
  return editor;
}

function buildComponent(params = {}) {
  const editor = params.editor || buildEditor(params);
  const component = new TextEditorComponent({
    model: editor,
    rowsPerTile: params.rowsPerTile,
    cursorBlinkPeriod: params.cursorBlinkPeriod,
    cursorBlinkResumeDelay: params.cursorBlinkResumeDelay,
    updatedSynchronously: params.updatedSynchronously || false,
    platform: params.platform,
    chromeVersion: params.chromeVersion,
  });
  const { element } = component;
  if (!editor.getAutoHeight()) {
    element.style.height = params.height ? params.height + "px" : "600px";
  }
  if (!editor.getAutoWidth()) {
    element.style.width = params.width ? params.width + "px" : "800px";
  }
  if (params.attach !== false) jasmine.attachToDOM(element);
  return { component, element, editor };
}

function getEditorWidthInBaseCharacters(component) {
  return Math.round(component.getScrollContainerWidth() / component.getBaseCharacterWidth());
}

// Drive the resize directly instead of waiting on ResizeObserver delivery:
// an occluded CI host window can stop rendering, so the observer never fires
// and the awaited update never lands - and a size the caller happens to set
// to its current value never fires it at all. didResize measures the new
// size and performs the update synchronously; when the size is unchanged it
// is a no-op, which needs no update either way.
function setEditorHeightInLines(component, heightInLines) {
  component.element.style.height = component.getLineHeight() * heightInLines + "px";
  component.didResize();
}

function setEditorWidthInCharacters(component, widthInCharacters) {
  component.element.style.width =
    component.getGutterContainerWidth() +
    widthInCharacters * component.measurements.baseCharacterWidth +
    verticalScrollbarWidth +
    "px";
  component.didResize();
}

function verifyCursorPosition(component, cursorNode, row, column) {
  const rect = cursorNode.getBoundingClientRect();
  expect(Math.round(rect.top)).toBeNear(clientTopForLine(component, row));
  expect(Math.round(rect.left)).toBe(Math.round(clientLeftForCharacter(component, row, column)));
}

function expectHighlightRegionsToSpanRange(component, regions, row, startColumn, endColumn) {
  expect(regions.length).toBeGreaterThan(0);

  const lineRect = lineNodeForScreenRow(component, row).getBoundingClientRect();
  const regionRects = Array.from(regions).map((region) => region.getBoundingClientRect());

  for (const regionRect of regionRects) {
    expect(regionRect.top).toBe(lineRect.top);
    expect(regionRect.bottom).toBe(lineRect.bottom);
  }

  expect(Math.round(Math.min(...regionRects.map((regionRect) => regionRect.left)))).toBeNear(
    clientLeftForCharacter(component, row, startColumn),
  );
  expect(Math.round(Math.max(...regionRects.map((regionRect) => regionRect.right)))).toBeNear(
    clientLeftForCharacter(component, row, endColumn),
  );
}

function clientTopForLine(component, row) {
  return lineNodeForScreenRow(component, row).getBoundingClientRect().top;
}

function clientRectAroundRange(component, row, startColumn, endColumn, index = 0) {
  const textNodes = textNodesForScreenRow(component, row);
  let textNodeStartColumn = 0;
  const range = document.createRange();
  let didSetStart = false;
  let didSetEnd = false;
  for (const textNode of textNodes) {
    const textNodeEndColumn = textNodeStartColumn + textNode.textContent.length;
    if (startColumn < textNodeEndColumn && !didSetStart) {
      range.setStart(textNode, startColumn - textNodeStartColumn);
      didSetStart = true;
    }
    if (endColumn <= textNodeEndColumn && !didSetEnd) {
      range.setEnd(textNode, endColumn - textNodeStartColumn);
      didSetEnd = true;
    }

    if (didSetStart && didSetEnd) {
      let rects = range.getClientRects();
      return rects[index];
    }
    textNodeStartColumn = textNodeEndColumn;
  }
  throw new Error(`Invalid screen range: (${row}, ${startColumn}) — (${row}, ${endColumn})`);
}

// Given a row and column, attempts to extract a `ClientRect` for a single
// character.
function clientRectAroundCharacter(component, row, column, index = 0) {
  return clientRectAroundRange(component, row, column, column + 1, index);
}

function clientLeftForCharacter(component, row, column) {
  const textNodes = textNodesForScreenRow(component, row);
  let textNodeStartColumn = 0;
  for (const textNode of textNodes) {
    const textNodeEndColumn = textNodeStartColumn + textNode.textContent.length;
    if (column < textNodeEndColumn) {
      const range = document.createRange();
      range.setStart(textNode, column - textNodeStartColumn);
      range.setEnd(textNode, column - textNodeStartColumn);
      return range.getBoundingClientRect().left;
    }
    textNodeStartColumn = textNodeEndColumn;
  }

  const lastTextNode = textNodes[textNodes.length - 1];
  const range = document.createRange();
  range.setStart(lastTextNode, 0);
  range.setEnd(lastTextNode, lastTextNode.textContent.length);
  return range.getBoundingClientRect().right;
}

function clientPositionForCharacter(component, row, column) {
  return {
    clientX: clientLeftForCharacter(component, row, column),
    clientY: clientTopForLine(component, row),
  };
}

function lineNumberNodeForScreenRow(component, row) {
  const gutterElement = component.refs.gutterContainer.refs.lineNumberGutter.element;
  const tileStartRow = component.tileStartRowForRow(row);
  const tileIndex = component.renderedTileStartRows.indexOf(tileStartRow);
  return gutterElement.children[tileIndex + 1].children[row - tileStartRow];
}

function lineNodeForScreenRow(component, row) {
  const renderedScreenLine = component.renderedScreenLineForRow(row);
  return component.lineComponentsByScreenLineId.get(renderedScreenLine.id).element;
}

function textNodesForScreenRow(component, row) {
  const screenLine = component.renderedScreenLineForRow(row);
  return component.lineComponentsByScreenLineId.get(screenLine.id).textNodes;
}

function setScrollTop(component, scrollTop) {
  component.setScrollTop(scrollTop);
  component.scheduleUpdate();
  return component.getNextUpdatePromise();
}

function setScrollLeft(component, scrollLeft) {
  component.setScrollLeft(scrollLeft);
  component.scheduleUpdate();
  return component.getNextUpdatePromise();
}

function getHorizontalScrollbarHeight(component) {
  const element = component.refs.horizontalScrollbar.element;
  return element.offsetHeight - element.clientHeight;
}

function getVerticalScrollbarWidth(component) {
  const element = component.refs.verticalScrollbar.element;
  return element.offsetWidth - element.clientWidth;
}

function getElementHeight(element) {
  const topRuler = document.createElement("div");
  const bottomRuler = document.createElement("div");
  let height;
  if (document.body.contains(element)) {
    element.parentElement.insertBefore(topRuler, element);
    element.parentElement.insertBefore(bottomRuler, element.nextSibling);
    height = bottomRuler.offsetTop - topRuler.offsetTop;
  } else {
    jasmine.attachToDOM(topRuler);
    jasmine.attachToDOM(element);
    jasmine.attachToDOM(bottomRuler);
    height = bottomRuler.offsetTop - topRuler.offsetTop;
    element.remove();
  }

  topRuler.remove();
  bottomRuler.remove();
  return height;
}

function queryOnScreenLineNumberElements(element) {
  return Array.from(element.querySelectorAll(".line-number:not(.dummy)"));
}

function queryOnScreenLineElements(element) {
  return Array.from(element.querySelectorAll(".line:not(.dummy):not([data-off-screen])"));
}
