const BOOLEAN_PROPERTIES = {
  "injection.include-children": "includeChildren",
  "injection.include-adjacent-whitespace": "includeAdjacentWhitespace",
  "injection.newlines-between": "newlinesBetween",
  "injection.combined": "combined",
  "injection.cover-shallower-scopes": "coverShallowerScopes",
};
const TEXT_PREDICATES = new Set([
  "eq?",
  "not-eq?",
  "any-eq?",
  "any-not-eq?",
  "match?",
  "not-match?",
  "any-match?",
  "any-not-match?",
  "any-of?",
  "not-any-of?",
]);
const INJECTION_CAPTURES = new Set(["injection.owner", "injection.content", "injection.language"]);

// Native queries do not expose capture quantifiers. Read only the structure of
// their already-compiled patterns, ignoring strings, comments and predicates.
function sourceCaptures(source) {
  const tokens =
    source.match(/;[^\r\n]*|"(?:\\.|[^"\\])*"|#[^\s()[\]]+|[()[\]?*+]|[^\s()[\]?*+]+/g) ?? [];
  let index = 0;
  const read = (end) => {
    const result = [];
    while (index < tokens.length) {
      const token = tokens[index++];
      if (token.startsWith(";")) continue;
      if (token === end) break;
      if (token === "(" || token === "[") {
        result.push({ kind: token, items: read(token === "(" ? ")" : "]") });
      } else result.push(token);
    }
    return result;
  };
  const add = (target, captures) => {
    for (const [name, [min, max]] of captures) {
      const previous = target.get(name) ?? [0, 0];
      target.set(name, [previous[0] + min, previous[1] + max]);
    }
  };
  const sequence = (items, alternatives = false) => {
    const expressions = [];
    let expression;
    for (const item of items) {
      if (typeof item === "string" && item.startsWith("@")) {
        if (expression) {
          const name = item.slice(1);
          add(expression.captures, new Map([[name, expression.bounds.slice()]]));
        }
      } else if (item === "?" || item === "*" || item === "+") {
        if (expression) {
          const min = item === "+" ? 1 : 0;
          const max = item === "?" ? 1 : Infinity;
          expression.bounds = [expression.bounds[0] * min, expression.bounds[1] * max];
          for (const [name, bounds] of expression.captures) {
            expression.captures.set(name, [bounds[0] * min, bounds[1] * max]);
          }
        }
      } else if (typeof item !== "string" && !item.items[0]?.startsWith?.("#")) {
        expression = {
          captures: sequence(item.items, item.kind === "["),
          bounds: [1, 1],
        };
        expressions.push(expression);
      } else if (typeof item === "string" && !item.endsWith(":") && item !== ".") {
        expression = { captures: new Map(), bounds: [1, 1] };
        expressions.push(expression);
      }
    }
    const result = new Map();
    if (alternatives) {
      const names = new Set(expressions.flatMap(({ captures }) => [...captures.keys()]));
      for (const name of names) {
        const bounds = expressions.map(({ captures }) => captures.get(name) ?? [0, 0]);
        result.set(name, [
          Math.min(...bounds.map(([min]) => min)),
          Math.max(...bounds.map(([, max]) => max)),
        ]);
      }
    } else for (const { captures } of expressions) add(result, captures);
    return result;
  };
  const items = read(null);
  const predicates = [];
  const visit = (children) => {
    for (const item of children) {
      if (typeof item === "string") continue;
      if (item.items[0]?.startsWith?.("#")) predicates.push(item.items[0].slice(1));
      else visit(item.items);
    }
  };
  visit(items);
  return { captures: sequence(items), predicates };
}

function patternSource(query, source, patternIndex, patternCount) {
  const start = query.startIndexForPattern?.(patternIndex) ?? 0;
  const end =
    query.endIndexForPattern?.(patternIndex) ??
    (patternIndex + 1 < patternCount ? query.startIndexForPattern?.(patternIndex + 1) : undefined);
  // Both runtimes report UTF-8 byte offsets for pattern boundaries.
  const bytes = Buffer.from(source);
  return {
    source: bytes.subarray(start, end).toString(),
    index: bytes.subarray(0, start).toString().length,
  };
}

