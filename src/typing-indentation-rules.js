// A conservative rejection filter, never an indentation engine. Only captures
// proven unable to match the edited row may bypass the syntax worker.
const relevant = new Set(["dedent", "match", "none"]);

function syntax(source) {
  const root = [],
    stack = [root];
  const tokens = source.match(/;[^\r\n]*|"(?:\\.|[^"\\])*"|[()[\]]|[^\s()[\]";]+/g) ?? [];
  for (const token of tokens) {
    if (token[0] === ";") continue;
    if (token === "(" || token === "[") {
      const node = { delimiter: token, children: [] };
      stack.at(-1).push(node);
      stack.push(node.children);
    } else if (token === ")" || token === "]") {
      if (stack.length === 1) throw new Error("Unbalanced query");
      stack.pop();
    } else stack.at(-1).push(token[0] === '"' ? { text: JSON.parse(token) } : token);
  }
  if (stack.length !== 1) throw new Error("Unbalanced query");
  return root;
}

function literals(node) {
  if (node?.text !== undefined) return [node.text];
  if (node?.delimiter === "[") {
    const groups = node.children.map(literals);
    if (groups.every(Boolean)) return groups.flat();
  }
  return null;
}

function compile(query, source) {
  if (!query) return null;
  try {
    const bytes = Buffer.from(source),
      rules = [];
    for (let pattern = 0; pattern < query.patternCount(); pattern++) {
      if (query.assertedProperties[pattern]?.["indent.reindent"] === "true") continue;
      const names = query.captureNames.filter(
        (name, id) => relevant.has(name) && query.captureQuantifiers[pattern][id],
      );
      if (!names.length) continue;
      const text = bytes
        .subarray(query.startIndexForPattern(pattern), query.endIndexForPattern(pattern))
        .toString();
      const captures = new Map(),
        predicates = [];
      const visit = (items) => {
        for (let i = 0; i < items.length; i++) {
          const node = items[i];
          if (typeof node === "string" && names.includes(node.slice(1)) && node[0] === "@") {
            let previous = items[i - 1];
            if (["?", "+", "*"].includes(previous)) previous = items[i - 2];
            const list = captures.get(node) ?? [];
            list.push(previous);
            captures.set(node, list);
          }
          if (node?.children) {
            if (String(node.children[0]).startsWith("#")) predicates.push(node.children);
            else visit(node.children);
          }
        }
      };
      visit(syntax(text));
      const force = query.setProperties[pattern]?.["indent.force"] != null;
      for (const name of names) {
        const nodes = captures.get("@" + name);
        if (!nodes?.length) return null;
        for (const node of nodes) {
          const values = literals(node);
          if (values) {
            rules.push(...values.map((value) => ({ value, start: !force, end: !force })));
            continue;
          }
          const predicate = predicates.find(
            ([operator, capture, value]) =>
              capture === "@" + name &&
              value?.text !== undefined &&
              (operator === "#eq?" || operator === "#match?"),
          );
          if (!predicate) return null;
          const [operator, , value] = predicate;
          if (operator === "#eq?") {
            rules.push({ value: value.text, start: !force, end: !force });
          } else {
            // Rust and JS regexes differ. Accept only literal ASCII alternatives;
            // anything more expressive retains the complete syntax path.
            const match =
              /^(\^)?(?:([A-Za-z0-9_]+)|\(([A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)*)\))(\$)?$/.exec(
                value.text,
              );
            if (!match) return null;
            rules.push(
              ...(match[2] ?? match[3]).split("|").map((word) => ({
                value: word,
                start: !force && Boolean(match[1]),
                end: !force && Boolean(match[4]),
              })),
            );
          }
        }
      }
    }
    return rules;
  } catch {
    return null;
  }
}

function forMode(mode) {
  const visited = new Set(),
    rules = [];
  const visit = (grammar) => {
    if (!grammar || visited.has(grammar)) return true;
    visited.add(grammar);
    if (grammar.queryPaths?.indentsQuery) {
      const query = grammar.queryCache.get("indentsQuery");
      if (!query) return false;
      if (!Object.hasOwn(query, "typingIndentationRules"))
        query.typingIndentationRules = compile(query, grammar.indentsQuery);
      const own = query.typingIndentationRules;
      if (!own) return false;
      rules.push(...own);
    }
    if (Object.keys(grammar.injectionPointsByType ?? {}).length) return false;
    if (grammar.queryPaths?.injectionsQuery) {
      const descriptors = grammar.queryCache.get("injectionsQuery")?.injectionDescriptors;
      if (!descriptors) return false;
      for (const { languageName } of descriptors.values()) {
        if (!languageName || !visit(mode.grammarForLanguageString(languageName))) return false;
      }
    }
    return true;
  };
  return visit(mode.grammar) ? rules : null;
}

function mayMatch(rules, text) {
  if (!rules) return true;
  const content = text.trim();
  return rules.some(({ value, start, end }) =>
    start && end
      ? content === value
      : start
        ? content.startsWith(value)
        : end
          ? content.endsWith(value)
          : content.includes(value),
  );
}

module.exports = { compile, forMode, mayMatch };
