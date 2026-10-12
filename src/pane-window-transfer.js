const Pane = require("./pane");
const PaneAxis = require("./pane-axis");
const {
  awaitLifecycleCleanup,
  captureLifecycleError,
  throwLifecycleErrors,
} = require("./package-lifecycle-errors");

function snapshot(node) {
  if (node instanceof Pane) return { pane: node };
  return {
    orientation: node.getOrientation(),
    flexScale: node.getFlexScale(),
    children: node.getChildren().map(snapshot),
  };
}

function without(layout, removed) {
  if (layout.pane) return removed.has(layout.pane) ? null : layout;
  const children = layout.children.map((child) => without(child, removed)).filter(Boolean);
  if (!children.length) return null;
  return children.length === 1 ? children[0] : { ...layout, children };
}

function restore(layout, container) {
  if (!layout) return new Pane({ ...container.workspace.getCenter().params, container });
  if (layout.pane) return layout.pane;
  return new PaneAxis(
    {
      orientation: layout.orientation,
      flexScale: layout.flexScale,
      children: layout.children.map((child) => restore(child, container)),
    },
    container.viewRegistry,
  );
}

function axes(node, found = new Set()) {
  if (node instanceof PaneAxis) {
    found.add(node);
    for (const child of node.getChildren()) axes(child, found);
  }
  return found;
}

function releaseAxes(nodes, liveRoots) {
  const live = new Set(liveRoots.flatMap((root) => [...axes(root)]));
  const obsolete = new Set(
    nodes.flatMap((root) => [...axes(root)]).filter((axis) => !live.has(axis)),
  );
  for (const axis of obsolete) axis.subscriptions.dispose();
  for (const axis of obsolete) axis.destroy();
}

function bindItemViews(workspace, panes, window) {
  if (!window) return;
  const document = window.getDocument();
  for (const pane of panes)
    for (const item of pane.getItems()) {
      const view = workspace.viewRegistry.getView(item);
      if (view.ownerDocument !== document) document.adoptNode(view);
      workspace.viewRegistry.didAttachPaneItem(item, pane, view);
    }
}

