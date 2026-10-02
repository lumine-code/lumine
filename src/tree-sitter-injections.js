const BOOLEAN_PROPERTIES = {
  "injection.include-children": "includeChildren",
  "injection.exclude-children-lines": "excludeChildrenLines",
  "injection.include-adjacent-whitespace": "includeAdjacentWhitespace",
  "injection.newlines-between": "newlinesBetween",
  "injection.combined": "combined",
  "injection.cover-shallower-scopes": "coverShallowerScopes",
};
const INJECTION_CAPTURES = new Set(["injection.owner", "injection.content", "injection.language"]);

function compileInjectionQuery(query, source) {
  const descriptors = new Map();
  const bytes = typeof source === "string" ? Buffer.from(source) : null;
  const bounds = [
    [0, 0],
    [0, 1],
    [0, Infinity],
    [1, 1],
    [1, Infinity],
  ];
  const count = query.patternCount();
  for (let patternIndex = 0; patternIndex < count; patternIndex++) {
    const fail = (message) => {
      const error = new Error(`Invalid injection pattern ${patternIndex + 1}: ${message}`);
      error.name = "QueryError";
      // Query pattern offsets use UTF-8 bytes; diagnostics index the source string.
      error.index =
        bytes?.subarray(0, query.startIndexForPattern(patternIndex)).toString().length ?? 0;
      throw error;
    };
    const captures = new Map();
    query.captureNames.forEach((name, index) => {
      const quantifier = query.captureQuantifiers[patternIndex][index];
      if (quantifier) captures.set(name, bounds[quantifier]);
    });
    for (const name of captures.keys()) {
      if (name.startsWith("injection.") && !INJECTION_CAPTURES.has(name))
        fail(`unknown capture @${name}`);
    }
    const owner = captures.get("injection.owner");
    if (owner?.[0] !== 1 || owner[1] !== 1)
      fail("each match must have exactly one @injection.owner");
    if (!(captures.get("injection.content")?.[0] >= 1))
      fail("each match must have at least one @injection.content");
    // The WASM runtime evaluates text predicates and extracts #set! properties.
    // Its remaining predicates have no evaluator in the injection contract.
    for (const { operator } of query.predicatesForPattern(patternIndex)) {
      fail(`unsupported predicate #${operator}`);
    }
    if (Object.keys(query.assertedProperties[patternIndex] ?? {}).length) {
      fail("unsupported predicate #is?; properties are not evaluated for injections");
    }
    if (Object.keys(query.refutedProperties[patternIndex] ?? {}).length) {
      fail("unsupported predicate #is-not?; properties are not evaluated for injections");
    }
    const descriptor = { patternIndex };
    for (const [name, value] of Object.entries(query.setProperties[patternIndex] ?? {})) {
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
    const patternIndex = match.patternIndex;
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
