const CSON = require("@lumine-code/season");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const { compileInjectionQuery, collectInjectionMatches } = require("../src/tree-sitter-injections");

describe("Static Tree-sitter injection query contract", () => {
  let grammar;
  let queries;

  beforeAll(async () => {
    const file = require.resolve("language-javascript/grammars/javascript.json");
    grammar = new TreeSitterGrammar(lumine.grammars, file, CSON.readFileSync(file));
    await grammar.getLanguage();
  });

  beforeEach(() => {
    queries = [];
  });

  afterEach(() => {
    for (const query of queries) query.delete();
  });

  afterAll(() => grammar.deactivate());

  function compile(source) {
    const query = grammar.createQuerySync(source);
    queries.push(query);
    return compileInjectionQuery(query, source);
  }

  const regex = (directives = '(#set! injection.language "regex")') => `
    ((regex pattern: (regex_pattern) @injection.content) @injection.owner
      ${directives})`;

  it("compiles stable descriptors with typed range and grouping options", () => {
    const descriptors = compile(
      regex(`
      (#set! injection.language "regex")
      (#set! injection.include-children)
      (#set! injection.include-adjacent-whitespace "false")
      (#set! injection.newlines-between "true")
      (#set! injection.combined "true")
      (#set! injection.combined-max-members "128")
      (#set! injection.language-scope "none")
      (#set! injection.cover-shallower-scopes "true")`),
    );
    expect(descriptors.get(0)).toEqual({
      patternIndex: 0,
      languageName: "regex",
      includeChildren: true,
      includeAdjacentWhitespace: false,
      newlinesBetween: true,
      combined: true,
      combinedMaxMembers: 128,
      languageScope: null,
      coverShallowerScopes: true,
    });
    expect(Object.isFrozen(descriptors.get(0))).toBe(true);
  });

  it("requires one owner and mandatory content", () => {
    expect(() =>
      compile('((regex) @injection.content (#set! injection.language "regex"))'),
    ).toThrowError(/exactly one @injection.owner/);
    expect(() =>
      compile(
        '((regex pattern: (regex_pattern)? @injection.content) @injection.owner (#set! injection.language "regex"))',
      ),
    ).toThrowError(/at least one @injection.content/);
    expect(() =>
      compile(
        '((regex pattern: (regex_pattern) @injection.content) @injection.owner? (#set! injection.language "regex"))',
      ),
    ).toThrowError(/exactly one @injection.owner/);
    expect(() =>
      compile(
        '((regex pattern: (regex_pattern) @injection.content @injection.owner) @injection.owner (#set! injection.language "regex"))',
      ),
    ).toThrowError(/exactly one @injection.owner/);
  });

  it("accepts one capture per alternative and repeated content", () => {
    expect(
      compile(
        '([(string) @injection.content (template_string) @injection.content] @injection.owner (#set! injection.language "html"))',
      ).size,
    ).toBe(1);
    expect(
      compile(
        '((array (number)+ @injection.content) @injection.owner (#set! injection.language "html"))',
      ).size,
    ).toBe(1);
  });

  it("rejects unknown properties, unsupported predicates and unevaluated assertions", () => {
    expect(() => compile(regex('(#set! injection.langauge "regex")'))).toThrowError(
      /unknown property injection.langauge/,
    );
    expect(() =>
      compile(regex('(#set! injection.language "regex") (#offset! @injection.content 0 1 0 -1)')),
    ).toThrowError(/unsupported predicate #offset!/);
    expect(() => compile(regex('(#set! injection.language "regex") (#is? local)'))).toThrowError(
      /unsupported predicate #is\?/,
    );
    expect(() =>
      compile(regex('(#set! injection.language "regex") (#set! injection.combined "yes")')),
    ).toThrowError(/must be true or false/);
    for (const limit of ["0", "1.5", "Infinity", "9007199254740992"])
      expect(() =>
        compile(
          regex(
            `(#set! injection.language "regex") (#set! injection.combined-max-members "${limit}")`,
          ),
        ),
      ).toThrowError(/positive safe integer/);
  });

  it("accepts implemented text predicates without treating their operands as captures", () => {
    expect(
      compile(
        regex(
          '(#eq? @injection.content "one+") (#match? @injection.content "^[a-z]+") (#set! injection.language "regex")',
        ),
      ).size,
    ).toBe(1);
  });

  it("rejects capture typos and ambiguous or missing language selection", () => {
    expect(() => compile(regex().replace("injection.content", "injection.contents"))).toThrowError(
      /unknown capture @injection.contents/,
    );
    expect(() => compile(regex(""))).toThrowError(
      /language capture or injection.language is required/,
    );
    expect(() =>
      compile(regex().replace("@injection.content", "@injection.content @injection.language")),
    ).toThrowError(/not both/);
  });

  it("attributes errors to the correct pattern after Unicode comments", () => {
    const source = `; żółć\n${regex()}\n${regex("")}`;
    let error;
    try {
      compile(source);
    } catch (caught) {
      error = caught;
    }
    expect(error.name).toBe("QueryError");
    expect(source.slice(error.index)).toMatch(/^\(\(regex/);
    expect(error.index).toBeGreaterThan(source.indexOf("((regex"));
  });

  it("validates each pattern's language selection", () => {
    const source = `${regex()}\n${regex('(#set! injection.language "html")')}`;
    expect([...compile(source).values()].map(({ languageName }) => languageName)).toEqual([
      "regex",
      "html",
    ]);
    expect(() => compile(`${regex()}\n${regex("")}`)).toThrowError(/pattern 2: a language capture/);
  });

  const node = (id, startIndex, endIndex, text = "") => ({ id, startIndex, endIndex, text });
  const capture = (name, value) => ({ name, node: value });
  const owner = () => node(1, 0, 100);

  it("aggregates fragments and deduplicates repeated windows", () => {
    const descriptors = compile(regex());
    const host = owner();
    const first = node(2, 5, 10);
    const second = node(3, 15, 20);
    const firstMatch = {
      patternIndex: 0,
      captures: [capture("injection.owner", host), capture("injection.content", first)],
    };
    const { state, records } = collectInjectionMatches([firstMatch], descriptors);
    const result = collectInjectionMatches(
      [
        firstMatch,
        {
          patternIndex: 0,
          captures: [capture("injection.owner", host), capture("injection.content", second)],
        },
      ],
      descriptors,
      state,
    );
    expect(result.records).toBe(records);
    expect(records.length).toBe(1);
    expect(records[0].injectionPoint).toBe(descriptors.get(0));
    expect(records[0].contentNodes).toEqual([first, second]);
  });

  it("keeps different pattern identities and captured languages separate", () => {
    const descriptors = compile(`
      ((call_expression function: (identifier) @injection.language
        arguments: (arguments (string) @injection.content)) @injection.owner)
      ${regex()}`);
    const host = owner();
    const content = node(2, 30, 40);
    const match = (patternIndex, languageName) => ({
      patternIndex,
      captures: [
        capture("injection.owner", host),
        capture("injection.content", content),
        ...(languageName ? [capture("injection.language", node(3, 1, 10, languageName))] : []),
      ],
    });
    const { records } = collectInjectionMatches(
      [match(0, "html"), match(0, "css"), match(1)],
      descriptors,
    );
    expect(records.map(({ languageName }) => languageName)).toEqual(["html", "css", "regex"]);
    expect(records[0].injectionPoint).not.toBe(records[2].injectionPoint);
  });

  it("requires every content and helper capture to lie within its owner", () => {
    const descriptors = compile(regex());
    for (const name of ["injection.content", "_helper"])
      expect(() =>
        collectInjectionMatches(
          [
            {
              patternIndex: 0,
              captures: [
                capture("injection.owner", owner()),
                capture("injection.content", node(2, 20, 30)),
                capture(name, node(3, 90, 110)),
              ],
            },
          ],
          descriptors,
        ),
      ).toThrowError(/outside its owner/);
  });
});
