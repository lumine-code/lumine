module.exports = async function installPresentationBenchmark(_config) {
  const { ipcRenderer } = require("electron");
  const channel = "lumine:presentation-benchmark";
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const methodNow = () => Number(process.hrtime.bigint()) / 1e6;
  const frame = () =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Visible animation frame timed out")),
        2500,
      );
      requestAnimationFrame((time) => {
        clearTimeout(timeout);
        resolve(time);
      });
    });
  const marker = document.createElement("div");
  marker.style.cssText =
    "position:fixed;left:2px;top:2px;width:12px;height:12px;z-index:2147483647;pointer-events:none;opacity:1;";
  document.body.append(marker);
  const setMarker = (revision) => {
    marker.style.backgroundColor = `rgb(${revision >> 8},${revision & 255},197)`;
  };
  setMarker(0);
  lumine.config.set("editor.fontFamily", "Consolas");
  lumine.config.set("editor.fontSize", 14);
  lumine.config.set("editor.lineHeight", 1.5);
  lumine.config.set("editor.softWrap", false);
  lumine.config.set("editor.showIndentGuide", false);
  lumine.config.set("editor.autoIndent", false);
  lumine.config.set("editor.scrollSensitivity", 40);
  lumine.config.set("editor.cursorBlinkPeriod", 0);
  for (const name of [
    "language-text",
    "language-javascript",
    "language-html",
    "language-vue",
    "language-ipython",
    "language-python",
    "language-css",
    "language-shellscript",
    "language-sql",
    "language-gfm",
    "language-json",
  ]) {
    await lumine.packages.activatePackage(name);
  }
  const editor = await lumine.workspace.open();
  const element = lumine.views.getView(editor);
  const component = element.component;
  let active = null;
  let cpuDepth = 0;
  let currentFixture = null;
  const restores = [];
  const longTasks = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      longTasks.push({ start: entry.startTime, durationMs: entry.duration });
  });
  observer.observe({ entryTypes: ["longtask"] });
  function acknowledge() {
    if (!active || active.acknowledged) return;
    const changed =
      active.kind === "scroll"
        ? Math.abs(component.getScrollTop() - active.beforeScroll) > 1
        : active.changed;
    if (!changed) return;
    if (editor.getText() !== active.expectedText) return;
    if (active.kind === "scroll" && !active.wheelReceived) return;
    if (active.kind !== "scroll") {
      const row = editor.getCursorScreenPosition().row;
      const line = editor.screenLineForScreenRow(row).lineText;
      // Confirm the actual visible editor DOM contains the current model line.
      if (
        element.querySelector(`.line[data-screen-row="${row}"]:not([data-off-screen])`)
          ?.textContent !== line
      )
        return;
    }
    active.acknowledged = true;
    active.domAcknowledgedAt = performance.now();
    setMarker(active.revision);
    ipcRenderer.send(channel, {
      type: "ack",
      revision: active.revision,
      domAcknowledgedAt: active.domAcknowledgedAt,
    });
  }
  function wrap(object, name, after) {
    const original = object[name];
    object[name] = function (...args) {
      const measured = active;
      const started = methodNow();
      const outermost = cpuDepth++ === 0;
      try {
        return original.apply(this, args);
      } finally {
        cpuDepth--;
        if (outermost && measured && measured === active)
          measured.updateCpuMs += methodNow() - started;
        after?.();
      }
    };
    restores.push(() => {
      object[name] = original;
    });
  }
  wrap(component, "updateSyncBeforeMeasuringContent");
  wrap(component, "measureContentDuringUpdateSync");
  wrap(component, "updateSyncAfterMeasuringContent", acknowledge);
  wrap(component, "updateScrollAnimationFrame", acknowledge);
  // Keep the native Ctrl-V/command route but give only this benchmark editor
  // an in-memory clipboard. The user's system clipboard is never replaced.
  const pasteOriginal = component.pasteText;
  component.pasteText = function (options, commandEvent) {
    if (active?.kind !== "paste") return pasteOriginal.call(this, options, commandEvent);
    const text = active.pasteText;
    return pasteOriginal.call(
      this,
      { ...options, skipPasteProviders: true, clipboard: { readWithMetadata: () => ({ text }) } },
      null,
    );
  };
  restores.push(() => {
    component.pasteText = pasteOriginal;
  });
  // A model operation includes the editor's synchronous input work. It is
  // reported separately from component CPU (they can overlap).
  for (const name of ["insertText", "pasteText", "undo"]) {
    const original = editor[name];
    editor[name] = function (...args) {
      const measured = active;
      const started = methodNow();
      try {
        return original.apply(this, args);
      } finally {
        if (measured && measured === active) measured.modelOperationCpuMs += methodNow() - started;
      }
    };
    restores.push(() => {
      editor[name] = original;
    });
  }
  const changedSubscription = editor.getBuffer().onDidChangeText(() => {
    if (active) active.changed = true;
  });
  const didInput = (event) => {
    if (!active) return;
    active.inputReceived = true;
    active.trustedInput = event.isTrusted;
    if (event.type === "wheel") active.wheelReceived = true;
  };
  element.addEventListener("keydown", didInput, true);
  element.addEventListener("wheel", didInput, true);
  const didLoseVisibility = () => {
    if (active && (document.visibilityState !== "visible" || !document.hasFocus()))
      active.visibilityLost = true;
  };
  document.addEventListener("visibilitychange", didLoseVisibility);
  window.addEventListener("blur", didLoseVisibility);
  restores.push(() => {
    element.removeEventListener("keydown", didInput, true);
    element.removeEventListener("wheel", didInput, true);
    document.removeEventListener("visibilitychange", didLoseVisibility);
    window.removeEventListener("blur", didLoseVisibility);
  });
  async function settle() {
    await editor.getBuffer().getLanguageMode().atTransactionEnd?.();
    const deadline = performance.now() + 5000;
    while (component.scrollAnimator.isAnimating()) {
      if (performance.now() > deadline) throw new Error("Scroll animation did not settle");
      await frame();
    }
    await frame();
    await frame();
    await delay(20);
  }
  function fixture(kind) {
    if (kind === "plain")
      return {
        scope: "text.plain",
        row: 12,
        outsideRow: 10,
        text: Array.from(
          { length: 2000 },
          (_, i) => `Plain editor benchmark row ${i}: target_identifier`,
        ).join("\n"),
      };
    if (kind === "javascript")
      return {
        scope: "source.js",
        row: 12,
        outsideRow: 10,
        text: Array.from(
          { length: 2000 },
          (_, i) => `const value_${i} = { count: ${i}, label: "target_identifier" };`,
        ).join("\n"),
      };
    if (kind === "html")
      return {
        scope: "text.html.basic",
        row: 3,
        outsideRow: 0,
        text: Array.from(
          { length: 100 },
          (_, i) =>
            `<section data-id="${i}">outside_identifier</section>\n<script>\nconst value_${i} = 1;\n// target_identifier\n</script>\n<style>.item_${i} { color: red; }</style>`,
        ).join("\n"),
      };
    if (kind === "vue")
      return {
        scope: "text.html.vue",
        row: 8,
        outsideRow: 0,
        text: `<template>\n<div>outside_identifier {{ count }}</div>\n</template>\n<script>\nexport default {\n  data() { return { count: 1 }; },\n  methods: { increment() { this.count++; } }\n};\n// target_identifier\n${Array.from({ length: 1900 }, (_, i) => `const value_${i} = ${i};`).join("\n")}\n</script>\n<style scoped>\n.item { color: red; }\n</style>`,
      };
    if (kind !== "ipython") throw new Error(`Unknown fixture ${kind}`);
    return {
      scope: "source.python.ipy",
      row: 4,
      outsideRow: 0,
      text: Array.from(
        { length: 50 },
        (_, i) =>
          `# %% outside_identifier ${i}\n%%javascript\nconst value_${i} = ${i};\n// target_identifier\n// target_identifier\n\n# %%\nvalue_${i} = ${i}\n`,
      ).join("\n"),
    };
  }
  window.presentationBenchmark = {
    async load(kind) {
      active = null;
      const data = fixture(kind);
      currentFixture = data;
      editor.setText(data.text);
      const grammar = lumine.grammars.grammarForScopeName(data.scope);
      if (!grammar) throw new Error(`Missing grammar ${data.scope}`);
      editor.setGrammar(grammar);
      await settle();
      editor.setCursorBufferPosition([data.row, editor.lineTextForBufferRow(data.row).length]);
      component.setScrollTop(0);
      element.focus();
      await settle();
      return {
        ...data,
        text: undefined,
        bytes: editor.getText().length,
        corpusSha256: require("node:crypto")
          .createHash("sha256")
          .update(editor.getText())
          .digest("hex"),
        lines: editor.getLineCount(),
        grammar: editor.getGrammar().scopeName,
        injections:
          editor.getBuffer().getLanguageMode().injectionsMarkerLayer?.getMarkerCount() ?? 0,
      };
    },
    async prepare({ revision, kind, row, text }) {
      active = null;
      await settle();
      if (kind === "paste") editor.setText(currentFixture.text);
      let expectedText = editor.getText();
      if (kind !== "scroll") {
        editor.setCursorBufferPosition([row, editor.lineTextForBufferRow(row).length]);
        component.setScrollTop(0);
        if (kind === "undo") {
          editor.getBuffer().clearUndoStack();
          editor.insertText(text, { groupUndo: false });
        }
      }
      element.focus();
      await settle();
      const beforeText = editor.getText();
      if (kind === "typing" || kind === "paste") {
        const position = editor
          .getBuffer()
          .characterIndexForPosition(editor.getCursorBufferPosition());
        expectedText = beforeText.slice(0, position) + text + beforeText.slice(position);
      } else if (kind !== "undo") expectedText = beforeText;
      active = {
        revision,
        kind,
        row,
        changed: false,
        acknowledged: false,
        updateCpuMs: 0,
        modelOperationCpuMs: 0,
        startedAt: performance.now(),
        beforeScroll: component.getScrollTop(),
        beforeText,
        beforeRowLength: editor.lineTextForBufferRow(row).length,
        beforeCursorScreenRow: editor.getCursorScreenPosition().row,
        expectedText,
        pasteText: kind === "paste" ? text : undefined,
        longTasksStart: longTasks.length,
      };
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        beforeScroll: active.beforeScroll,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
      };
    },
    async finish() {
      const measured = active;
      await settle();
      const result = {
        ...measured,
        beforeText: undefined,
        expectedText: undefined,
        pasteText: undefined,
        longTasks: longTasks.slice(measured.longTasksStart),
        textChanged: measured.beforeText !== editor.getText(),
        expectedTextMatches: measured.expectedText === editor.getText(),
        afterRowLength: editor.lineTextForBufferRow(measured.row).length,
        afterCursorScreenRow: editor.getCursorScreenPosition().row,
        scrollAnimationIdle: !component.scrollAnimator.isAnimating(),
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        scrollDelta: component.getScrollTop() - measured.beforeScroll,
        settledAt: performance.now(),
        afterCursorScreenLineLength: editor.screenLineForScreenRow(
          editor.getCursorScreenPosition().row,
        ).lineText.length,
        renderDiagnostic: measured.acknowledged
          ? undefined
          : {
              rowLine: editor.lineTextForBufferRow(measured.row),
              cursor: editor.getCursorBufferPosition().toArray(),
              lines: [...element.querySelectorAll(".line")]
                .map((node) => ({ row: node.dataset.screenRow, text: node.textContent }))
                .slice(0, 20),
            },
      };
      active = null;
      return result;
    },
    async calibrate() {
      const times = [];
      for (let i = 60000; i < 60040; i++) {
        times.push(await frame());
        setMarker(i);
      }
      await frame();
      return times;
    },
    async dispose() {
      active = null;
      changedSubscription.dispose();
      restores.reverse().forEach((restore) => restore());
      observer.disconnect();
      marker.remove();
      // Finish the isolated window's ordinary unload while it is registered.
      // Forced app.exit alone lets beforeunload request state after native
      // teardown has already unregistered its IPC sender.
      editor.destroy();
      await lumine.prepareToUnloadEditorWindow();
      lumine.unloadEditorWindow();
      lumine.destroy();
      delete window.presentationBenchmark;
    },
  };
  const style = getComputedStyle(element);
  return {
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    devicePixelRatio,
    viewport: { width: innerWidth, height: innerHeight },
    font: { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight },
    marker: { x: 8, y: 8 },
    themes: lumine.themes.getActiveThemeNames(),
    themeConfig: lumine.config.get("core.theme"),
    smoothScrolling: lumine.config.get("editor.smoothScrolling"),
    wheelSmoothness: lumine.config.get("editor.wheelSmoothness"),
    softWrapped: editor.isSoftWrapped(),
    loadedNativeModules: Object.keys(require.cache).filter((file) => file.endsWith(".node")),
    timerMetadata: {
      methods: "process.hrtime.bigint()",
      domAndLongTasks: "performance.now()",
      animationFrames: "requestAnimationFrame timestamp",
      mainAcknowledgementAndCapture: "process.hrtime.bigint()",
    },
    activePackages: lumine.packages.getActivePackages().map(({ name }) => name),
  };
};
