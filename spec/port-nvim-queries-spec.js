const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  codeMask,
  findPredicates,
  mapCapture,
  translatePredicate,
  portLocals,
  verify,
} = require("../script/port-nvim-queries");

function predicatesIn(source) {
  return findPredicates(source, codeMask(source));
}

function mapped(name, options = { segment: "lua" }) {
  return mapCapture(name, options).name;
}

describe("port-nvim-queries", () => {
  describe("scanning", () => {
    it("does not treat a capture inside a line comment as code", () => {
      let source = "; @keyword here\n(node) @keyword\n";
      let mask = codeMask(source);

      expect(mask[source.indexOf("@keyword")]).toBe(0);
      expect(mask[source.lastIndexOf("@keyword")]).toBe(1);
    });

    it("does not treat a capture inside a string as code", () => {
      let source = '(#eq? @a "@keyword")\n';
      let mask = codeMask(source);

      expect(mask[source.indexOf('"@keyword"') + 1]).toBe(0);
    });

    it("keeps scanning after an escaped quote", () => {
      let source = '(#match? @a "\\"") (node) @keyword\n';
      let mask = codeMask(source);

      expect(mask[source.indexOf("@keyword")]).toBe(1);
    });

    it("finds a predicate that spans several lines", () => {
      let source = '((a) @b\n  (#any-of? @b\n    "x" "y"))\n';
      let predicates = predicatesIn(source);

      expect(predicates.length).toBe(1);
      expect(predicates[0].name).toBe("any-of?");
    });

    it("ignores parentheses that appear inside a string", () => {
      let source = '((a) @b (#match? @b "^\\\\(")) ((c) @d)\n';
      let predicates = predicatesIn(source);

      expect(predicates.length).toBe(1);
      expect(predicates[0].text).toBe('(#match? @b "^\\\\(")');
    });
  });

  describe("capture mapping", () => {
    it("appends the language segment", () => {
      expect(mapped("keyword.return")).toBe("keyword.control.return.lua");
    });

    it("uses the _LANG_ token when asked", () => {
      expect(mapCapture("operator", { langToken: true }).name).toBe("keyword.operator._LANG_");
    });

    it("lets an unlisted tail inherit its parent mapping", () => {
      expect(mapped("keyword.something.invented")).toBe("keyword.control.something.invented.lua");
    });

    it("separates an ignored helper capture with a dot", () => {
      // `_IGNORE_` and `_IGNORE_.…` are what the scope resolver recognises;
      // `_IGNORE__url` would be applied to the text as a real scope.
      expect(mapped("_url")).toBe("_IGNORE_.url");
      expect(mapped("_url").startsWith("_IGNORE_.")).toBe(true);
    });

    it("routes a dropped capture to _IGNORE_ rather than deleting the pattern", () => {
      let result = mapCapture("spell", { segment: "lua" });

      expect(result.confidence).toBe("drop");
      expect(result.name).toBe("_IGNORE_.spell");
    });

    it("leaves a capture needing a split untouched, so verify catches it", () => {
      let result = mapCapture("punctuation.bracket", { segment: "lua" });

      expect(result.confidence).toBe("split");
      expect(result.name).toBe("punctuation.bracket");
    });

    it("reports a capture it has never heard of", () => {
      expect(mapCapture("nonsense.capture", { segment: "lua" }).confidence).toBe("unmapped");
    });
  });

  describe("predicate translation", () => {
    function translate(source) {
      return translatePredicate(predicatesIn(source)[0]);
    }

    it("passes through predicates the query engine implements", () => {
      for (let source of ['(#eq? @a "b")', '(#any-of? @a "b" "c")', '(#not-match? @a "b")']) {
        expect(translate(source).kind).toBe("keep");
      }
    });

    it("passes through Lumine's own predicates", () => {
      expect(translate("(#is? test.first)").kind).toBe("keep");
      expect(translate('(#set! adjust.endAfterFirstMatchOf "^#")').kind).toBe("keep");
    });

    it("rewrites has-ancestor? as a descendantOfType test", () => {
      let result = translate("(#has-ancestor? @a function_definition)");

      expect(result.kind).toBe("rewrite");
      expect(result.text).toBe('(#is? @a test.descendantOfType "function_definition")');
    });

    it("negates has-parent? into is-not?", () => {
      let result = translate("(#not-has-parent? @a block)");

      expect(result.kind).toBe("rewrite");
      expect(result.text).toBe('(#is-not? @a test.childOfType "block")');
    });

    it("converts a column-only offset into adjust settings", () => {
      let result = translate("(#offset! @a 0 1 0 -1)");

      expect(result.kind).toBe("rewrite");
      expect(result.text).toBe("(#set! @a adjust.offsetStart 1) (#set! @a adjust.offsetEnd -1)");
    });

    it("refuses an offset that moves rows", () => {
      expect(translate("(#offset! @a 1 0 0 0)").kind).toBe("remove");
    });

    it("removes a Lua-pattern predicate rather than guessing a regex", () => {
      let result = translate('(#lua-match? @a "^%d+$")');

      expect(result.kind).toBe("remove");
      expect(result.reason).toContain("#match?");
    });

    it("removes an injection setting and names the language", () => {
      let result = translate('(#set! injection.language "sql")');

      expect(result.kind).toBe("remove");
      expect(result.reason).toContain("sql");
      expect(result.reason).toContain("lib/main.js");
    });
  });

  describe("locals", () => {
    it("trims the tail off a local definition", () => {
      expect(portLocals("(a) @local.definition.function\n")).toBe("(a) @local.definition\n");
      expect(portLocals("(a) @local.scope\n")).toBe("(a) @local.scope\n");
    });
  });

  describe("verify", () => {
    let dir;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-port-verify-"));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function write(contents) {
      fs.writeFileSync(path.join(dir, "highlights.scm"), contents);
    }

    it("accepts a finished query", () => {
      write("(a) @keyword.control.lua\n(b) @_IGNORE_.helper\n");

      expect(verify(dir, { segment: "lua" })).toEqual([]);
    });

    it("rejects a scope missing the language segment", () => {
      write("(a) @punctuation.bracket\n");

      expect(verify(dir, { segment: "lua" }).length).toBe(1);
    });

    it("rejects any leftover PORT marker", () => {
      write("; PORT: upstream line 3 [split] @punctuation.bracket\n(a) @keyword.control.lua\n");

      expect(verify(dir, { segment: "lua" }).length).toBe(1);
    });

    it("does not flag a scope mentioned in a comment", () => {
      write("; see @punctuation.bracket upstream\n(a) @keyword.control.lua\n");

      expect(verify(dir, { segment: "lua" })).toEqual([]);
    });
  });
});
