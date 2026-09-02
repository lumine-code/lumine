const dedent = require("dedent");
const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const CSON = require("@lumine-code/season");
const TextBuffer = require("../src/text-buffer");
const GrammarRegistry = require("../src/grammar-registry");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");

describe("GrammarRegistry", () => {
  let grammarRegistry;

  beforeEach(() => {
    grammarRegistry = new GrammarRegistry({ config: lumine.config });
    expect(subscriptionCount(grammarRegistry)).toBe(0);
  });

  describe(".assignLanguageMode(buffer, languageId)", () => {
    it("assigns to the buffer a language mode with the given language id", async () => {
      grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );
      grammarRegistry.loadGrammarSync(require.resolve("language-css/grammars/css.json"));

      const buffer = new TextBuffer();
      expect(grammarRegistry.assignLanguageMode(buffer, "source.js")).toBe(true);
      expect(buffer.getLanguageMode().getLanguageId()).toBe("source.js");
      expect(grammarRegistry.getAssignedLanguageId(buffer)).toBe("source.js");

      // Returns true if we found the grammar, even if it didn't change
      expect(grammarRegistry.assignLanguageMode(buffer, "source.js")).toBe(true);

      // Language names are not case-sensitive
      expect(grammarRegistry.assignLanguageMode(buffer, "source.css")).toBe(true);
      expect(buffer.getLanguageMode().getLanguageId()).toBe("source.css");

      // Returns false if no language is found
      expect(grammarRegistry.assignLanguageMode(buffer, "blub")).toBe(false);
      expect(buffer.getLanguageMode().getLanguageId()).toBe("source.css");
    });

    it("stops retaining a buffer once it is destroyed", () => {
      grammarRegistry.loadGrammarSync(require.resolve("language-css/grammars/css.json"));

      // `applySyntaxHighlighting` assigns a language mode to a throwaway
      // editor for every fenced code block it renders. Retaining those for the
      // lifetime of the window leaked one buffer per rendered block.
      const buffer = new TextBuffer();
      grammarRegistry.assignLanguageMode(buffer, "source.css");
      expect(grammarRegistry.grammarScoresByBuffer.has(buffer)).toBe(true);
      expect(grammarRegistry.languageOverridesByBufferId.has(buffer.id)).toBe(true);

      buffer.destroy();
      expect(grammarRegistry.grammarScoresByBuffer.has(buffer)).toBe(false);
      expect(grammarRegistry.languageOverridesByBufferId.has(buffer.id)).toBe(false);
    });

    it("stops retaining a buffer assigned a grammar directly", () => {
      const grammar = grammarRegistry.loadGrammarSync(
        require.resolve("language-css/grammars/css.json"),
      );

      const buffer = new TextBuffer();
      grammarRegistry.assignGrammar(buffer, grammar);
      expect(grammarRegistry.grammarScoresByBuffer.has(buffer)).toBe(true);

      buffer.destroy();
      expect(grammarRegistry.grammarScoresByBuffer.has(buffer)).toBe(false);
      expect(grammarRegistry.languageOverridesByBufferId.has(buffer.id)).toBe(false);
    });

    it("registers only one release for a maintained buffer", () => {
      grammarRegistry.loadGrammarSync(require.resolve("language-css/grammars/css.json"));

      const buffer = new TextBuffer();
      grammarRegistry.assignLanguageMode(buffer, "source.css");
      const before = grammarRegistry.subscriptions.disposables.size;
      // maintainLanguageMode installs its own destroy handler and calls
      // assignLanguageMode on the way, so only its own pair should be added.
      const disposable = grammarRegistry.maintainLanguageMode(buffer);
      expect(grammarRegistry.subscriptions.disposables.size).toBe(before + 2);

      // Once it stops maintaining, a later assignment may claim the buffer again.
      disposable.dispose();
      grammarRegistry.assignLanguageMode(buffer, "source.css");
      buffer.destroy();
      expect(grammarRegistry.grammarScoresByBuffer.has(buffer)).toBe(false);
      expect(grammarRegistry.languageOverridesByBufferId.has(buffer.id)).toBe(false);
    });

    it("does not stack subscriptions when a buffer is reassigned", () => {
      grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );
      grammarRegistry.loadGrammarSync(require.resolve("language-css/grammars/css.json"));

      const buffer = new TextBuffer();
      const before = grammarRegistry.subscriptions.disposables.size;
      grammarRegistry.assignLanguageMode(buffer, "source.js");
      grammarRegistry.assignLanguageMode(buffer, "source.css");
      grammarRegistry.assignLanguageMode(buffer, "source.js");
      expect(grammarRegistry.subscriptions.disposables.size).toBe(before + 1);
    });

    describe("when no languageId is passed", () => {
      it("makes the buffer use the null grammar", () => {
        grammarRegistry.loadGrammarSync(require.resolve("language-css/grammars/css.json"));

        const buffer = new TextBuffer();
        expect(grammarRegistry.assignLanguageMode(buffer, "source.css")).toBe(true);
        expect(buffer.getLanguageMode().getLanguageId()).toBe("source.css");

        expect(grammarRegistry.assignLanguageMode(buffer, null)).toBe(true);
        expect(buffer.getLanguageMode().getLanguageId()).toBe("text.plain.null-grammar");
        expect(grammarRegistry.getAssignedLanguageId(buffer)).toBe(null);
      });
    });
  });

  describe(".assignGrammar(buffer, grammar)", () => {
    it("assigns a Tree-sitter grammar directly", () => {
      const grammar = grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );

      const buffer = new TextBuffer();
      expect(grammarRegistry.assignGrammar(buffer, grammar)).toBe(true);
      expect(buffer.getLanguageMode().getGrammar()).toBe(grammar);
    });
  });

  describe(".grammarForId(languageId)", () => {
    it("returns a Tree-sitter grammar by scope name", () => {
      const loadedGrammar = grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );

      const grammar = grammarRegistry.grammarForId("source.js");
      expect(grammar).toBe(loadedGrammar);
      expect(grammar instanceof TreeSitterGrammar).toBe(true);
      expect(grammar.scopeName).toBe("source.js");

      grammarRegistry.removeGrammar(grammar);
      expect(grammarRegistry.grammarForId("source.js")).toBeUndefined();
    });

    it("never returns a stub object before a grammar has loaded", () => {
      grammarRegistry.addInjectionPoint("source.js", {
        type: "some_node_type",
        language() {
          return "some_language_name";
        },
        content(node) {
          return node;
        },
      });

      expect(grammarRegistry.grammarForId("source.js")).toBe(undefined);
    });
  });

  describe("Tree-sitter-only registration", () => {
    it("rejects descriptors that do not declare the Tree-sitter type", () => {
      expect(() =>
        grammarRegistry.createGrammar("legacy.json", {
          name: "Legacy",
          scopeName: "source.legacy",
        }),
      ).toThrowError(/must declare type 'tree-sitter'/);
      expect(() =>
        grammarRegistry.createGrammar("legacy.json", {
          name: "Legacy",
          scopeName: "source.legacy",
          type: "textmate",
        }),
      ).toThrowError(/must declare type 'tree-sitter'/);
    });

    it("rejects grammar objects not created by the Tree-sitter loader", () => {
      expect(() =>
        grammarRegistry.addGrammar({
          name: "Legacy",
          scopeName: "source.legacy",
        }),
      ).toThrowError(TypeError, /Only Tree-sitter grammars/);
    });
  });

  describe(".autoAssignLanguageMode(buffer)", () => {
    it("assigns to the buffer a language mode based on the best available grammar", () => {
      grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );
      grammarRegistry.loadGrammarSync(require.resolve("language-css/grammars/css.json"));

      const buffer = new TextBuffer();
      buffer.setPath("foo.js");
      expect(grammarRegistry.assignLanguageMode(buffer, "source.css")).toBe(true);
      expect(buffer.getLanguageMode().getLanguageId()).toBe("source.css");

      grammarRegistry.autoAssignLanguageMode(buffer);
      expect(buffer.getLanguageMode().getLanguageId()).toBe("source.js");
    });
  });

  describe(".maintainLanguageMode(buffer)", () => {
    it("assigns a grammar to the buffer based on its path", async () => {
      const buffer = new TextBuffer();

      grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );
      grammarRegistry.loadGrammarSync(require.resolve("language-c/grammars/c.json"));

      buffer.setPath("test.js");
      grammarRegistry.maintainLanguageMode(buffer);
      expect(buffer.getLanguageMode().getLanguageId()).toBe("source.js");

      buffer.setPath("test.c");
      expect(buffer.getLanguageMode().getLanguageId()).toBe("source.c");
    });

    it("updates the buffer when a matching Tree-sitter grammar is added or replaced", () => {
      const buffer = new TextBuffer();
      buffer.setPath("test.js");
      grammarRegistry.maintainLanguageMode(buffer);
      expect(buffer.getLanguageMode().getLanguageId()).toBe("text.plain.null-grammar");

      const firstGrammar = grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );
      expect(buffer.getLanguageMode().grammar).toBe(firstGrammar);

      const replacementGrammar = grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );
      expect(buffer.getLanguageMode().grammar).toBe(replacementGrammar);
    });

    it("can be overridden by calling .assignLanguageMode", () => {
      const buffer = new TextBuffer();

      buffer.setPath("test.js");
      grammarRegistry.maintainLanguageMode(buffer);

      grammarRegistry.loadGrammarSync(require.resolve("language-css/grammars/css.json"));
      expect(grammarRegistry.assignLanguageMode(buffer, "source.css")).toBe(true);
      expect(buffer.getLanguageMode().getLanguageId()).toBe("source.css");

      grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );
      expect(buffer.getLanguageMode().getLanguageId()).toBe("source.css");
    });

    it("returns a disposable that can be used to stop the registry from updating the buffer", async () => {
      const buffer = new TextBuffer();
      grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );

      const previousSubscriptionCount = buffer.emitter.getTotalListenerCount();
      const disposable = grammarRegistry.maintainLanguageMode(buffer);
      expect(buffer.emitter.getTotalListenerCount()).toBeGreaterThan(previousSubscriptionCount);
      expect(retainedBufferCount(grammarRegistry)).toBe(1);

      buffer.setPath("test.js");
      expect(buffer.getLanguageMode().getLanguageId()).toBe("source.js");

      buffer.setPath("test.txt");
      expect(buffer.getLanguageMode().getLanguageId()).toBe("text.plain.null-grammar");

      disposable.dispose();
      expect(buffer.emitter.getTotalListenerCount()).toBe(previousSubscriptionCount);
      expect(retainedBufferCount(grammarRegistry)).toBe(0);

      buffer.setPath("test.js");
      expect(buffer.getLanguageMode().getLanguageId()).toBe("text.plain.null-grammar");
      expect(retainedBufferCount(grammarRegistry)).toBe(0);
    });

    it("doesn't do anything when called a second time with the same buffer", async () => {
      const buffer = new TextBuffer();
      grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );
      const disposable1 = grammarRegistry.maintainLanguageMode(buffer);
      const disposable2 = grammarRegistry.maintainLanguageMode(buffer);

      buffer.setPath("test.js");
      expect(buffer.getLanguageMode().getLanguageId()).toBe("source.js");

      disposable2.dispose();
      buffer.setPath("test.txt");
      expect(buffer.getLanguageMode().getLanguageId()).toBe("text.plain.null-grammar");

      disposable1.dispose();
      buffer.setPath("test.js");
      expect(buffer.getLanguageMode().getLanguageId()).toBe("text.plain.null-grammar");
    });

    it("does not retain the buffer after the buffer is destroyed", () => {
      const buffer = new TextBuffer();
      grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );

      const disposable = grammarRegistry.maintainLanguageMode(buffer);
      expect(retainedBufferCount(grammarRegistry)).toBe(1);
      expect(subscriptionCount(grammarRegistry)).toBe(2);

      buffer.destroy();
      expect(retainedBufferCount(grammarRegistry)).toBe(0);
      expect(subscriptionCount(grammarRegistry)).toBe(0);
      expect(buffer.emitter.getTotalListenerCount()).toBe(0);

      disposable.dispose();
      expect(retainedBufferCount(grammarRegistry)).toBe(0);
      expect(subscriptionCount(grammarRegistry)).toBe(0);
    });

    it("does not retain the buffer when the grammar registry is destroyed", () => {
      const buffer = new TextBuffer();
      grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );

      grammarRegistry.maintainLanguageMode(buffer);
      expect(retainedBufferCount(grammarRegistry)).toBe(1);
      expect(subscriptionCount(grammarRegistry)).toBe(2);

      grammarRegistry.clear();

      expect(retainedBufferCount(grammarRegistry)).toBe(0);
      expect(subscriptionCount(grammarRegistry)).toBe(0);
      expect(buffer.emitter.getTotalListenerCount()).toBe(0);
    });
  });

  describe(".selectGrammar(filePath)", () => {
    it("always returns a grammar", () => {
      const registry = new GrammarRegistry({ config: lumine.config });
      expect(registry.selectGrammar().scopeName).toBe("text.plain.null-grammar");
    });

    it("selects the text.plain grammar over the null grammar once it is available", () => {
      grammarRegistry.loadGrammarSync(require.resolve("./fixtures/grammars/plain-text.json"));
      expect(grammarRegistry.selectGrammar("test.txt").scopeName).toBe("text.plain");
    });

    it("selects a grammar based on the file path case insensitively", async () => {
      await lumine.packages.activatePackage("language-python");
      expect(lumine.grammars.selectGrammar("/tmp/source.py").scopeName).toBe("source.python");
      expect(lumine.grammars.selectGrammar("/tmp/source.PY").scopeName).toBe("source.python");
    });

    describe("on Windows", () => {
      let originalPlatform;

      beforeEach(() => {
        originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "win32" });
      });

      afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      });

      it("normalizes back slashes to forward slashes when matching the fileTypes", async () => {
        await lumine.packages.activatePackage("language-git");
        expect(lumine.grammars.selectGrammar("something\\.git\\config").scopeName).toBe(
          "source.git-config",
        );
      });
    });

    it("can use the filePath to load the correct grammar based on the grammar's filetype", async () => {
      await lumine.packages.activatePackage("language-git");
      await lumine.packages.activatePackage("language-javascript");
      await lumine.packages.activatePackage("language-python");

      expect(lumine.grammars.selectGrammar("file.js").name).toBe("JavaScript"); // based on extension (.js)
      expect(lumine.grammars.selectGrammar(path.join(temp.dir, ".git", "config")).name).toBe(
        "Git Config",
      ); // based on end of the path (.git/config)
      expect(lumine.grammars.selectGrammar("Snakefile").name).toBe("Null Grammar");
      expect(lumine.grammars.selectGrammar("curb").name).toBe("Null Grammar");
      expect(lumine.grammars.selectGrammar("/hu.git/config").name).toBe("Null Grammar");
    });

    it("uses the filePath's shebang line if the grammar cannot be determined by the extension or basename", async () => {
      await lumine.packages.activatePackage("language-javascript");
      await lumine.packages.activatePackage("language-python");

      const filePath = require.resolve("./fixtures/shebang");
      expect(lumine.grammars.selectGrammar(filePath).name).toBe("Python");
    });

    it("uses the number of newlines in the first line regex to determine the number of lines to test against", () => {
      // Fixtures rather than a real language: the property under test is a
      // `firstLineRegex` that spans a line break, which almost no grammar has,
      // so borrowing one meant the test's precondition lived in someone else's
      // repository and was invisible here.
      lumine.grammars.loadGrammarSync(require.resolve("./fixtures/grammars/one-line-prefix.json"));
      lumine.grammars.loadGrammarSync(require.resolve("./fixtures/grammars/two-line-prefix.json"));

      // A single-line pattern is matched against the first line alone, so
      // anything after it is irrelevant.
      expect(lumine.grammars.selectGrammar("unknown.ext", "ONE-LINE-SENTINEL\nnoise").name).toBe(
        "One Line Prefix",
      );

      // A pattern containing a newline needs that many lines before it can
      // match — one line is not enough.
      expect(lumine.grammars.selectGrammar("unknown.ext", "TWO-LINE-SENTINEL").name).toBe(
        "Null Grammar",
      );
      expect(
        lumine.grammars.selectGrammar("unknown.ext", "TWO-LINE-SENTINEL\nSECOND-LINE").name,
      ).toBe("Two Line Prefix");
    });

    it("scores a grammar with a content regex when there are no contents to match", () => {
      // This needs no contents and a path that is not a file on disk, or the
      // fallback read hides the case under test.
      lumine.grammars.loadGrammarSync(require.resolve("./fixtures/grammars/content-regex.json"));

      expect(() =>
        lumine.grammars.selectGrammar("/no/such/file.content-regex-sentinel"),
      ).not.toThrow();
      expect(lumine.grammars.selectGrammar("/no/such/file.content-regex-sentinel").name).toBe(
        "Content Regex",
      );

      // Matching contents still win it the bonus.
      expect(
        lumine.grammars.getGrammarScore(
          lumine.grammars.grammarForScopeName("source.content-regex"),
          "/no/such/file.content-regex-sentinel",
          "CONTENT-REGEX-SENTINEL",
        ),
      ).toBeGreaterThan(
        lumine.grammars.getGrammarScore(
          lumine.grammars.grammarForScopeName("source.content-regex"),
          "/no/such/file.content-regex-sentinel",
          undefined,
        ),
      );
    });

    it("doesn't read the file when the file contents are specified", async () => {
      await lumine.packages.activatePackage("language-python");

      const filePath = require.resolve("./fixtures/shebang");
      const filePathContents = fs.readFileSync(filePath, "utf8");
      spyOn(fs, "read").and.callThrough();
      expect(lumine.grammars.selectGrammar(filePath, filePathContents).name).toBe("Python");
      expect(fs.read).not.toHaveBeenCalled();
    });

    describe("when multiple grammars have matching fileTypes", () => {
      it("selects the grammar with the longest fileType match", () => {
        const grammarPath = require.resolve("language-javascript/grammars/javascript.json");
        const params = CSON.readFileSync(grammarPath);
        const grammar1 = new TreeSitterGrammar(grammarRegistry, grammarPath, {
          ...params,
          name: "test1",
          scopeName: "source1",
          fileTypes: ["test"],
          injectionNames: [],
        });
        grammarRegistry.addGrammar(grammar1);
        expect(grammarRegistry.selectGrammar("more.test", "")).toBe(grammar1);

        const grammar2 = new TreeSitterGrammar(grammarRegistry, grammarPath, {
          ...params,
          name: "test2",
          scopeName: "source2",
          fileTypes: ["test", "more.test"],
          injectionNames: [],
        });
        grammarRegistry.addGrammar(grammar2);
        expect(grammarRegistry.selectGrammar("more.test", "")).toBe(grammar2);
      });
    });

    it("favors non-bundled packages when breaking scoring ties", async () => {
      await lumine.packages.activatePackage("language-python");
      await lumine.packages.activatePackage(
        path.join(__dirname, "fixtures", "packages", "package-with-py-filetype"),
      );

      lumine.grammars.grammarForScopeName("source.python").bundledPackage = true;
      lumine.grammars.grammarForScopeName("test.py").bundledPackage = false;

      expect(lumine.grammars.selectGrammar("test.py", "#!/usr/bin/env python").scopeName).toBe(
        "source.python",
      );
      expect(lumine.grammars.selectGrammar("test.py", "#!/usr/bin/env testpython").scopeName).toBe(
        "test.py",
      );
      expect(lumine.grammars.selectGrammar("test.py").scopeName).toBe("test.py");
    });

    describe("when there is no file path", () => {
      it("does not throw an exception (regression)", () => {
        expect(() => lumine.grammars.selectGrammar(null, "#!/usr/bin/ruby")).not.toThrow();
        expect(() => lumine.grammars.selectGrammar(null, "")).not.toThrow();
        expect(() => lumine.grammars.selectGrammar(null, null)).not.toThrow();
      });
    });

    describe("when the user has custom grammar file types", () => {
      it("considers the custom file types as well as those defined in the grammar", async () => {
        await lumine.packages.activatePackage("language-python");
        lumine.config.set("core.customFileTypes", {
          "source.python": ["Cheffile"],
        });
        expect(
          lumine.grammars.selectGrammar("build/Cheffile", 'cookbook "postgres"').scopeName,
        ).toBe("source.python");
      });

      it("favors user-defined file types over built-in ones of equal length", async () => {
        await lumine.packages.activatePackage("language-python");
        await lumine.packages.activatePackage("language-shellscript");

        lumine.config.set("core.customFileTypes", {
          "source.shell": ["Snakefile"],
          "source.python": ["zsh-theme"],
        });
        expect(lumine.grammars.selectGrammar("Snakefile", "").scopeName).toBe("source.shell");
        expect(lumine.grammars.selectGrammar("zsh-theme", "").scopeName).toBe("source.python");
      });

      it("favors user-defined file types over grammars with matching first-line-regexps", async () => {
        await lumine.packages.activatePackage("language-python");
        await lumine.packages.activatePackage("language-javascript");

        lumine.config.set("core.customFileTypes", {
          "source.python": ["bootstrap"],
        });
        expect(lumine.grammars.selectGrammar("bootstrap", "#!/usr/bin/env node").scopeName).toBe(
          "source.python",
        );
      });
    });

    it("favors a grammar with a matching file type over one with m matching first line pattern", async () => {
      await lumine.packages.activatePackage("language-python");
      await lumine.packages.activatePackage("language-javascript");
      expect(lumine.grammars.selectGrammar("foo.py", "#!/usr/bin/env node").scopeName).toBe(
        "source.python",
      );
    });

    it("keeps the null grammar when no Tree-sitter grammar matches", () => {
      grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );

      expect(grammarRegistry.selectGrammar("test", "").name).toBe("Null Grammar");
    });

    describe("tree-sitter grammars with content regexes", () => {
      it("recognizes C++ header files", () => {
        grammarRegistry.loadGrammarSync(require.resolve("language-c/grammars/c.json"));
        grammarRegistry.loadGrammarSync(require.resolve("language-c/grammars/cpp.json"));
        grammarRegistry.loadGrammarSync(require.resolve("language-python/grammars/python.json"));

        let grammar = grammarRegistry.selectGrammar(
          "test.h",
          dedent`
          #include <string.h>

          typedef struct {
            void verb();
          } Noun;
        `,
        );
        expect(grammar.name).toBe("C");

        grammar = grammarRegistry.selectGrammar(
          "test.h",
          dedent`
          #include <string>

          class Noun {
           public:
            void verb();
          };
        `,
        );
        expect(grammar.name).toBe("C++");

        // The word `class` only indicates C++ in `.h` files, not in all files.
        grammar = grammarRegistry.selectGrammar(
          "test.py",
          dedent`
          class Noun:
            def verb(self):
              return True
        `,
        );
        expect(grammar.name).toBe("Python");
      });

      it("recognizes C++ files that do not match the content regex (regression)", () => {
        grammarRegistry.loadGrammarSync(require.resolve("language-c/grammars/c.json"));
        grammarRegistry.loadGrammarSync(require.resolve("language-c/grammars/cpp.json"));
        grammarRegistry.loadGrammarSync(require.resolve("language-c/grammars/cpp.json"));

        let grammar = grammarRegistry.selectGrammar(
          "test.cc",
          dedent`
          int a();
        `,
        );
        expect(grammar.name).toBe("C++");
      });

      it("does not apply content regexes from grammars without filetype or first line matches", () => {
        grammarRegistry.loadGrammarSync(require.resolve("language-c/grammars/cpp.json"));

        let grammar = grammarRegistry.selectGrammar(
          "",
          dedent`
          class Foo
            # this is ruby, not C++
          end
        `,
        );

        expect(grammar.name).toBe("Null Grammar");
      });

      it("recognizes shell scripts with shebang lines", () => {
        grammarRegistry.loadGrammarSync(require.resolve("language-shellscript/grammars/bash.json"));

        let grammar = grammarRegistry.selectGrammar(
          "test.h",
          dedent`
          #!/bin/bash

          echo "hi"
        `,
        );
        expect(grammar.name).toBe("Shell Script");
        expect(grammar instanceof TreeSitterGrammar).toBeTruthy();

        grammar = grammarRegistry.selectGrammar(
          "test.h",
          dedent`
          # vim: set ft=bash

          echo "hi"
        `,
        );
        expect(grammar.name).toBe("Shell Script");
        expect(grammar instanceof TreeSitterGrammar).toBeTruthy();
      });
    });
  });

  describe(".removeGrammar(grammar)", () => {
    it("removes the grammar, so it won't be returned by selectGrammar", async () => {
      await lumine.packages.activatePackage("language-css");
      const grammar = lumine.grammars.selectGrammar("foo.css");
      lumine.grammars.removeGrammar(grammar);
      let newGrammar = lumine.grammars.selectGrammar("foo.css");
      expect(
        grammar.name === newGrammar.name &&
          grammar.constructor.name === newGrammar.constructor.name,
      ).toBe(false);
    });

    it("notifies onDidRemoveGrammar subscribers for every grammar a deactivating package removes", async () => {
      await lumine.packages.activatePackage("language-css");
      const removed = [];
      const disposable = lumine.grammars.onDidRemoveGrammar((grammar) =>
        removed.push(grammar.scopeName),
      );
      await lumine.packages.deactivatePackage("language-css");
      disposable.dispose();
      expect(removed).toContain("source.css");
    });

    it("falls back safely and restores an explicit assignment when the grammar returns", () => {
      const grammarPath = require.resolve("language-css/grammars/css.json");
      const grammar = grammarRegistry.loadGrammarSync(grammarPath);
      const buffer = new TextBuffer();
      expect(grammarRegistry.assignLanguageMode(buffer, "source.css")).toBe(true);

      grammarRegistry.removeGrammar(grammar);
      expect(buffer.getLanguageMode().getLanguageId()).toBe("text.plain.null-grammar");
      expect(grammarRegistry.getAssignedLanguageId(buffer)).toBe("source.css");

      const replacement = grammarRegistry.loadGrammarSync(grammarPath);
      expect(buffer.getLanguageMode().grammar).toBe(replacement);
    });
  });

  describe(".treeSitterGrammarForLanguageString(languageString)", () => {
    const grammarPath = require.resolve("language-javascript/grammars/javascript.json");

    function makeInjectionGrammar(scopeName, injectionNames, overrides = {}) {
      const params = CSON.readFileSync(grammarPath);
      return new TreeSitterGrammar(grammarRegistry, grammarPath, {
        ...params,
        name: scopeName,
        scopeName,
        injectionNames,
        ...overrides,
      });
    }

    it("resolves explicit aliases exactly after normalizing case and whitespace", () => {
      const grammar = makeInjectionGrammar("source.test-html", [" HTML ", "html", "Web-HTML"]);
      grammarRegistry.addGrammar(grammar);

      expect(grammar.injectionNames).toEqual(["html", "web-html"]);
      expect(grammarRegistry.treeSitterGrammarForLanguageString("html")).toBe(grammar);
      expect(grammarRegistry.treeSitterGrammarForLanguageString(" HTML ")).toBe(grammar);
      expect(grammarRegistry.treeSitterGrammarForLanguageString("web-HTML")).toBe(grammar);
      expect(grammarRegistry.treeSitterGrammarForLanguageString("xhtml")).toBeNull();
      expect(grammarRegistry.treeSitterGrammarForLanguageString("myhtml")).toBeNull();
      expect(grammarRegistry.treeSitterGrammarForLanguageString("")).toBeNull();
      expect(grammarRegistry.treeSitterGrammarForLanguageString(null)).toBeNull();
    });

    it("rejects alias collisions without partially registering the second grammar", () => {
      const htmlGrammar = makeInjectionGrammar("source.test-html", ["html"]);
      const otherGrammar = makeInjectionGrammar("source.test-other", ["other", " HTML "]);
      grammarRegistry.addGrammar(htmlGrammar);

      expect(() => grammarRegistry.addGrammar(otherGrammar)).toThrowError(
        /injection name 'html'.*source\.test-html.*source\.test-other/,
      );
      expect(grammarRegistry.treeSitterGrammarForLanguageString("html")).toBe(htmlGrammar);
      expect(grammarRegistry.treeSitterGrammarForLanguageString("other")).toBeNull();
      expect(grammarRegistry.grammarForId("source.test-other")).toBeUndefined();
    });

    it("releases aliases on removal so another grammar can claim them", () => {
      const firstGrammar = makeInjectionGrammar("source.test-first", ["shared"]);
      const secondGrammar = makeInjectionGrammar("source.test-second", ["shared"]);
      const registration = grammarRegistry.addGrammar(firstGrammar);

      expect(grammarRegistry.treeSitterGrammarForLanguageString("shared")).toBe(firstGrammar);
      registration.dispose();
      expect(grammarRegistry.treeSitterGrammarForLanguageString("shared")).toBeNull();

      grammarRegistry.addGrammar(secondGrammar);
      expect(grammarRegistry.treeSitterGrammarForLanguageString("shared")).toBe(secondGrammar);
    });
  });

  describe(".addInjectionPoint(languageId, {type, language, content})", () => {
    const injectionPoint = {
      type: "some_node_type",
      language() {
        return "some_language_name";
      },
      content(node) {
        return node;
      },
    };

    let addCallbackFired;
    let updateCallbackFired;
    let addCallbackDisposable;
    let updateCallbackDisposable;

    beforeEach(() => {
      addCallbackFired = false;
      updateCallbackFired = false;
    });

    afterEach(() => {
      addCallbackDisposable?.dispose();
      updateCallbackDisposable?.dispose();
    });

    it("adds an injection point to the grammar with the given id", async () => {
      await lumine.packages.activatePackage("language-javascript");
      lumine.grammars.addInjectionPoint("source.js", injectionPoint);
      const grammar = lumine.grammars.grammarForId("source.js");
      expect(grammar.injectionPointsByType["some_node_type"]).toContain(injectionPoint);
    });

    it("removes an injection point from an already loaded grammar when disposed", async () => {
      await lumine.packages.activatePackage("language-javascript");
      const registration = lumine.grammars.addInjectionPoint("source.js", injectionPoint);
      const grammar = lumine.grammars.grammarForId("source.js");

      registration.dispose();

      expect(grammar.injectionPointsByType["some_node_type"]).toBeUndefined();
    });

    it("fires the onDidUpdateGrammar callback", async () => {
      await lumine.packages.activatePackage("language-javascript");
      lumine.grammars.onDidUpdateGrammar((grammar) => {
        if (grammar.scopeName === "source.js") {
          updateCallbackFired = true;
        }
      });
      lumine.grammars.addInjectionPoint("source.js", injectionPoint);
      expect(updateCallbackFired).toBe(true);
    });

    describe("when called before a grammar with the given id is loaded", () => {
      it("adds the injection point once the grammar is loaded", async () => {
        // Adding an injection point before a grammar loads should not trigger
        // onDidUpdateGrammar at any point.
        updateCallbackDisposable = lumine.grammars.onDidUpdateGrammar((grammar) => {
          if (!grammar.scopeName) {
            updateCallbackFired = true;
          }
        });

        // But onDidAddGrammar should be triggered when the grammar eventually
        // loads.
        addCallbackDisposable = lumine.grammars.onDidAddGrammar((grammar) => {
          if (grammar.scopeName === "source.js") addCallbackFired = true;
        });
        lumine.grammars.addInjectionPoint("source.js", injectionPoint);
        await lumine.packages.activatePackage("language-javascript");
        const grammar = lumine.grammars.grammarForId("source.js");
        expect(grammar.injectionPointsByType["some_node_type"]).toContain(injectionPoint);
        expect(updateCallbackFired).toBe(false);
        expect(addCallbackFired).toBe(true);
      });

      it("does not add an injection point disposed before the grammar loads", async () => {
        const registration = lumine.grammars.addInjectionPoint("source.js", injectionPoint);
        registration.dispose();

        await lumine.packages.activatePackage("language-javascript");
        const grammar = lumine.grammars.grammarForId("source.js");

        expect(grammar.injectionPointsByType["some_node_type"]).toBeUndefined();
      });
    });
  });

  describe("serialization", () => {
    it("persists editors' grammar overrides", async () => {
      const buffer1 = new TextBuffer();
      const buffer2 = new TextBuffer();

      grammarRegistry.loadGrammarSync(require.resolve("language-c/grammars/c.json"));
      grammarRegistry.loadGrammarSync(require.resolve("language-html/grammars/html.json"));
      grammarRegistry.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );

      grammarRegistry.maintainLanguageMode(buffer1);
      grammarRegistry.maintainLanguageMode(buffer2);
      grammarRegistry.assignLanguageMode(buffer1, "source.c");
      grammarRegistry.assignLanguageMode(buffer2, "source.js");

      const buffer1Copy = await TextBuffer.deserialize(buffer1.serialize());
      const buffer2Copy = await TextBuffer.deserialize(buffer2.serialize());

      const grammarRegistryCopy = new GrammarRegistry({ config: lumine.config });
      grammarRegistryCopy.deserialize(JSON.parse(JSON.stringify(grammarRegistry.serialize())));

      grammarRegistryCopy.loadGrammarSync(require.resolve("language-c/grammars/c.json"));
      grammarRegistryCopy.loadGrammarSync(require.resolve("language-html/grammars/html.json"));

      expect(buffer1Copy.getLanguageMode().getLanguageId()).toBe("text.plain.null-grammar");
      expect(buffer2Copy.getLanguageMode().getLanguageId()).toBe("text.plain.null-grammar");

      grammarRegistryCopy.maintainLanguageMode(buffer1Copy);
      grammarRegistryCopy.maintainLanguageMode(buffer2Copy);
      expect(buffer1Copy.getLanguageMode().getLanguageId()).toBe("source.c");
      expect(buffer2Copy.getLanguageMode().getLanguageId()).toBe("text.plain.null-grammar");

      grammarRegistryCopy.loadGrammarSync(
        require.resolve("language-javascript/grammars/javascript.json"),
      );
      expect(buffer1Copy.getLanguageMode().getLanguageId()).toBe("source.c");
      expect(buffer2Copy.getLanguageMode().getLanguageId()).toBe("source.js");
    });
  });

  describe("when working with grammars", () => {
    beforeEach(async () => {
      await lumine.packages.activatePackage("language-javascript");
    });

    it("returns the null sentinel and registered Tree-sitter grammars", () => {
      const grammars = lumine.grammars.getGrammars();
      expect(grammars[0]).toBe(lumine.grammars.nullGrammar);
      expect(grammars.some((grammar) => grammar.scopeName === "source.js")).toBe(true);
      expect(grammars.slice(1).every((grammar) => grammar instanceof TreeSitterGrammar)).toBe(true);
    });

    it("executes the foreach callback for every registered grammar", () => {
      const grammarCount = lumine.grammars.getGrammars().length;
      let i = 0;
      lumine.grammars.forEachGrammar(() => i++);
      expect(i).toBe(grammarCount);
    });
  });
});

function retainedBufferCount(grammarRegistry) {
  return grammarRegistry.grammarScoresByBuffer.size;
}

function subscriptionCount(grammarRegistry) {
  return grammarRegistry.subscriptions.disposables.size;
}
