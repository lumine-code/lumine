const Pane = require("./pane");
const PaneAxis = require("./pane-axis");

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
  const items = [...selected].flatMap((pane) => pane.getItems());
  const preparations = [];
  for (const item of items)
    preparations.push({ item, state: await item.prepareWindowChange?.(context) });
  if (
    source.isDestroyed() ||
    target.isDestroyed() ||
    source.getRoot() !== sourceRoot ||
    target.getRoot() !== targetRoot ||
    [...selected].some((pane) => pane.isDestroyed() || pane.getContainer() !== source) ||
    items.some(
      (item) =>
        item.isDestroyed?.() || ![...selected].some((pane) => pane.getItems().includes(item)),
    )
  )
    throw new Error("The pane changed while its window transfer was being prepared.");
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
  try {
    source.transactActiveState(() => {
      for (const pane of selected) pane.setContainer(target, { transferred: true });
      sourceReplacement = restore(remainingLayout, source);
      targetReplacement = restore(destinationLayout, target);
      source.setRoot(sourceReplacement);
      target.setRoot(targetReplacement);
      if (!source.getPanes().includes(source.getActivePane()))
        source.didActivatePane(source.getPanes()[0]);
      target.didActivatePane(selected.has(originalActive) ? originalActive : [...selected][0]);
    });
    for (const { item, state } of preparations) await item.didChangeWindow?.({ ...context, state });
    committed = true;
    for (const pane of selected) pane.emitter.emit("did-change-window", context);
    workspace.emitter.emit("did-transfer-pane-layout", {
      sourceWindow,
      targetWindow,
      panes: [...selected],
    });
  } finally {
    if (
      !committed &&
      (sourceReplacement || [...selected].some((pane) => pane.getContainer() !== source))
    ) {
      source.transactActiveState(() => {
        for (const pane of selected) pane.setContainer(source, { transferred: true });
        source.setRoot(restore(sourceLayout, source));
        target.setRoot(restore(targetLayout, target));
        source.didActivatePane(originalActive);
        if (!target.getPanes().includes(target.getActivePane()))
          target.didActivatePane(target.getPanes()[0]);
      });
      for (const { item, state } of preparations)
        await item.didChangeWindow?.({
          sourceWindow: targetWindow,
          targetWindow: sourceWindow,
          state,
          rollback: true,
        });
    }
    releaseAxes([sourceRoot, targetRoot, sourceReplacement, targetReplacement].filter(Boolean), [
      source.getRoot(),
      target.getRoot(),
    ]);
    if (committed && targetEmpty) {
      targetRoot.container = null;
      targetRoot.setParent(null);
      targetRoot.destroy();
    }
  }
  return targetWindow;
};
