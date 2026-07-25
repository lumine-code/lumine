const { Point } = require("atom");

const toG = function (indents, begin, depth, cursorMap) {
  let ptr = begin;
  let isStack = false;
  const activeDepths = new Set();

  const gs = [];
  const indentsLength = indents.length;
  while (ptr < indentsLength && depth <= indents[ptr]) {
    if (depth < indents[ptr]) {
      const r = toG(indents, ptr, depth + 1, cursorMap);
      if (r.guides[0] != null && r.guides[0].stack) {
        isStack = true;
      }
      for (const d of r.activeDepths) {
        activeDepths.add(d);
      }
      Array.prototype.push.apply(gs, r.guides);
      ({ ptr } = r);
    } else {
      const cursorLevels = cursorMap.get(ptr);
      if (cursorLevels !== undefined) {
        isStack = true;
        for (const level of cursorLevels) {
          activeDepths.add(Math.min(level + 1, depth));
        }
      }
      ptr++;
    }
  }
  if (depth !== 0) {
    gs.unshift({
      length: ptr - begin,
      point: new Point(begin, depth - 1),
      active: activeDepths.has(depth),
      stack: isStack,
    });
  }
  return { guides: gs, ptr, activeDepths };
};

const fillInNulls = function (indents) {
  const res = indents.reduceRight(
    function (acc, cur) {
      if (cur === null) {
        acc.r.unshift(acc.i);
        return { r: acc.r, i: acc.i };
      } else {
        acc.r.unshift(cur);
        return { r: acc.r, i: cur };
      }
    },
    { r: [], i: 0 },
  );
  return res.r;
};

const toGuides = function (indents, cursorPositions) {
  const ind = fillInNulls(
    indents.map(function (i) {
      if (i === null) {
        return null;
      } else {
        return Math.floor(i);
      }
    }),
  );
  // Build map: row -> all cursor levels (multiple cursors on same row stay separate)
  const cursorMap = new Map();
  for (const { row, level } of cursorPositions) {
    const existing = cursorMap.get(row);
    if (existing === undefined) {
      cursorMap.set(row, [level]);
    } else if (!existing.includes(level)) {
      existing.push(level);
    }
  }
  return toG(ind, 0, 0, cursorMap).guides;
};

const getVirtualIndent = function (getIndentFn, row, lastRow) {
  for (let i = row, end = lastRow, asc = row <= end; asc ? i <= end : i >= end; asc ? i++ : i--) {
    const ind = getIndentFn(i);
    if (ind !== null) {
      return ind;
    }
  }
  return 0;
};

const uniq = function (values) {
  if (values.length === 0) return [];
  const newVals = [values[0]];
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[i - 1]) {
      newVals.push(values[i]);
    }
  }
  return newVals;
};

const mergeCropped = function (guides, above, below, height) {
  const aboveActive = above.active;
  const aboveStack = above.stack;
  const belowActive = below.active;
  const belowStack = below.stack;

  guides.forEach(function (g) {
    const gCol = g.point.column;
    if (g.point.row === 0) {
      if (aboveActive.includes(gCol)) {
        g.active = true;
      }
      if (aboveStack.includes(gCol)) {
        g.stack = true;
      }
    }
    if (height < g.point.row + g.length) {
      if (belowActive.includes(gCol)) {
        g.active = true;
      }
      if (belowStack.includes(gCol)) {
        g.stack = true;
      }
    }
  });
  return guides;
};

const supportingIndents = function (visibleLast, lastRow, getIndentFn) {
  if (getIndentFn(visibleLast) !== null) {
    return [];
  }
  const indents = [];
  let count = visibleLast + 1;
  while (count <= lastRow) {
    const indent = getIndentFn(count);
    indents.push(indent);
    if (indent !== null) {
      break;
    }
    count++;
  }
  return indents;
};

const getGuides = function (visibleFrom, visibleTo, lastRow, cursorPositions, getIndentFn) {
  const visibleLast = Math.min(visibleTo, lastRow);
  const visibleIndents = range(visibleFrom, visibleLast, true).map(getIndentFn);
  const support = supportingIndents(visibleLast, lastRow, getIndentFn);
  const guides = toGuides(
    visibleIndents.concat(support),
    cursorPositions.map((c) => ({ row: c.row - visibleFrom, level: c.level })),
  );
  const above = statesAboveVisible(cursorPositions, visibleFrom - 1, getIndentFn, lastRow);
  const below = statesBelowVisible(cursorPositions, visibleLast + 1, getIndentFn, lastRow);
  return mergeCropped(guides, above, below, visibleLast - visibleFrom);
};

const statesInvisible = function (cursorPositions, start, getIndentFn, lastRow, isAbove) {
  if (isAbove ? start < 0 : lastRow < start) {
    return { stack: [], active: [] };
  }
  // Build level map for fast lookup: row -> all cursor levels
  const cursorLevelMap = new Map();
  for (const { row, level } of cursorPositions) {
    const existing = cursorLevelMap.get(row);
    if (existing === undefined) {
      cursorLevelMap.set(row, [level]);
    } else if (!existing.includes(level)) {
      existing.push(level);
    }
  }
  const cursorRows = cursorPositions.map((p) => p.row);
  const cursors = isAbove
    ? uniq(cursorRows.filter((r) => r <= start).sort()).reverse()
    : uniq(cursorRows.filter((r) => start <= r).sort());
  const active = [];
  let stack = [];
  let minIndent = Number.MAX_VALUE;
  const loopRange = isAbove ? range(start, 0, true) : range(start, lastRow, true);
  for (let i of loopRange) {
    const ind = getIndentFn(i);
    if (ind !== null) {
      minIndent = Math.min(minIndent, ind);
    }
    if (cursors.length === 0 || minIndent === 0) {
      break;
    }
    if (cursors[0] === i) {
      cursors.shift();
      const vind = getVirtualIndent(getIndentFn, i, lastRow);
      minIndent = Math.min(minIndent, vind);
      const cursorLevels = cursorLevelMap.get(i) ?? [0];
      for (const cursorLevel of cursorLevels) {
        const effectiveDepth = Math.min(cursorLevel + 1, vind);
        if (effectiveDepth >= 1 && effectiveDepth <= minIndent) {
          active.push(effectiveDepth - 1);
        }
      }
      if (stack.length === 0) {
        stack = range(0, minIndent - 1, true);
      }
    }
  }
  return { stack: uniq(stack.sort()), active: uniq(active.sort()) };
};

const statesAboveVisible = (cursorRows, start, getIndentFn, lastRow) =>
  statesInvisible(cursorRows, start, getIndentFn, lastRow, true);

const statesBelowVisible = (cursorRows, start, getIndentFn, lastRow) =>
  statesInvisible(cursorRows, start, getIndentFn, lastRow, false);

function range(left, right, inclusive) {
  const result = [];
  const ascending = left < right;
  const end = !inclusive ? right : ascending ? right + 1 : right - 1;
  for (let i = left; ascending ? i < end : i > end; ascending ? i++ : i--) {
    result.push(i);
  }
  return result;
}

module.exports = {
  toGuides,
  uniq,
  getGuides,
  statesAboveVisible,
  statesBelowVisible,
};
