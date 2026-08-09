describe("modal flow", () => {
  let workspaceElement;
  let panels;

  beforeEach(() => {
    workspaceElement = lumine.workspace.getElement();
    jasmine.attachToDOM(workspaceElement);
    panels = [];
  });

  afterEach(() => {
    for (const panel of panels) panel.destroy();
  });

  function addModal(options = {}) {
    const item = document.createElement("div");
    const panel = lumine.workspace.addModalPanel({ item, visible: false, ...options });
    panels.push(panel);
    return panel;
  }

  function strip() {
    return workspaceElement.querySelector(".modal-breadcrumbs");
  }

  function stripLabels() {
    return Array.from(strip()?.querySelectorAll(".modal-breadcrumb") ?? [], (el) => el.textContent);
  }

  describe("Panel::show with a crumb", () => {
    it("adopts the visible modal as the trail root and shows the step", () => {
      const root = addModal({ crumb: "Branches" });
      const step = addModal();
      root.show();

      step.show({ crumb: "Create from" });

      expect(root.isVisible()).toBe(false);
      expect(step.isVisible()).toBe(true);
      expect(lumine.workspace.getModalTrail()).toEqual(["Branches", "Create from"]);
    });

    it("labels an adopted root without a declared crumb as Modal", () => {
      const root = addModal();
      const step = addModal();
      root.show();

      step.show({ crumb: "Details" });

      expect(lumine.workspace.getModalTrail()).toEqual(["Modal", "Details"]);
    });

    it("uses the declared crumb when the option is true", () => {
      const root = addModal({ crumb: "Servers" });
      const step = addModal({ crumb: "Actions" });
      root.show();

      step.show({ crumb: true });

      expect(lumine.workspace.getModalTrail()).toEqual(["Servers", "Actions"]);
    });

    it("starts a single-entry trail when no modal is visible", () => {
      const panel = addModal();

      panel.show({ crumb: "Alone" });

      expect(panel.isVisible()).toBe(true);
      expect(lumine.workspace.getModalTrail()).toEqual(["Alone"]);
      expect(strip()?.style.display ?? "none").toBe("none");
    });

    it("marks the parent's hide as a flow transition", () => {
      const root = addModal({ crumb: "Root" });
      const step = addModal();
      root.show();

      let flagDuringHide = null;
      root.onDidChangeVisible((visible) => {
        if (!visible) flagDuringHide = root.flowTransition;
      });

      step.show({ crumb: "Step" });

      expect(flagDuringHide).toBe(true);
      expect(root.flowTransition).toBe(false);
    });

    it("rejects unknown options and non-modal usage", () => {
      const modal = addModal();
      expect(() => modal.show({ crumbs: "typo" })).toThrowError(/unknown option "crumbs"/);
      expect(() => modal.show({ crumb: 5 })).toThrowError(/string or true/);

      const item = document.createElement("div");
      const left = lumine.workspace.addLeftPanel({ item, visible: false });
      panels.push(left);
      expect(() => left.show({ crumb: "Nope" })).toThrowError(/only supported on modal panels/);
      expect(() =>
        lumine.workspace.addLeftPanel({ item, visible: false, crumb: "Nope" }),
      ).toThrow();
    });
  });

  describe("going back", () => {
    it("pops one step, re-shows the parent, and keeps earlier labels", () => {
      const root = addModal({ crumb: "Branches" });
      const step = addModal();
      root.show();
      step.show({ crumb: "Create from" });

      expect(lumine.workspace.popModal()).toBe(true);

      expect(step.isVisible()).toBe(false);
      expect(root.isVisible()).toBe(true);
      expect(lumine.workspace.getModalTrail()).toEqual(["Branches"]);
    });

    it("returns false when there is nothing to go back to", () => {
      expect(lumine.workspace.popModal()).toBe(false);

      const panel = addModal();
      panel.show({ crumb: "Alone" });
      expect(lumine.workspace.popModal()).toBe(false);
      expect(panel.isVisible()).toBe(true);
    });

    it("does not fire a cancel-style hide on the popped step", () => {
      const root = addModal({ crumb: "Root" });
      const step = addModal();
      root.show();
      step.show({ crumb: "Step" });

      let flagDuringHide = null;
      step.onDidChangeVisible((visible) => {
        if (!visible) flagDuringHide = step.flowTransition;
      });

      lumine.workspace.popModal();
      expect(flagDuringHide).toBe(true);
      expect(step.flowTransition).toBe(false);
    });

    it("jumps to an earlier step through popModalTo", () => {
      const root = addModal({ crumb: "One" });
      const second = addModal();
      const third = addModal();
      root.show();
      second.show({ crumb: "Two" });
      third.show({ crumb: "Three" });

      expect(lumine.workspace.popModalTo(0)).toBe(true);

      expect(third.isVisible()).toBe(false);
      expect(second.isVisible()).toBe(false);
      expect(root.isVisible()).toBe(true);
      expect(lumine.workspace.getModalTrail()).toEqual(["One"]);
    });

    it("rejects popModalTo targets that are not earlier steps", () => {
      const root = addModal({ crumb: "One" });
      const second = addModal();
      root.show();
      second.show({ crumb: "Two" });

      expect(lumine.workspace.popModalTo(1)).toBe(false);
      expect(lumine.workspace.popModalTo(5)).toBe(false);
      expect(lumine.workspace.popModalTo(-1)).toBe(false);
      expect(lumine.workspace.getModalTrail()).toEqual(["One", "Two"]);
    });

    it("is dispatched by the modal:go-back command", () => {
      const root = addModal({ crumb: "Root" });
      const step = addModal();
      root.show();
      step.show({ crumb: "Step" });

      lumine.commands.dispatch(workspaceElement, "modal:go-back");

      expect(root.isVisible()).toBe(true);
      expect(lumine.workspace.getModalTrail()).toEqual(["Root"]);
    });
  });

  describe("trail teardown", () => {
    it("clears when the top step is hidden by its owner", () => {
      const root = addModal({ crumb: "Root" });
      const step = addModal();
      root.show();
      step.show({ crumb: "Step" });

      step.hide();

      expect(lumine.workspace.getModalTrail()).toEqual([]);
      expect(root.isVisible()).toBe(false);
      expect(strip().style.display).toBe("none");
    });

    it("clears when an unrelated modal takes over", () => {
      const root = addModal({ crumb: "Root" });
      const step = addModal();
      const unrelated = addModal();
      root.show();
      step.show({ crumb: "Step" });
      expect(lumine.workspace.getModalTrail()).toEqual(["Root", "Step"]);

      unrelated.show();

      expect(step.isVisible()).toBe(false);
      expect(lumine.workspace.getModalTrail()).toEqual([]);
    });

    it("clears when any panel of the trail is destroyed", () => {
      const root = addModal({ crumb: "Root" });
      const step = addModal();
      root.show();
      step.show({ crumb: "Step" });

      root.destroy();

      expect(lumine.workspace.getModalTrail()).toEqual([]);
    });

    it("reports changes through onDidChangeModalTrail", () => {
      const trails = [];
      const subscription = lumine.workspace.onDidChangeModalTrail((trail) => trails.push(trail));
      const root = addModal({ crumb: "Root" });
      const step = addModal();
      root.show();

      step.show({ crumb: "Step" });
      lumine.workspace.popModal();
      root.hide();

      expect(trails).toEqual([["Root", "Step"], ["Root"], []]);
      subscription.dispose();
    });
  });

  describe("breadcrumb strip", () => {
    it("appears at depth two with the current step marked", () => {
      const root = addModal({ crumb: "Branches" });
      const step = addModal();
      root.show();
      expect(strip()?.style.display ?? "none").toBe("none");

      step.show({ crumb: "Create from" });

      expect(strip().style.display).toBe("");
      expect(stripLabels()).toEqual(["Branches", "Create from"]);
      const crumbs = strip().querySelectorAll(".modal-breadcrumb");
      expect(crumbs[1].classList.contains("current")).toBe(true);
      expect(crumbs[0].classList.contains("current")).toBe(false);
    });

    it("navigates back when an earlier crumb is clicked, without stealing focus", () => {
      const root = addModal({ crumb: "One" });
      const second = addModal();
      const third = addModal();
      root.show();
      second.show({ crumb: "Two" });
      third.show({ crumb: "Three" });

      const crumb = strip().querySelectorAll(".modal-breadcrumb")[0];
      const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      crumb.dispatchEvent(mousedown);
      expect(mousedown.defaultPrevented).toBe(true);

      crumb.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(root.isVisible()).toBe(true);
      expect(lumine.workspace.getModalTrail()).toEqual(["One"]);
    });
  });

  describe("appear-animation settling", () => {
    let style;

    beforeEach(() => {
      // Stand-in for a theme's modal-appear animation and a content spinner.
      // Long durations keep them observably "running" unless settled.
      style = document.createElement("style");
      style.textContent = `
        @keyframes flow-spec-appear { from { opacity: 0.99; } to { opacity: 1; } }
        lumine-panel.modal { animation: flow-spec-appear 60s linear; }
        .flow-spec-spinner { animation: flow-spec-appear 60s linear infinite; }
      `;
      document.head.appendChild(style);
    });

    afterEach(() => {
      style.remove();
    });

    function runningPanelAnimations(panel) {
      const element = panel.getElement();
      return element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.target === element)
        .filter((animation) => animation.playState === "running");
    }

    it("keeps the appear animation on a fresh show and settles it on switches", () => {
      const root = addModal({ crumb: "Root" });
      const step = addModal();

      root.show();
      expect(runningPanelAnimations(root).length).toBeGreaterThan(0);

      step.show({ crumb: "Step" });
      expect(runningPanelAnimations(step).length).toBe(0);

      expect(lumine.workspace.popModal()).toBe(true);
      expect(runningPanelAnimations(root).length).toBe(0);
    });

    it("leaves animations inside the content running across a switch", () => {
      const root = addModal({ crumb: "Root" });
      const item = document.createElement("div");
      const spinner = document.createElement("div");
      spinner.classList.add("flow-spec-spinner");
      item.appendChild(spinner);
      const step = lumine.workspace.addModalPanel({ item, visible: false });
      panels.push(step);

      root.show();
      step.show({ crumb: "Step" });

      expect(runningPanelAnimations(step).length).toBe(0);
      const spinning = spinner.getAnimations().filter((a) => a.playState === "running");
      expect(spinning.length).toBe(1);
    });
  });

  describe("focus restoration across a flow", () => {
    it("returns focus to the pre-flow element after the flow ends", () => {
      const outside = document.createElement("input");
      jasmine.attachToDOM(outside);
      outside.focus();
      expect(document.activeElement).toBe(outside);

      const root = addModal({ crumb: "Root" });
      const stepItem = document.createElement("div");
      const inside = document.createElement("input");
      stepItem.appendChild(inside);
      const step = lumine.workspace.addModalPanel({ item: stepItem, visible: false });
      panels.push(step);

      root.show();
      step.show({ crumb: "Step" });
      inside.focus();
      expect(document.activeElement).toBe(inside);

      step.hide();

      expect(lumine.workspace.getModalTrail()).toEqual([]);
      expect(document.activeElement).toBe(outside);
    });
  });
});
