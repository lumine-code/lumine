"use strict";

const Panel = require("../src/panel");
const PanelContainer = require("../src/panel-container");
const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("PanelContainerElement", () => {
  let jasmineContent, element, container;

  class TestPanelContainerItem {}

  class TestPanelContainerItemElement_ extends HTMLElement {
    connectedCallback() {
      this.classList.add("test-root");
    }
    initialize(model) {
      this.model = model;
      return this;
    }
    focus() {}
  }

  window.customElements.define(
    "lumine-test-container-item-element",
    TestPanelContainerItemElement_,
  );

  const TestPanelContainerItemElement = document.createElement(
    "lumine-test-container-item-element",
  );

  beforeEach(() => {
    jasmineContent = document.body.querySelector("#jasmine-content");

    lumine.views.addViewProvider(TestPanelContainerItem, (model) =>
      TestPanelContainerItemElement.initialize(model),
    );

    container = new PanelContainer({
      viewRegistry: lumine.views,
      location: "left",
    });
    element = container.getElement();
    jasmineContent.appendChild(element);
  });

  it("has a location class with value from the model", () => {
    expect(element).toHaveClass("left");
  });

  it("removes the element when the container is destroyed", () => {
    expect(element.parentNode).toBe(jasmineContent);
    container.destroy();
    expect(element.parentNode).not.toBe(jasmineContent);
  });

  describe("adding and removing panels", () => {
    it("allows panels to be inserted at any position", () => {
      const panel1 = new Panel({ item: new TestPanelContainerItem(), priority: 10 }, lumine.views);
      const panel2 = new Panel({ item: new TestPanelContainerItem(), priority: 5 }, lumine.views);
      const panel3 = new Panel({ item: new TestPanelContainerItem(), priority: 8 }, lumine.views);

      container.addPanel(panel1);
      container.addPanel(panel2);
      container.addPanel(panel3);

      expect(element.childNodes[2]).toBe(panel1.getElement());
      expect(element.childNodes[1]).toBe(panel3.getElement());
      expect(element.childNodes[0]).toBe(panel2.getElement());
    });

    describe("when the container is at the left location", () =>
      it("adds lumine-panel elements when a new panel is added to the container; removes them when the panels are destroyed", () => {
        expect(element.childNodes.length).toBe(0);

        const panel1 = new Panel({ item: new TestPanelContainerItem() }, lumine.views);
        container.addPanel(panel1);
        expect(element.childNodes.length).toBe(1);
        expect(element.childNodes[0]).toHaveClass("left");
        expect(element.childNodes[0]).toHaveClass("tool-panel"); // legacy selector support
        expect(element.childNodes[0]).toHaveClass("panel-left"); // legacy selector support

        expect(element.childNodes[0].tagName).toBe("LUMINE-PANEL");

        const panel2 = new Panel({ item: new TestPanelContainerItem() }, lumine.views);
        container.addPanel(panel2);
        expect(element.childNodes.length).toBe(2);

        expect(panel1.getElement().style.display).not.toBe("none");
        expect(panel2.getElement().style.display).not.toBe("none");

        panel1.destroy();
        expect(element.childNodes.length).toBe(1);

        panel2.destroy();
        expect(element.childNodes.length).toBe(0);
      }));

    describe("when the container is at the bottom location", () => {
      beforeEach(() => {
        container = new PanelContainer({
          viewRegistry: lumine.views,
          location: "bottom",
        });
        element = container.getElement();
        jasmineContent.appendChild(element);
      });

      it("adds lumine-panel elements when a new panel is added to the container; removes them when the panels are destroyed", () => {
        expect(element.childNodes.length).toBe(0);

        const panel1 = new Panel(
          { item: new TestPanelContainerItem(), className: "one" },
          lumine.views,
        );
        container.addPanel(panel1);
        expect(element.childNodes.length).toBe(1);
        expect(element.childNodes[0]).toHaveClass("bottom");
        expect(element.childNodes[0]).toHaveClass("tool-panel"); // legacy selector support
        expect(element.childNodes[0]).toHaveClass("panel-bottom"); // legacy selector support
        expect(element.childNodes[0].tagName).toBe("LUMINE-PANEL");
        expect(panel1.getElement()).toHaveClass("one");

        const panel2 = new Panel(
          { item: new TestPanelContainerItem(), className: "two" },
          lumine.views,
        );
        container.addPanel(panel2);
        expect(element.childNodes.length).toBe(2);
        expect(panel2.getElement()).toHaveClass("two");

        panel1.destroy();
        expect(element.childNodes.length).toBe(1);

        panel2.destroy();
        expect(element.childNodes.length).toBe(0);
      });
    });
  });

  describe("when the container is modal", () => {
    beforeEach(() => {
      container = new PanelContainer({
        viewRegistry: lumine.views,
        location: "modal",
      });
      element = container.getElement();
      jasmineContent.appendChild(element);
    });

    it("allows only one panel to be visible at a time", () => {
      const panel1 = new Panel({ item: new TestPanelContainerItem() }, lumine.views);
      container.addPanel(panel1);

      expect(panel1.getElement().style.display).not.toBe("none");

      const panel2 = new Panel({ item: new TestPanelContainerItem() }, lumine.views);
      container.addPanel(panel2);

      expect(panel1.getElement().style.display).toBe("none");
      expect(panel2.getElement().style.display).not.toBe("none");

      panel1.show();

      expect(panel1.getElement().style.display).not.toBe("none");
      expect(panel2.getElement().style.display).toBe("none");
    });

    it("adds the 'modal' class to panels", () => {
      const panel1 = new Panel({ item: new TestPanelContainerItem() }, lumine.views);
      container.addPanel(panel1);

      expect(panel1.getElement()).toHaveClass("modal");

      // legacy selector support
      expect(panel1.getElement()).not.toHaveClass("tool-panel");
      expect(panel1.getElement()).toHaveClass("overlay");
      expect(panel1.getElement()).toHaveClass("from-top");
    });

    it("transfers per-panel behavior when a stable panel moves to another container", () => {
      const destination = new PanelContainer({
        viewRegistry: lumine.views,
        location: "modal",
      });
      const destinationElement = destination.getElement();
      jasmineContent.appendChild(destinationElement);
      const panel = new Panel(
        { item: new TestPanelContainerItem(), visible: false, surfaceRelocatable: true },
        lumine.views,
      );
      container.addPanel(panel);
      spyOn(element, "hideAllPanelsExcept").and.callThrough();
      spyOn(destinationElement, "hideAllPanelsExcept").and.callThrough();

      destination.addPanel(panel);
      panel.show();

      expect(panel.getElement().parentNode).toBe(destinationElement);
      expect(element.hideAllPanelsExcept).not.toHaveBeenCalled();
      expect(destinationElement.hideAllPanelsExcept).toHaveBeenCalledOnceWith(panel);
      destination.destroy();
      panel.destroy();
    });

    it("moves a visible stable modal without a hide/show cycle and rebuilds focus handling", () => {
      const destination = new PanelContainer({
        viewRegistry: lumine.views,
        location: "modal",
      });
      const destinationElement = destination.getElement();
      jasmineContent.appendChild(destinationElement);
      const panel = new Panel(
        {
          item: new TestPanelContainerItem(),
          visible: false,
          autoFocus: true,
          surfaceRelocatable: true,
        },
        lumine.views,
      );
      container.addPanel(panel);
      const input = document.createElement("input");
      panel.getElement().appendChild(input);
      const visibilityChanges = jasmine.createSpy("visibilityChanges");
      panel.onDidChangeVisible(visibilityChanges);
      panel.show();
      visibilityChanges.calls.reset();

      destination.addPanel(panel);

      expect(panel.getElement().parentNode).toBe(destinationElement);
      expect(panel.isVisible()).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(visibilityChanges).not.toHaveBeenCalled();
      destination.destroy();
    });

    describe("autoFocus", () => {
      function createPanel(autoFocus = true) {
        const panel = new Panel(
          {
            item: new TestPanelContainerItem(),
            autoFocus: autoFocus,
            visible: false,
          },
          lumine.views,
        );

        container.addPanel(panel);
        return panel;
      }

      it("focuses the first tabbable item if available", () => {
        const panel = createPanel();
        const panelEl = panel.getElement();
        const inputEl = document.createElement("input");

        panelEl.appendChild(inputEl);
        expect(document.activeElement).not.toBe(inputEl);

        panel.show();
        expect(document.activeElement).toBe(inputEl);
        panel.destroy();
      });

      it("focuses the autoFocus element if available", () => {
        const inputEl1 = document.createElement("input");
        const inputEl2 = document.createElement("input");
        const panel = createPanel(inputEl2);
        const panelEl = panel.getElement();

        panelEl.appendChild(inputEl1);
        panelEl.appendChild(inputEl2);
        expect(document.activeElement).not.toBe(inputEl2);

        panel.show();
        expect(document.activeElement).toBe(inputEl2);
        panel.destroy();
      });

      it("focuses the entire panel item when no tabbable item is available and the panel is focusable", () => {
        const panel = createPanel();
        const panelEl = panel.getElement();

        spyOn(panelEl, "focus");
        panel.show();
        expect(panelEl.focus).toHaveBeenCalled();
        panel.destroy();
      });

      it("returns focus to the original activeElement", async () => {
        const panel = createPanel();
        const previousActiveElement = document.activeElement;
        const panelEl = panel.getElement();
        panelEl.appendChild(document.createElement("input"));

        panel.show();
        panel.hide();

        jasmine.useRealClock();
        await conditionPromise(() => document.activeElement === previousActiveElement);

        expect(document.activeElement).toBe(previousActiveElement);
      });
    });

    describe("restoreFocus", () => {
      let outsideEl;

      function createPanel(options = {}) {
        const panel = new Panel(
          { item: new TestPanelContainerItem(), visible: false, ...options },
          lumine.views,
        );
        container.addPanel(panel);
        const inputEl = document.createElement("input");
        panel.getElement().appendChild(inputEl);
        return [panel, inputEl];
      }

      beforeEach(() => {
        outsideEl = document.createElement("input");
        jasmineContent.appendChild(outsideEl);
        outsideEl.focus();
      });

      it("returns focus to the previously focused element when the panel hides", () => {
        const [panel, inputEl] = createPanel();

        panel.show();
        inputEl.focus();
        panel.hide();

        expect(document.activeElement).toBe(outsideEl);
      });

      it("returns focus to the element focused before the first modal in a chain", () => {
        const [panelA, inputA] = createPanel();
        const [panelB, inputB] = createPanel();

        panelA.show();
        inputA.focus();

        panelB.show(); // hides panelA
        inputB.focus();
        expect(panelA.isVisible()).toBe(false);

        panelB.hide();
        expect(document.activeElement).toBe(outsideEl);
      });

      it("does not steal focus when the user has already focused elsewhere", () => {
        const [panel, inputEl] = createPanel();
        const otherEl = document.createElement("input");
        jasmineContent.appendChild(otherEl);

        panel.show();
        inputEl.focus();
        otherEl.focus();
        panel.hide();

        expect(document.activeElement).toBe(otherEl);
      });

      it("does nothing when restoreFocus is disabled", () => {
        const [panel, inputEl] = createPanel({ restoreFocus: false });

        panel.show();
        inputEl.focus();
        panel.hide();

        expect(document.activeElement).not.toBe(outsideEl);
      });
    });
  });
});
