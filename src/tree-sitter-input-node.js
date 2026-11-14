const { checkPredicateTextLength } = require("./tree-sitter-query-budget");

// Syntax and native text predicates belong to the original snapshot. Scope
// predicates use projected geometry/text: start endpoints follow an insertion,
// end endpoints precede it. Native Tree.edit expands leaf ends across inserted
// newlines, which changes lastTextOnRow and one-line-suite tests incorrectly.
function projectInputTree(originalTree, originalQuery, source, target, map, inverse, check) {
  const nodes = new Map();
  let original = originalTree;
  let query = originalQuery;
  const tree = {
    language: originalTree.language,
    textCallback: target.reader(4096),
    get rootNode() {
      check();
      return wrap(original.rootNode);
    },
  };
  const wrap = (node) => {
    if (!node) return null;
    let result = nodes.get(node.id);
    if (!result) {
      result = new InputNode(node);
      nodes.set(node.id, result);
    }
    return result;
  };
  class InputNode {
    constructor(node) {
      this.original = node;
    }
    get tree() {
      return tree;
    }
    get startPosition() {
      check();
      return map.mapPoint(this.original.startPosition, true);
    }
    get endPosition() {
      check();
      return map.mapPoint(
        this.original.endPosition,
        this.original.startIndex === this.original.endIndex,
      );
    }
    get startIndex() {
      return target.offsetAt(this.startPosition);
    }
    get endIndex() {
      return target.offsetAt(this.endPosition);
    }
    get text() {
      const start = this.startIndex,
        end = this.endIndex;
      checkPredicateTextLength(end - start);
      return target.slice(start, end);
    }
    toString() {
      check();
      return this.original.toString();
    }
    descendantsOfType(types, start, end) {
      check();
      return this.original
        .descendantsOfType(
          types,
          start && inverse.mapPoint(start),
          end && inverse.mapPoint(end, true),
        )
        .map(wrap);
    }
  }
  for (const name of [
    "id",
    "type",
    "isNamed",
    "isMissing",
    "isError",
    "isExtra",
    "hasError",
    "childCount",
    "namedChildCount",
  ]) {
    Object.defineProperty(InputNode.prototype, name, {
      get() {
        check();
        return this.original[name];
      },
    });
  }
  for (const name of [
    "parent",
    "firstChild",
    "lastChild",
    "firstNamedChild",
    "lastNamedChild",
    "nextSibling",
    "previousSibling",
    "nextNamedSibling",
    "previousNamedSibling",
  ]) {
    Object.defineProperty(InputNode.prototype, name, {
      get() {
        check();
        return wrap(this.original[name]);
      },
    });
  }
  for (const name of ["children", "namedChildren"]) {
    Object.defineProperty(InputNode.prototype, name, {
      get() {
        check();
        return this.original[name].map(wrap);
      },
    });
  }
  for (const name of ["child", "namedChild", "childForFieldName", "childForFieldId"]) {
    InputNode.prototype[name] = function (...args) {
      check();
      return wrap(this.original[name](...args));
    };
  }
  for (const name of ["childrenForFieldName", "childrenForFieldId"]) {
    InputNode.prototype[name] = function (...args) {
      check();
      return this.original[name](...args).map(wrap);
    };
  }
  const optionsForSource = (options) => {
    const offset = (position, index, fallback) => {
      if (index != null) return Math.min(target.length, Math.max(0, index));
      if (!position) return fallback;
      if (position.row >= target.lineCount) return target.length;
      const row = Math.max(0, position.row);
      const start = target.lineStart(row);
      const end = row + 1 < target.lineCount ? target.lineStart(row + 1) - 1 : target.length;
      return start + Math.min(end - start, Math.max(0, position.column));
    };
    const first = offset(options.startPosition, options.startIndex, 0);
    const last = offset(options.endPosition, options.endIndex, target.length);
    // A wholly inserted row collapses to one original point. Include adjacent
    // original tokens, then retain only captures intersecting the draft window.
    let start = source.offsetAt(inverse.mapPoint(target.positionAt(first)));
    let end = source.offsetAt(inverse.mapPoint(target.positionAt(last), true));
    if (start === end) {
      start = Math.max(0, start - 1);
      end = Math.min(source.length, end + 1);
    }
    return {
      first,
      last,
      native: {
        ...options,
        startPosition: source.positionAt(start),
        endPosition: source.positionAt(end),
        startIndex: start,
        endIndex: end,
      },
    };
  };
  const projectedCapture = (capture) => ({ ...capture, node: wrap(capture.node) });
  const intersects = (capture, first, last) =>
    capture.node.endIndex >= first && capture.node.startIndex <= last;
  const adapter = query && {
    get textPredicates() {
      return query.textPredicates;
    },
    set textPredicates(value) {
      query.textPredicates = value;
    },
    didExceedMatchLimit: () => query.didExceedMatchLimit(),
    captures(_node, options = {}) {
      check();
      const { first, last, native } = optionsForSource(options);
      return query
        .captures(original.rootNode, native)
        .map(projectedCapture)
        .filter((capture) => intersects(capture, first, last));
    },
  };
  return {
    tree,
    query: adapter,
    close() {
      for (const node of nodes.values()) node.original = null;
      nodes.clear();
      original = null;
      query = null;
    },
  };
}

module.exports = projectInputTree;
