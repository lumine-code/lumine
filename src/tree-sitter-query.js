const { Query } = require("web-tree-sitter");
const matchPattern = require("./scope-regex-match");
const Parser = require("./tree-sitter-parser");
const runtime = require("./tree-sitter-runtime");

const MATCH = new Set(["match?", "not-match?", "any-match?", "any-not-match?"]);
const TEXT = new Set([
  ...MATCH,
  "eq?",
  "not-eq?",
  "any-eq?",
  "any-not-eq?",
  "any-of?",
  "not-any-of?",
]);
const ALIASES = new Set([...MATCH].map((name) => name.toUpperCase()));

// Read only directive names, leaving Tree-sitter itself to decode captures,
// strings and escapes. Strings and comments can contain arbitrary query text.
function operators(source) {
  const result = [];
  let previous = "";
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (/\s/.test(char)) continue;
    if (char === ";") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (char === '"') {
      while (++i < source.length) {
        if (source[i] === "\\") i++;
        else if (source[i] === '"') break;
      }
    } else if (char === "#" && previous === "(") {
      const start = i + 1;
      while (i + 1 < source.length && !/[\s()]/.test(source[i + 1])) i++;
      result.push({ name: source.slice(start, i + 1), start, end: i + 1 });
    }
    previous = char;
  }
  return result;
}

function textPredicate(operator, operands) {
  if (operands.length !== 2 || operands[0].type !== "capture" || operands[1].type !== "string")
    return null;
  const capture = operands[0].name,
    regex = new RegExp(operands[1].value);
  const positive = operator === "match?" || operator === "any-match?";
  const all = !operator.startsWith("any-");
  return (captures) => {
    const nodes = captures.filter((item) => item.name === capture).map((item) => item.node);
    if (!nodes.length) return !positive;
    const test = (node) => {
      const source = Parser.sourceForTree(node.tree);
      const matched =
        source && node.endIndex - node.startIndex > 4096
          ? Boolean(matchPattern(node, regex, () => source))
          : regex.test(node.text);
      return positive ? matched : !matched;
    };
    return all ? nodes.every(test) : nodes.some(test);
  };
}

module.exports = function createQuery(language, source) {
  const ops = operators(source);
  if (!ops.some(({ name }) => MATCH.has(name)) || ops.some(({ name }) => ALIASES.has(name)))
    return new Query(language, source);
  let rewritten = source;
  for (const { name, start, end } of ops.toReversed())
    if (MATCH.has(name))
      rewritten = rewritten.slice(0, start) + name.toUpperCase() + rewritten.slice(end);
  // Equal-length ASCII aliases preserve every native diagnostic/pattern byte
  // offset. They expose operands without copying the binding's query parser.
  const query = new Query(language, rewritten);
  const bytes = Buffer.from(source);
  try {
    for (let index = 0; index < query.patternCount(); index++) {
      const names = operators(
        bytes
          .subarray(query.startIndexForPattern(index), query.endIndexForPattern(index))
          .toString(),
      )
        .map(({ name }) => name)
        .filter((name) => TEXT.has(name));
      const custom = query.predicatesForPattern(index);
      const matches = custom.filter(({ operator }) => ALIASES.has(operator));
      const predicates = query.textPredicates[index];
      if (names.length !== matches.length + predicates.length)
        throw new Error("Unaligned predicate metadata");
      let native = 0,
        bounded = 0;
      query.textPredicates[index] = Object.freeze(
        names.map((name) => {
          if (!MATCH.has(name)) return predicates[native++];
          const predicate = textPredicate(name, matches[bounded++].operands);
          if (!predicate) throw new Error("Invalid match operands");
          return predicate;
        }),
      );
      query.predicates[index] = Object.freeze(
        custom.filter(({ operator }) => !ALIASES.has(operator)),
      );
    }
    return query;
  } catch (error) {
    if (
      error instanceof WebAssembly.RuntimeError ||
      runtime.failure ||
      error.failure?.fatal ||
      error.failure?.recycle ||
      error.code === "memory-pressure"
    )
      throw error;
    // Preserve the pinned binding's validation and errors for unsupported
    // metadata shapes rather than guessing how to execute a query.
    query.delete();
    return new Query(language, source);
  }
};
