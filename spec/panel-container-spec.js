"use strict";

const Panel = require("../src/panel");
const PanelContainer = require("../src/panel-container");

describe("PanelContainer", () => {
  let container;

  class TestPanelItem {}

  beforeEach(() => {
    container = new PanelContainer({ viewRegistry: lumine.views });
  });

  describe("::addPanel(panel)", () => {
    it("emits an onDidAddPanel event with the index the panel was inserted at", () => {
      const addPanelSpy = jasmine.createSpy();
      container.onDidAddPanel(addPanelSpy);

      const panel1 = new Panel({ item: new TestPanelItem() }, lumine.views);
      container.addPanel(panel1);
      expect(addPanelSpy).toHaveBeenCalledWith({ panel: panel1, index: 0 });

      const panel2 = new Panel({ item: new TestPanelItem() }, lumine.views);
      container.addPanel(panel2);
      expect(addPanelSpy).toHaveBeenCalledWith({ panel: panel2, index: 1 });
    });

    it("moves one stable panel between containers without destroying it", () => {
      container.destroy();
      container = new PanelContainer({
        location: "modal",
        viewRegistry: lumine.views,
      });
      const destination = new PanelContainer({
        location: "modal",
        viewRegistry: lumine.views,
      });
      const panel = new Panel(
        { item: new TestPanelItem(), visible: false, surfaceRelocatable: true },
        lumine.views,
      );
      const removed = jasmine.createSpy("removed");
      const destroyed = jasmine.createSpy("destroyed");
      container.onDidRemovePanel(removed);
      panel.onDidDestroy(destroyed);

      container.addPanel(panel);
      destination.addPanel(panel);

      expect(container.getPanels()).toEqual([]);
      expect(destination.getPanels()).toEqual([panel]);
      expect(panel.getContainer()).toBe(destination);
      expect(removed).toHaveBeenCalledOnceWith({ panel, index: 0 });
      expect(destroyed).not.toHaveBeenCalled();

      container.addPanel(panel);
      expect(panel.getContainer()).toBe(container);
      destination.destroy();
      expect(destroyed).not.toHaveBeenCalled();

      panel.destroy();
    });

    it("rolls a visible transfer back when the destination rejects it", () => {
      container.destroy();
      container = new PanelContainer({ location: "modal", viewRegistry: lumine.views });
      const destination = new PanelContainer({ location: "modal", viewRegistry: lumine.views });
      const panel = new Panel(
        { item: new TestPanelItem(), visible: true, surfaceRelocatable: true },
        lumine.views,
      );
      const visibilityChanges = jasmine.createSpy("visibilityChanges");
      panel.onDidChangeVisible(visibilityChanges);
      container.addPanel(panel);
      destination.onDidAddPanel(() => {
        throw new Error("destination failed");
      });

      expect(() => destination.addPanel(panel)).toThrowError("destination failed");
      expect(container.getPanels()).toEqual([panel]);
      expect(destination.getPanels()).toEqual([]);
      expect(panel.getContainer()).toBe(container);
      expect(panel.isVisible()).toBe(true);
      expect(visibilityChanges).not.toHaveBeenCalled();

      destination.destroy();
    });

    it("does not allow a live stable panel to become ownerless", () => {
      const panel = new Panel(
        { item: new TestPanelItem(), visible: false, surfaceRelocatable: true },
        lumine.views,
      );
      container.addPanel(panel);

      expect(() => container.removePanel(panel)).toThrowError(/must move directly/);
      expect(panel.getContainer()).toBe(container);
      expect(container.getPanels()).toEqual([panel]);
    });

    it("rejects show on an unmounted panel", () => {
      const panel = new Panel({ item: new TestPanelItem(), visible: false }, lumine.views);
      expect(() => panel.show()).toThrowError(/not mounted in a live panel container/);
      panel.destroy();
    });
  });

  describe("when a panel is destroyed", () => {
    it("emits an onDidRemovePanel event with the index of the removed item", () => {
      const removePanelSpy = jasmine.createSpy();
      container.onDidRemovePanel(removePanelSpy);

      const panel1 = new Panel({ item: new TestPanelItem() }, lumine.views);
      container.addPanel(panel1);
      const panel2 = new Panel({ item: new TestPanelItem() }, lumine.views);
      container.addPanel(panel2);

      expect(removePanelSpy).not.toHaveBeenCalled();

      panel2.destroy();
      expect(removePanelSpy).toHaveBeenCalledWith({ panel: panel2, index: 1 });

      panel1.destroy();
      expect(removePanelSpy).toHaveBeenCalledWith({ panel: panel1, index: 0 });
    });
  });

  describe("::destroy()", () => {
    it("destroys the container and all of its panels", () => {
      const destroyedPanels = [];

      const panel1 = new Panel({ item: new TestPanelItem() }, lumine.views);
      panel1.onDidDestroy(() => {
        destroyedPanels.push(panel1);
      });
      container.addPanel(panel1);

      const panel2 = new Panel({ item: new TestPanelItem() }, lumine.views);
      panel2.onDidDestroy(() => {
        destroyedPanels.push(panel2);
      });
      container.addPanel(panel2);

      container.destroy();

      expect(container.getPanels().length).toBe(0);
      expect(destroyedPanels).toEqual([panel1, panel2]);
    });

    it("destroys relocatable panels with the primary container", () => {
      const panel = new Panel(
        { item: new TestPanelItem(), visible: false, surfaceRelocatable: true },
        lumine.views,
      );
      const destroyed = jasmine.createSpy("destroyed");
      panel.onDidDestroy(destroyed);
      container.addPanel(panel);

      container.destroy();

      expect(destroyed).toHaveBeenCalledOnceWith(panel);
      expect(panel.getContainer()).toBeNull();
    });
  });

  describe("panel priority", () => {
    describe("left / top panel container", () => {
      let initialPanel;
      beforeEach(() => {
        // 'left' logic is the same as 'top'
        container = new PanelContainer({ location: "left" });
        initialPanel = new Panel({ item: new TestPanelItem() }, lumine.views);
        container.addPanel(initialPanel);
      });

      describe("when a panel with low priority is added", () => {
        it("is inserted at the beginning of the list", () => {
          const addPanelSpy = jasmine.createSpy();
          container.onDidAddPanel(addPanelSpy);
          const panel = new Panel({ item: new TestPanelItem(), priority: 0 }, lumine.views);
          container.addPanel(panel);

          expect(addPanelSpy).toHaveBeenCalledWith({ panel, index: 0 });
          expect(container.getPanels()[0]).toBe(panel);
        });
      });

      describe("when a panel with priority between two other panels is added", () => {
        it("is inserted at the between the two panels", () => {
          const addPanelSpy = jasmine.createSpy();
          let panel = new Panel({ item: new TestPanelItem(), priority: 1000 }, lumine.views);
          container.addPanel(panel);

          container.onDidAddPanel(addPanelSpy);
          panel = new Panel({ item: new TestPanelItem(), priority: 101 }, lumine.views);
          container.addPanel(panel);

          expect(addPanelSpy).toHaveBeenCalledWith({ panel, index: 1 });
          expect(container.getPanels()[1]).toBe(panel);
        });
      });
    });

    describe("right / bottom panel container", () => {
      let initialPanel;
      beforeEach(() => {
        // 'bottom' logic is the same as 'right'
        container = new PanelContainer({ location: "right" });
        initialPanel = new Panel({ item: new TestPanelItem() }, lumine.views);
        container.addPanel(initialPanel);
      });

      describe("when a panel with high priority is added", () => {
        it("is inserted at the beginning of the list", () => {
          const addPanelSpy = jasmine.createSpy();
          container.onDidAddPanel(addPanelSpy);
          const panel = new Panel({ item: new TestPanelItem(), priority: 1000 }, lumine.views);
          container.addPanel(panel);

          expect(addPanelSpy).toHaveBeenCalledWith({ panel, index: 0 });
          expect(container.getPanels()[0]).toBe(panel);
        });
      });

      describe("when a panel with low priority is added", () => {
        it("is inserted at the end of the list", () => {
          const addPanelSpy = jasmine.createSpy();
          container.onDidAddPanel(addPanelSpy);
          const panel = new Panel({ item: new TestPanelItem(), priority: 0 }, lumine.views);
          container.addPanel(panel);

          expect(addPanelSpy).toHaveBeenCalledWith({ panel, index: 1 });
          expect(container.getPanels()[1]).toBe(panel);
        });
      });
    });
  });
});
