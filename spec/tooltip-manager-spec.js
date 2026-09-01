const { CompositeDisposable } = require("lumine");
const TooltipManager = require("../src/tooltip-manager");
const Tooltip = require("../src/tooltip");
const _ = require("@lumine-code/underscore-plus");

describe("TooltipManager", () => {
  let manager, element;

  const ctrlX = _.humanizeKeystroke("ctrl-x");
  const ctrlY = _.humanizeKeystroke("ctrl-y");

  const hover = function (element, fn) {
    mouseEnter(element);
    advanceClock(manager.hoverDefaults.delay.show);
    fn();
    mouseLeave(element);
    advanceClock(manager.hoverDefaults.delay.hide);
  };

  beforeEach(function () {
    manager = new TooltipManager({
      keymapManager: lumine.keymaps,
      viewRegistry: lumine.views,
    });
    element = createElement("foo");
  });

  afterEach(function () {
    manager.destroy();
  });

  describe("::add(target, options)", () => {
    describe("when the trigger is 'hover' (the default)", () => {
      it("creates a tooltip when hovering over the target element", () => {
        manager.add(element, { title: "Title" });
        hover(element, () => expect(document.body.querySelector(".tooltip")).toHaveText("Title"));
      });

      it("displays tooltips immediately when hovering over new elements once a tooltip has been displayed once", () => {
        const disposables = new CompositeDisposable();
        const element1 = createElement("foo");
        disposables.add(manager.add(element1, { title: "Title" }));
        const element2 = createElement("bar");
        disposables.add(manager.add(element2, { title: "Title" }));
        const element3 = createElement("baz");
        disposables.add(manager.add(element3, { title: "Title" }));

        hover(element1, () => {});
        expect(document.body.querySelector(".tooltip")).toBeNull();

        mouseEnter(element2);
        expect(document.body.querySelector(".tooltip")).not.toBeNull();
        mouseLeave(element2);
        advanceClock(manager.hoverDefaults.delay.hide);
        expect(document.body.querySelector(".tooltip")).toBeNull();

        advanceClock(Tooltip.FOLLOW_THROUGH_DURATION);
        mouseEnter(element3);
        expect(document.body.querySelector(".tooltip")).toBeNull();
        advanceClock(manager.hoverDefaults.delay.show);
        expect(document.body.querySelector(".tooltip")).not.toBeNull();

        disposables.dispose();
      });

      it("displays the next tooltip immediately while the previous one is hiding", () => {
        const element1 = createElement("foo");
        const element2 = createElement("bar");
        const disposables = new CompositeDisposable(
          manager.add(element1, { title: "Title 1" }),
          manager.add(element2, { title: "Title 2" }),
        );

        // Clear any follow-through state left by an earlier tooltip before
        // setting up the handoff being tested below.
        mouseEnter(element1);
        advanceClock(manager.hoverDefaults.delay.show);
        mouseLeave(element1);
        advanceClock(manager.hoverDefaults.delay.hide);
        advanceClock(Tooltip.FOLLOW_THROUGH_DURATION);

        mouseEnter(element1);
        advanceClock(manager.hoverDefaults.delay.show);
        expect(document.body.querySelector(".tooltip")).toHaveText("Title 1");

        mouseLeave(element1);
        mouseEnter(element2);

        // The handoff is immediate in both directions: the second tooltip
        // shows without waiting for the show delay, and the first goes at
        // once rather than sitting on screen beside it for the hide delay.
        expect(document.body.querySelectorAll(".tooltip").length).toBe(1);
        expect(document.body.querySelector(".tooltip")).toHaveText("Title 2");

        advanceClock(manager.hoverDefaults.delay.hide);
        expect(document.body.querySelectorAll(".tooltip").length).toBe(1);
        expect(document.body.querySelector(".tooltip")).toHaveText("Title 2");

        mouseLeave(element2);
        advanceClock(manager.hoverDefaults.delay.hide);
        disposables.dispose();
      });

      // Sweeping along a row of status bar items is the case this protects:
      // every handoff falls inside the follow-through window, where the
      // incoming tooltip shows before the outgoing one's hide delay is up.
      it("never leaves two tooltips on screen while moving between neighbours", () => {
        const elements = ["foo", "bar", "baz"].map(createElement);
        const disposables = new CompositeDisposable(
          ...elements.map((element, index) =>
            manager.add(element, { title: `Title ${index + 1}` }),
          ),
        );

        mouseEnter(elements[0]);
        advanceClock(manager.hoverDefaults.delay.show);

        for (let index = 1; index < elements.length; index++) {
          mouseLeave(elements[index - 1]);
          mouseEnter(elements[index]);
          expect(document.body.querySelectorAll(".tooltip").length).toBe(1);
          expect(document.body.querySelector(".tooltip")).toHaveText(`Title ${index + 1}`);
        }

        mouseLeave(elements[elements.length - 1]);
        advanceClock(manager.hoverDefaults.delay.hide);
        expect(document.body.querySelectorAll(".tooltip").length).toBe(0);

        disposables.dispose();
      });

      // Core animates nothing; it only marks the shows a theme must not
      // animate, so a swept row of tooltips does not flash a fade per item.
      it("marks a tooltip that takes over from another as a follow-through", () => {
        const element1 = createElement("foo");
        const element2 = createElement("bar");
        const disposables = new CompositeDisposable(
          manager.add(element1, { title: "Title 1" }),
          manager.add(element2, { title: "Title 2" }),
        );

        // Clear any follow-through state left by an earlier tooltip. Advancing
        // the clock alone will not do it: the window is module state that
        // outlives a spec, while the fake clock its timer was scheduled on is
        // reset, so only a fresh cycle can retire it.
        mouseEnter(element1);
        advanceClock(manager.hoverDefaults.delay.show);
        mouseLeave(element1);
        advanceClock(manager.hoverDefaults.delay.hide);
        advanceClock(Tooltip.FOLLOW_THROUGH_DURATION);

        // Nothing has been on screen recently, so this one arrives from nothing.
        mouseEnter(element1);
        advanceClock(manager.hoverDefaults.delay.show);
        expect(document.body.querySelector(".tooltip")).not.toHaveClass("follow-through");

        // Sweeping straight on: a continuation of what is already showing.
        mouseLeave(element1);
        mouseEnter(element2);
        expect(document.body.querySelector(".tooltip")).toHaveClass("follow-through");

        // The same tooltip entered cold again is an appearance once more, so
        // the mark has to come back off the element it is reused on.
        mouseLeave(element2);
        advanceClock(manager.hoverDefaults.delay.hide);
        advanceClock(Tooltip.FOLLOW_THROUGH_DURATION);
        mouseEnter(element2);
        advanceClock(manager.hoverDefaults.delay.show);
        expect(document.body.querySelector(".tooltip")).not.toHaveClass("follow-through");

        mouseLeave(element2);
        advanceClock(manager.hoverDefaults.delay.hide);
        disposables.dispose();
      });

      it("hides the tooltip on keydown events", () => {
        const disposable = manager.add(element, {
          title: "Title",
          trigger: "hover",
        });
        hover(element, function () {
          expect(document.body.querySelector(".tooltip")).not.toBeNull();
          window.dispatchEvent(
            new CustomEvent("keydown", {
              bubbles: true,
            }),
          );
          expect(document.body.querySelector(".tooltip")).toBeNull();
          disposable.dispose();
        });
      });

      it("cancels pending and visible tooltips on click", () => {
        const disposable = manager.add(element, { title: "Title" });

        mouseEnter(element);
        element.click();
        advanceClock(manager.hoverDefaults.delay.show);
        expect(document.body.querySelector(".tooltip")).toBeNull();

        mouseLeave(element);
        mouseEnter(element);
        expect(document.body.querySelector(".tooltip")).toBeNull();
        advanceClock(manager.hoverDefaults.delay.show);
        expect(document.body.querySelector(".tooltip")).not.toBeNull();
        document.body.click();
        expect(document.body.querySelector(".tooltip")).toBeNull();
        disposable.dispose();
      });

      it("cancels a tooltip on RMB even when the target intercepts contextmenu", () => {
        const disposable = manager.add(element, { title: "Title" });
        element.addEventListener("contextmenu", (event) => event.stopPropagation());
        mouseEnter(element);
        advanceClock(manager.hoverDefaults.delay.show);
        expect(document.body.querySelector(".tooltip")).not.toBeNull();

        element.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
        );

        expect(document.body.querySelector(".tooltip")).toBeNull();
        disposable.dispose();
      });

      // A scroll moves the target out from under a pointer that never moved,
      // and no mouseout follows to say so.
      it("hides the tooltip when a scroll moves the target", () => {
        const disposable = manager.add(element, {
          title: "Title",
          trigger: "hover",
        });
        hover(element, function () {
          expect(document.body.querySelector(".tooltip")).not.toBeNull();
          element.style.position = "relative";
          element.style.top = "40px";
          scroll(element);
          expect(document.body.querySelector(".tooltip")).toBeNull();
          disposable.dispose();
        });
      });

      it("keeps the tooltip when a scroll leaves the target where it was", () => {
        const disposable = manager.add(element, {
          title: "Title",
          trigger: "hover",
        });
        hover(element, function () {
          expect(document.body.querySelector(".tooltip")).not.toBeNull();
          scroll(element);
          expect(document.body.querySelector(".tooltip")).not.toBeNull();
          disposable.dispose();
        });
      });
    });

    describe("when the trigger is 'manual'", () =>
      it("creates a tooltip immediately and hides it on click", () => {
        const disposable = manager.add(element, {
          title: "Title",
          trigger: "manual",
        });
        expect(document.body.querySelector(".tooltip")).toHaveText("Title");
        document.body.click();
        expect(document.body.querySelector(".tooltip")).toBeNull();
        disposable.dispose();
        expect(document.body.querySelector(".tooltip")).toBeNull();
      }));

    describe("when the trigger is 'click'", () =>
      it("shows and hides the tooltip when the target element is clicked", () => {
        manager.add(element, { title: "Title", trigger: "click" });
        expect(document.body.querySelector(".tooltip")).toBeNull();
        element.click();
        expect(document.body.querySelector(".tooltip")).not.toBeNull();
        element.click();
        expect(document.body.querySelector(".tooltip")).toBeNull();

        // Any click outside the trigger hides the tooltip, including a click
        // inside the tooltip itself.
        element.click();
        expect(document.body.querySelector(".tooltip")).not.toBeNull();
        document.body.querySelector(".tooltip").click();
        expect(document.body.querySelector(".tooltip")).toBeNull();
        element.click();
        expect(document.body.querySelector(".tooltip")).not.toBeNull();
        document.body.click();
        expect(document.body.querySelector(".tooltip")).toBeNull();

        // Tooltip can show again after hiding due to clicking outside of the tooltip
        element.click();
        expect(document.body.querySelector(".tooltip")).not.toBeNull();
        element.click();
        expect(document.body.querySelector(".tooltip")).toBeNull();
      }));

    it("does not hide the tooltip on keyboard input", () => {
      manager.add(element, { title: "Title", trigger: "click" });
      element.click();
      expect(document.body.querySelector(".tooltip")).not.toBeNull();
      window.dispatchEvent(
        new CustomEvent("keydown", {
          bubbles: true,
        }),
      );
      expect(document.body.querySelector(".tooltip")).not.toBeNull();
      // click again to hide the tooltip because otherwise state leaks
      // into other tests.
      element.click();
    });

    // Only a tooltip the pointer opened is retired by the target scrolling out
    // from under it. A manual tooltip stands until it is disposed, and nothing
    // would bring it back.
    it("does not hide a manually triggered tooltip when a scroll moves the target", () => {
      const disposable = manager.add(element, {
        title: "Title",
        trigger: "manual",
      });
      expect(document.body.querySelector(".tooltip")).not.toBeNull();
      element.style.position = "relative";
      element.style.top = "40px";
      scroll(element);
      expect(document.body.querySelector(".tooltip")).not.toBeNull();
      disposable.dispose();
    });

    it("allows a custom item to be specified for the content of the tooltip", () => {
      const tooltipElement = document.createElement("div");
      manager.add(element, { item: { element: tooltipElement } });
      hover(element, () => expect(tooltipElement.closest(".tooltip")).not.toBeNull());
    });

    it("allows a custom class to be specified for the tooltip", () => {
      manager.add(element, { title: "Title", class: "custom-tooltip-class" });
      hover(element, () =>
        expect(
          document.body.querySelector(".tooltip").classList.contains("custom-tooltip-class"),
        ).toBe(true),
      );
    });

    it("allows jQuery elements to be passed as the target", () => {
      const element2 = document.createElement("div");
      jasmine.attachToDOM(element2);

      const fakeJqueryWrapper = {
        0: element,
        1: element2,
        length: 2,
        jquery: "any-version",
      };
      const disposable = manager.add(fakeJqueryWrapper, { title: "Title" });

      hover(element, () => expect(document.body.querySelector(".tooltip")).toHaveText("Title"));
      expect(document.body.querySelector(".tooltip")).toBeNull();
      hover(element2, () => expect(document.body.querySelector(".tooltip")).toHaveText("Title"));
      expect(document.body.querySelector(".tooltip")).toBeNull();

      disposable.dispose();

      hover(element, () => expect(document.body.querySelector(".tooltip")).toBeNull());
      hover(element2, () => expect(document.body.querySelector(".tooltip")).toBeNull());
    });

    describe("when a keyBindingCommand is specified", () => {
      describe("when a title is specified", () =>
        it("appends the key binding corresponding to the command to the title", () => {
          lumine.keymaps.add("test", {
            ".foo": { "ctrl-x ctrl-y": "test-command" },
            ".bar": { "ctrl-x ctrl-z": "test-command" },
          });

          manager.add(element, {
            title: "Title",
            keyBindingCommand: "test-command",
          });

          hover(element, function () {
            const tooltipElement = document.body.querySelector(".tooltip");
            expect(tooltipElement).toHaveText(`Title ${ctrlX} ${ctrlY}`);
          });
        }));

      describe("when no title is specified", () =>
        it("shows the key binding corresponding to the command alone", () => {
          lumine.keymaps.add("test", {
            ".foo": { "ctrl-x ctrl-y": "test-command" },
          });

          manager.add(element, { keyBindingCommand: "test-command" });

          hover(element, function () {
            const tooltipElement = document.body.querySelector(".tooltip");
            expect(tooltipElement).toHaveText(`${ctrlX} ${ctrlY}`);
          });
        }));

      describe("when the title is a function", () => {
        it("calls the function and appends the key binding to the result", () => {
          lumine.keymaps.add("test", {
            ".foo": { "ctrl-x ctrl-y": "test-command" },
          });

          manager.add(element, {
            title: () => "Title",
            keyBindingCommand: "test-command",
          });

          hover(element, function () {
            const tooltipElement = document.body.querySelector(".tooltip");
            expect(tooltipElement).toHaveText(`Title ${ctrlX} ${ctrlY}`);
          });
        });

        it("calls the function without appending anything when no key binding is found", () => {
          manager.add(element, {
            title: () => "Title",
            keyBindingCommand: "test-command",
          });

          hover(element, function () {
            const tooltipElement = document.body.querySelector(".tooltip");
            expect(tooltipElement.textContent).toBe("Title");
          });
        });
      });

      describe("when the keymap changes after the tooltip is registered", () => {
        it("shows the updated key binding when a string title is specified", () => {
          const initialKeymap = lumine.keymaps.add("initial", {
            ".foo": { "ctrl-x ctrl-z": "test-command" },
          });

          manager.add(element, {
            title: "Title",
            keyBindingCommand: "test-command",
          });

          initialKeymap.dispose();
          lumine.keymaps.add("test", {
            ".foo": { "ctrl-x ctrl-y": "test-command" },
          });

          hover(element, function () {
            const tooltipElement = document.body.querySelector(".tooltip");
            expect(tooltipElement).toHaveText(`Title ${ctrlX} ${ctrlY}`);
          });
        });

        it("shows the updated key binding when no title is specified", () => {
          const initialKeymap = lumine.keymaps.add("initial", {
            ".foo": { "ctrl-x ctrl-z": "test-command" },
          });

          manager.add(element, { keyBindingCommand: "test-command" });

          initialKeymap.dispose();
          lumine.keymaps.add("test", {
            ".foo": { "ctrl-x ctrl-y": "test-command" },
          });

          hover(element, function () {
            const tooltipElement = document.body.querySelector(".tooltip");
            expect(tooltipElement).toHaveText(`${ctrlX} ${ctrlY}`);
          });
        });

        it("shows the updated key binding when the title is a function", () => {
          const initialKeymap = lumine.keymaps.add("initial", {
            ".foo": { "ctrl-x ctrl-z": "test-command" },
          });

          manager.add(element, {
            title: () => "Title",
            keyBindingCommand: "test-command",
          });

          initialKeymap.dispose();
          lumine.keymaps.add("test", {
            ".foo": { "ctrl-x ctrl-y": "test-command" },
          });

          hover(element, function () {
            const tooltipElement = document.body.querySelector(".tooltip");
            expect(tooltipElement).toHaveText(`Title ${ctrlX} ${ctrlY}`);
          });
        });
      });

      describe("when a keyBindingTarget is specified", () => {
        it("looks up the key binding relative to the target", () => {
          lumine.keymaps.add("test", {
            ".bar": { "ctrl-x ctrl-z": "test-command" },
            ".foo": { "ctrl-x ctrl-y": "test-command" },
          });

          manager.add(element, {
            keyBindingCommand: "test-command",
            keyBindingTarget: element,
          });

          hover(element, function () {
            const tooltipElement = document.body.querySelector(".tooltip");
            expect(tooltipElement).toHaveText(`${ctrlX} ${ctrlY}`);
          });
        });

        it("does not display the keybinding if there is nothing mapped to the specified keyBindingCommand", () => {
          manager.add(element, {
            title: "A Title",
            keyBindingCommand: "test-command",
            keyBindingTarget: element,
          });

          hover(element, function () {
            const tooltipElement = document.body.querySelector(".tooltip");
            expect(tooltipElement.textContent).toBe("A Title");
          });
        });
      });
    });

    describe("::addComposite(target, entries)", () => {
      it("renders each tooltip entry on a separate line", () => {
        lumine.keymaps.add("test", {
          ".foo": {
            "ctrl-x": "sticky-command",
            "ctrl-y": "picker-command",
          },
        });

        manager.addComposite(element, [
          { title: "Column selection" },
          {
            title: "Toggle sticky mode",
            keyBindingExtra: "LMB",
            keyBindingCommand: "sticky-command",
          },
          { title: "Toggle picker mode", keyBindingCommand: "picker-command" },
        ]);

        hover(element, function () {
          expect(document.body.querySelector(".tooltip-composite")).not.toBeNull();
          const rows = document.body.querySelectorAll(".tooltip-composite-item");
          expect(rows.length).toBe(3);
          expect(rows[0].textContent).toBe("Column selection");
          expect(rows[0].classList.contains("has-key-binding")).toBe(false);
          expect(rows[1].textContent).toBe(`Toggle sticky mode LMB ${ctrlX}`);
          expect(rows[1].classList.contains("has-key-binding")).toBe(true);
          expect(rows[1].querySelector(".key-bindings")).not.toBeNull();
          expect(rows[1].querySelectorAll(".keystroke").length).toBe(2);
          expect(rows[2].textContent).toBe(`Toggle picker mode ${ctrlY}`);
          expect(rows[2].classList.contains("has-key-binding")).toBe(true);
        });
      });

      it("composes multiline hints without key bindings", () => {
        manager.addComposite(element, [{ title: "First hint" }, { title: () => "Second hint" }]);

        hover(element, function () {
          const rows = document.body.querySelectorAll(".tooltip-composite-item");
          expect(Array.from(rows, (row) => row.textContent)).toEqual(["First hint", "Second hint"]);
          expect(document.body.querySelector(".key-bindings")).toBeNull();
        });
      });

      it("resolves platform modifiers in extra key bindings", () => {
        manager.addComposite(element, [
          { title: "More actions", keyBindingExtra: "cmdorctrl+RMB" },
          { title: "Shift action", keyBindingExtra: "Shift+LMB" },
        ]);

        hover(element, function () {
          const keystrokes = Array.from(
            document.body.querySelectorAll(".keystroke"),
            (element) => element.textContent,
          );
          expect(keystrokes).toEqual([
            _.humanizeKeystroke("cmdorctrl-RMB"),
            _.humanizeKeystroke("shift-LMB"),
          ]);
        });
      });

      it("requires at least one entry", () => {
        expect(() => manager.addComposite(element, [])).toThrowError(
          "`entries` must be a non-empty array of tooltip options.",
        );
      });
    });

    describe("when .dispose() is called on the returned disposable", () =>
      it("no longer displays the tooltip on hover", () => {
        const disposable = manager.add(element, { title: "Title" });

        hover(element, () => expect(document.body.querySelector(".tooltip")).toHaveText("Title"));

        disposable.dispose();

        hover(element, () => expect(document.body.querySelector(".tooltip")).toBeNull());
      }));

    describe("when the window is resized", () =>
      it("hides the tooltips", () => {
        const disposable = manager.add(element, { title: "Title" });
        hover(element, function () {
          expect(document.body.querySelector(".tooltip")).not.toBeNull();
          window.dispatchEvent(new CustomEvent("resize"));
          expect(document.body.querySelector(".tooltip")).toBeNull();
          disposable.dispose();
        });
      }));

    describe("findTooltips", () => {
      it("adds and remove tooltips correctly", () => {
        expect(manager.findTooltips(element).length).toBe(0);
        const disposable1 = manager.add(element, { title: "elem1" });
        expect(manager.findTooltips(element).length).toBe(1);
        const disposable2 = manager.add(element, { title: "elem2" });
        expect(manager.findTooltips(element).length).toBe(2);
        disposable1.dispose();
        expect(manager.findTooltips(element).length).toBe(1);
        disposable2.dispose();
        expect(manager.findTooltips(element).length).toBe(0);
      });

      it("lets us hide tooltips programmatically", () => {
        const disposable = manager.add(element, { title: "Title" });
        hover(element, function () {
          expect(document.body.querySelector(".tooltip")).not.toBeNull();
          manager.findTooltips(element)[0].hide();
          expect(document.body.querySelector(".tooltip")).toBeNull();
          disposable.dispose();
        });
      });
    });
  });
});

function createElement(className) {
  const el = document.createElement("div");
  el.classList.add(className);
  jasmine.attachToDOM(el);
  return el;
}

function mouseEnter(element) {
  element.dispatchEvent(new CustomEvent("mouseenter", { bubbles: false }));
  element.dispatchEvent(new CustomEvent("mouseover", { bubbles: true }));
}

function mouseLeave(element) {
  element.dispatchEvent(new CustomEvent("mouseleave", { bubbles: false }));
  element.dispatchEvent(new CustomEvent("mouseout", { bubbles: true }));
}

// A scroll event never bubbles, so this only reaches a listener that captures.
function scroll(element) {
  element.dispatchEvent(new CustomEvent("scroll", { bubbles: false }));
}
