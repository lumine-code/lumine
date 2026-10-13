// UTILS

function splitArray(arr, predicate) {
  let lastArr = [];
  const multiArr = [lastArr];
  arr.forEach((item) => {
    if (predicate(item)) {
      if (lastArr.length > 0) {
        lastArr = [];
        multiArr.push(lastArr);
      }
    } else {
      lastArr.push(item);
    }
  });
  return multiArr;
}

function joinArrays(arrays, joiner) {
  const joinedArr = [];
  arrays.forEach((arr, i) => {
    if (i > 0 && arr.length > 0) {
      joinedArr.push(joiner);
    }
    joinedArr.push(...arr);
  });
  return joinedArr;
}

const pushOntoMultiMap = (map, key, value) => {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
};

// Strings name commands; an explicit id reference also reaches commandless
// items such as submenu parents without making their labels positioning keys.
function targetForReference(reference) {
  if (typeof reference === "string") return { key: "command", value: reference };
  if (reference != null && typeof reference.id === "string") {
    return { key: "id", value: reference.id };
  }
  return null;
}

function indexOfGroupContainingReference(groups, reference, ignoreGroup) {
  const target = targetForReference(reference);
  if (target == null) return -1;
  return groups.findIndex(
    (candidateGroup) =>
      candidateGroup !== ignoreGroup &&
      candidateGroup.some((candidateItem) => candidateItem[target.key] === target.value),
  );
}

// Sort nodes topologically using a depth-first approach. Encountered cycles
// are broken.
function sortTopologically(originalOrder, edgesById) {
  const sorted = [];
  const marked = new Set();

  function visit(id) {
    if (marked.has(id)) {
      // Either this node has already been placed, or we have encountered a
      // cycle and need to exit.
      return;
    }
    marked.add(id);
    const edges = edgesById.get(id);
    if (edges != null) {
      edges.forEach(visit);
    }
    sorted.push(id);
  }

  originalOrder.forEach(visit);
  return sorted;
}

function attemptToMergeAGroup(groups) {
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    for (const item of group) {
      const references = [...(item.before || []), ...(item.after || [])];
      for (const reference of references) {
        const index = indexOfGroupContainingReference(groups, reference, group);
        if (index === -1) {
          // No valid edge for this reference
          continue;
        }
        const mergeTarget = groups[index];
        // Merge with the group containing the referenced item.
        mergeTarget.push(...group);
        groups.splice(i, 1);
        return true;
      }
    }
  }
  return false;
}

// Merge groups based on before/after positions
// Mutates both the array of groups, and the individual group arrays.
function mergeGroups(groups) {
  let mergedAGroup = true;
  while (mergedAGroup) {
    mergedAGroup = attemptToMergeAGroup(groups);
  }
  return groups;
}

function sortItemsInGroup(group) {
  const originalOrder = group.map((node, i) => i);
  const edges = new Map();
  const indexes = {
    command: new Map(group.map((item, i) => [item.command, i])),
    id: new Map(group.map((item, i) => [item.id, i])),
  };
  const indexForReference = (reference) => {
    const target = targetForReference(reference);
    return target == null ? undefined : indexes[target.key].get(target.value);
  };

  group.forEach((item, i) => {
    if (item.before) {
      item.before.forEach((reference) => {
        const to = indexForReference(reference);
        if (to != null) {
          pushOntoMultiMap(edges, to, i);
        }
      });
    }
    if (item.after) {
      item.after.forEach((reference) => {
        const to = indexForReference(reference);
        if (to != null) {
          pushOntoMultiMap(edges, i, to);
        }
      });
    }
  });

  const sortedNodes = sortTopologically(originalOrder, edges);

  return sortedNodes.map((i) => group[i]);
}

function findEdgesInGroup(groups, i, edges) {
  const group = groups[i];
  for (const item of group) {
    if (item.beforeGroupContaining) {
      for (const reference of item.beforeGroupContaining) {
        const to = indexOfGroupContainingReference(groups, reference, group);
        if (to !== -1) {
          pushOntoMultiMap(edges, to, i);
          return;
        }
      }
    }
    if (item.afterGroupContaining) {
      for (const reference of item.afterGroupContaining) {
        const to = indexOfGroupContainingReference(groups, reference, group);
        if (to !== -1) {
          pushOntoMultiMap(edges, i, to);
          return;
        }
      }
    }
  }
}

function sortGroups(groups) {
  const originalOrder = groups.map((item, i) => i);
  const edges = new Map();

  for (let i = 0; i < groups.length; i++) {
    findEdgesInGroup(groups, i, edges);
  }

  const sortedGroupIndexes = sortTopologically(originalOrder, edges);
  return sortedGroupIndexes.map((i) => groups[i]);
}

function isSeparator(item) {
  return item.type === "separator";
}

function sortMenuItems(menuItems) {
  // Split the items into their implicit groups based upon separators.
  const groups = splitArray(menuItems, isSeparator);
  // Merge groups that contain before/after references to eachother.
  const mergedGroups = mergeGroups(groups);
  // Sort each individual group internally.
  const mergedGroupsWithSortedItems = mergedGroups.map(sortItemsInGroup);
  // Sort the groups based upon their beforeGroupContaining/afterGroupContaining
  // references.
  const sortedGroups = sortGroups(mergedGroupsWithSortedItems);
  // Join the groups back
  return joinArrays(sortedGroups, { type: "separator" });
}

module.exports = { sortMenuItems };