// Geometry is rebuilt; Pane and item identities, document leases and package
// generations survive. Providers explicitly restore state of embedded views
// whose browsing contexts are recreated by cross-document DOM adoption.
module.exports = async function transferPaneLayout(workspace, source, target, panes) {
  if (source === target || source.getLocation() !== "center" || target.getLocation() !== "center")
    throw new Error("Window transfers require distinct document containers.");
  const sourceRoot = source.getRoot();
  const targetRoot = target.getRoot();
  const selected = new Set(panes);
  if (!selected.size || [...selected].some((pane) => !source.getPanes().includes(pane)))
    throw new Error("The source pane is no longer available.");
  const sourceLayout = snapshot(sourceRoot);
  const targetLayout = snapshot(targetRoot);
  const sourceWindow = source.getWindow();
  const targetWindow = target.getWindow();
  const context = { sourceWindow, targetWindow };
  const paneItems = new Map([...selected].map((pane) => [pane, pane.getItems()]));
  const items = [...selected].flatMap((pane) => pane.getItems());
  const preparations = [];
  try {
    for (const item of items) {
      workspace.viewRegistry.getView(item);
      preparations.push({ item, state: await item.prepareWindowChange?.(context) });
    }
    if (
      source.isDestroyed() ||
      target.isDestroyed() ||
      sourceWindow?.windowService.closed ||
      targetWindow?.windowService.closed ||
      source.getRoot() !== sourceRoot ||
      target.getRoot() !== targetRoot ||
      [...selected].some(
        (pane) =>
          pane.isDestroyed() ||
          pane.getContainer() !== source ||
          pane.getItems().length !== paneItems.get(pane).length ||
          pane.getItems().some((item, index) => item !== paneItems.get(pane)[index]),
      ) ||
      items.some((item) => item.isDestroyed?.())
    )
      throw new Error("The pane changed while its window transfer was being prepared.");
  } catch (error) {
    const errors = [error];
    for (const { item, state } of preparations.reverse()) {
      await awaitLifecycleCleanup(errors, () => item.cancelWindowChange?.({ ...context, state }));
      captureLifecycleError(errors, () => {
        if (typeof state?.dispose === "function") state.dispose();
      });
    }
    throwLifecycleErrors(
      errors,
      "Unable to prepare a window transfer and release its preparations.",
    );
  }
  const movedLayout = without(
    sourceLayout,
    new Set(source.getPanes().filter((pane) => !selected.has(pane))),
  );
  const remainingLayout = without(sourceLayout, selected);
  const targetEmpty = targetRoot instanceof Pane && targetRoot.getItems().length === 0;
  const destinationLayout = targetEmpty
    ? movedLayout
    : {
        orientation: "horizontal",
        flexScale: 1,
        children: [targetLayout, movedLayout],
      };
  const originalActive = source.getActivePane();
  let sourceReplacement;
  let targetReplacement;
  let committed = false;
  const failures = [];
  try {
    workspace.runWindowMutation(() =>
      source.transactActiveState(() => {
        for (const pane of selected) pane.setContainer(target, { transferred: true });
        sourceReplacement = restore(remainingLayout, source);
        targetReplacement = restore(destinationLayout, target);
        source.setRoot(sourceReplacement);
        target.setRoot(targetReplacement);
        if (!source.getPanes().includes(source.getActivePane()))
          source.didActivatePane(source.getPanes()[0]);
        target.didActivatePane(selected.has(originalActive) ? originalActive : [...selected][0]);
      }),
    );
    bindItemViews(workspace, selected, targetWindow);
    for (const { item, state } of preparations) await item.didChangeWindow?.({ ...context, state });
    if (target.isDestroyed() || targetWindow?.windowService.closed)
      throw new Error("The destination window closed before its presentation was committed.");
    committed = true;
    for (const pane of selected) pane.emitter.emit("did-change-window", context);
    workspace.emitter.emit("did-transfer-pane-layout", {
      sourceWindow,
      targetWindow,
      panes: [...selected],
    });
  } catch (error) {
    failures.push(error);
  } finally {
    if (
      !committed &&
      (sourceReplacement || [...selected].some((pane) => pane.getContainer() !== source))
    ) {
      captureLifecycleError(failures, () =>
        workspace.runWindowMutation(() =>
          source.transactActiveState(() => {
            for (const pane of selected) pane.setContainer(source, { transferred: true });
            source.setRoot(restore(sourceLayout, source));
            target.setRoot(restore(targetLayout, target));
            source.didActivatePane(originalActive);
            if (!target.getPanes().includes(target.getActivePane()))
              target.didActivatePane(target.getPanes()[0]);
          }),
        ),
      );
      captureLifecycleError(failures, () => bindItemViews(workspace, selected, sourceWindow));
      for (const { item, state } of preparations)
        await awaitLifecycleCleanup(failures, () =>
          item.didChangeWindow?.({
            sourceWindow: targetWindow,
            targetWindow: sourceWindow,
            state,
            rollback: true,
          }),
        );
    }
    captureLifecycleError(failures, () =>
      releaseAxes([sourceRoot, targetRoot, sourceReplacement, targetReplacement].filter(Boolean), [
        source.getRoot(),
        target.getRoot(),
      ]),
    );
    if (committed && targetEmpty) {
      captureLifecycleError(failures, () => {
        targetRoot.container = null;
        targetRoot.setParent(null);
        targetRoot.destroy();
      });
    }
    const livePanes = new Set([...source.getPanes(), ...target.getPanes()]);
    for (const pane of [sourceRoot, targetRoot, sourceReplacement, targetReplacement]) {
      if (pane instanceof Pane && !livePanes.has(pane) && !pane.getItems().length && pane.isAlive())
        captureLifecycleError(failures, () => {
          pane.container = null;
          pane.setParent(null);
          pane.destroy();
        });
    }
    for (const { state } of preparations)
      captureLifecycleError(failures, () => {
        if (typeof state?.dispose === "function") state.dispose();
      });
  }
  throwLifecycleErrors(
    failures,
    "Unable to transfer the pane layout and release its presentation state.",
  );
  return targetWindow;
};