function compileInjectionQuery(query, source) {
  const descriptors = new Map();
  const count =
    query.patternCount?.() ?? query.captureQuantifiers?.length ?? query.setProperties?.length ?? 0;
  for (let patternIndex = 0; patternIndex < count; patternIndex++) {
    const pattern =
      typeof source === "string" ? patternSource(query, source, patternIndex, count) : null;
    const fail = (message) => {
      const error = new Error(`Invalid injection pattern ${patternIndex + 1}: ${message}`);
      error.name = "QueryError";
      error.index = pattern?.index ?? 0;
      throw error;
    };
    const parsed = pattern && sourceCaptures(pattern.source);
    const captures = parsed?.captures ?? new Map();
    if (query.captureQuantifiers?.[patternIndex]) {
      const bounds = [
        [0, 0],
        [0, 1],
        [0, Infinity],
        [1, 1],
        [1, Infinity],
      ];
      query.captureNames.forEach((name, index) => {
        const quantifier = query.captureQuantifiers[patternIndex][index];
        if (quantifier) captures.set(name, bounds[quantifier]);
      });
    } else if (!parsed) fail("query source is required to validate native captures");
    for (const name of captures.keys()) {
      if (name.startsWith("injection.") && !INJECTION_CAPTURES.has(name))
        fail(`unknown capture @${name}`);
    }
    const owner = captures.get("injection.owner");
    if (owner?.[0] !== 1 || owner[1] !== 1)
      fail("each match must have exactly one @injection.owner");
    if (!(captures.get("injection.content")?.[0] >= 1))
      fail("each match must have at least one @injection.content");
    const predicates =
      parsed?.predicates ??
      query.predicatesForPattern?.(patternIndex)?.map(({ operator }) => operator) ??
      [];
    for (const operator of predicates) {
      if (operator !== "set!" && !TEXT_PREDICATES.has(operator))
        fail(`unsupported predicate #${operator}`);
    }
    if (
      Object.keys(query.assertedProperties?.[patternIndex] ?? {}).length ||
      Object.keys(query.refutedProperties?.[patternIndex] ?? {}).length
    ) {
      fail("#is? and #is-not? properties are not evaluated for injections");
    }
    const descriptor = { patternIndex };
    for (const [name, value] of Object.entries(query.setProperties?.[patternIndex] ?? {})) {
      if (Object.hasOwn(BOOLEAN_PROPERTIES, name)) {
        if (value !== null && value !== "true" && value !== "false")
          fail(`${name} must be true or false`);
        descriptor[BOOLEAN_PROPERTIES[name]] = value !== "false";
      } else if (name === "injection.language") {
        if (typeof value !== "string" || !value.trim())
          fail("injection.language must name a language");
        descriptor.languageName = value;
      } else if (name === "injection.language-scope") {
        if (typeof value !== "string" || !value.trim())
          fail("injection.language-scope must name a scope or none");
        descriptor.languageScope = value === "none" ? null : value;
      } else if (name === "injection.combined-max-members") {
        const limit = Number(value);
        if (
          typeof value !== "string" ||
          !/^\d+$/.test(value) ||
          !Number.isSafeInteger(limit) ||
          limit < 1
        )
          fail("injection.combined-max-members must be a positive safe integer");
        descriptor.combinedMaxMembers = limit;
      } else fail(`unknown property ${name}`);
    }
    const language = captures.get("injection.language");
    if (language && descriptor.languageName !== undefined)
      fail("use @injection.language or injection.language, not both");
    if (!language && descriptor.languageName === undefined)
      fail("a language capture or injection.language is required");
    if (language?.[1] > 1) fail("each match may have at most one @injection.language");
    descriptors.set(patternIndex, Object.freeze(descriptor));
  }
  return descriptors;
}

// One state is shared by all row/column windows of a population. Repeated
// matches contribute fragments to the same owner without creating new layers.
function collectInjectionMatches(
  matches,
  descriptors,
  state = { records: [], patterns: new Map() },
) {
  for (const match of matches) {
    const patternIndex = match.patternIndex ?? match.pattern;
    const injectionPoint = descriptors.get(patternIndex);
    if (!injectionPoint) throw new Error(`Unknown injection pattern ${patternIndex}`);
    const owners = match.captures.filter(({ name }) => name === "injection.owner");
    const contents = match.captures.filter(({ name }) => name === "injection.content");
    const languages = match.captures.filter(({ name }) => name === "injection.language");
    if (owners.length !== 1 || contents.length === 0 || languages.length > 1)
      throw new Error(`Invalid captures for injection pattern ${patternIndex + 1}`);
    const node = owners[0].node;
    if (
      match.captures.some(
        ({ node: capture }) =>
          capture.startIndex < node.startIndex || capture.endIndex > node.endIndex,
      )
    )
      throw new Error(`Injection pattern ${patternIndex + 1} has a capture outside its owner`);
    const languageName = injectionPoint.languageName ?? languages[0]?.node.text;
    if (!languageName) continue;
    let ownersById = state.patterns.get(patternIndex);
    if (!ownersById) state.patterns.set(patternIndex, (ownersById = new Map()));
    let byLanguage = ownersById.get(node.id);
    if (!byLanguage) ownersById.set(node.id, (byLanguage = new Map()));
    let entry = byLanguage.get(languageName);
    if (!entry) {
      const record = { node, injectionPoint, languageName, contentNodes: [] };
      entry = { record, contentIds: new Set() };
      byLanguage.set(languageName, entry);
      state.records.push(record);
    }
    for (const { node: content } of contents) {
      if (entry.contentIds.has(content.id)) continue;
      entry.contentIds.add(content.id);
      entry.record.contentNodes.push(content);
    }
  }
  return { records: state.records, state };
}

module.exports = { compileInjectionQuery, collectInjectionMatches };
