// The registry retains each contribution as authored. Separators belong to
// this presentation pass, so a disappearing package cannot leave an empty
// group or a separator behind in the next menu snapshot.
function menuLayout(items, { groupOrder, sortBy, sortItems, preserveUngrouped = false } = {}) {
  let rendered = items
    .filter((item) => item.visible !== false)
    .map((item) => {
      const copy = { ...item };
      if (Array.isArray(item.submenu)) {
        copy.submenu = menuLayout(item.submenu, { ...item, sortItems, preserveUngrouped });
      }
      delete copy.groupOrder;
      delete copy.sortBy;
      delete copy.group;
      delete copy.order;
      return { source: item, item: copy };
    });

  const compare = (left, right) => {
    const leftOrder = Number.isFinite(left.source.order) ? left.source.order : Infinity;
    const rightOrder = Number.isFinite(right.source.order) ? right.source.order : Infinity;
    if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
    return (left.item.label || "")
      .replace(/&/g, "")
      .localeCompare((right.item.label || "").replace(/&/g, ""));
  };

  if (Array.isArray(groupOrder) && groupOrder.length > 0) {
    const groups = new Map(groupOrder.map((name) => [name, []]));
    // An unclassified extension must never escape past File's close/quit
    // groups. Core places the extensions slot explicitly in its group order.
    if (!groups.has("extensions")) groups.set("extensions", []);
    const ungrouped = [];
    for (const entry of rendered) {
      if (entry.item.type === "separator") {
        if (preserveUngrouped) ungrouped.push(entry.item);
        continue;
      }
      if (entry.item.submenu?.length === 0 && !entry.item.role) continue;
      if (preserveUngrouped && !groups.has(entry.source.group)) {
        ungrouped.push(entry.item);
        continue;
      }
      const group = groups.get(entry.source.group) ?? groups.get("extensions");
      group.push(entry);
    }
    rendered = [];
    for (const [name, group] of groups) {
      let groupItems = group.sort(compare).map(({ item }) => item);
      if (sortItems) groupItems = sortItems(groupItems);
      if (name === "extensions" && ungrouped.length > 0) {
        const legacyItems = sortItems ? sortItems(ungrouped) : ungrouped;
        if (groupItems.length > 0 && legacyItems.length > 0) groupItems.push({ type: "separator" });
        groupItems.push(...legacyItems);
      }
      if (groupItems.length === 0) continue;
      if (rendered.length > 0) rendered.push({ item: { type: "separator" } });
      rendered.push(...groupItems.map((item) => ({ item })));
    }
  } else if (sortBy === "label") {
    // This is for a named list of surfaces, not an authored sequence of
    // operations or the dynamic Reopen Project history.
    rendered.sort(compare);
  } else if (sortItems) {
    rendered = sortItems(rendered.map(({ item }) => item)).map((item) => ({ item }));
  }

  const result = [];
  for (const { item } of rendered) {
    if (item.type === "separator") {
      if (result.length === 0 || result.at(-1).type === "separator") continue;
    }
    result.push(item);
  }
  if (result.at(-1)?.type === "separator") result.pop();
  return result;
}

module.exports = menuLayout;
