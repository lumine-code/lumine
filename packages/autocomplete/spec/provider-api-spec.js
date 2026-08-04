const {
  waitForAutocomplete,
  triggerAutocompletion,
  conditionPromise,
  waitForAutocompleteToDisappear,
} = require("./spec-helper");
const path = require("path");

const { Range } = require("atom");

describe("Provider API", () => {
  let [editor, mainModule, autocompleteManager, registration, testProvider, testProvider2] = [];

  beforeEach(async () => {
    atom.workspace.project.setPaths([path.join(__dirname, "fixtures")]);
    jasmine.useRealClock();

    // Set to live completion
    atom.config.set("autocomplete.enableAutoActivation", true);
    atom.config.set("editor.fontSize", "16");

    // Set the completion delay
    atom.config.set("autocomplete.autoActivationDelay", 100);

    let workspaceElement = atom.views.getView(atom.workspace);
    jasmine.attachToDOM(workspaceElement);

    // Activate the package
    await atom.packages.activatePackage("language-javascript");
    editor = await atom.workspace.open("sample.js");
    mainModule = (await atom.packages.activatePackage("autocomplete")).mainModule;

    await conditionPromise(() => {
      autocompleteManager = mainModule.autocompleteManager;
      return autocompleteManager;
    });
  });

  afterEach(() => {
    if (registration && registration.dispose) {
      registration.dispose();
    }
    registration = null;
    if (testProvider && testProvider.dispose) {
      testProvider.dispose();
    }
    testProvider = null;
  });

  describe("registration and suggestions", () => {
    describe("common functionality", () => {
      it("registers the provider specified by [provider]", () => {
        testProvider = {
          scopeSelector: ".source.js,.source.coffee",
          getSuggestions(_options) {
            return [{ text: "ohai", replacementPrefix: "ohai" }];
          },
        };

        expect(
          autocompleteManager.providerManager.applicableProviders(
            ["workspace-center"],
            ".source.js",
          ).length,
        ).toEqual(1);
        registration = atom.packages.serviceHub.provide("autocomplete.provider", "1.0.0", [
          testProvider,
        ]);
        return expect(
          autocompleteManager.providerManager.applicableProviders(
            ["workspace-center"],
            ".source.js",
          ).length,
        ).toEqual(2);
      });

      it("registers the provider specified by the naked provider", () => {
        testProvider = {
          scopeSelector: ".source.js,.source.coffee",
          getSuggestions(_options) {
            return [{ text: "ohai", replacementPrefix: "ohai" }];
          },
        };

        expect(
          autocompleteManager.providerManager.applicableProviders(
            ["workspace-center"],
            ".source.js",
          ).length,
        ).toEqual(1);
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );
        expect(
          autocompleteManager.providerManager.applicableProviders(
            ["workspace-center"],
            ".source.js",
          ).length,
        ).toEqual(2);
      });

      it("registers the provider under the given list of labels, the default being ['workspace-center']", () => {
        testProvider = {
          scopeSelector: ".source.js,.source.coffee",
          getSuggestions(_options) {
            return [{ text: "ohai", replacementPrefix: "ohai" }];
          },
        };
        testProvider2 = {
          labels: ["testProvider2"],
          scopeSelector: ".source.js,.source.coffee",
          getSuggestions(_options) {
            return [{ text: "ohai", replacementPrefix: "ohai" }];
          },
        };

        expect(
          autocompleteManager.providerManager.applicableProviders(
            ["workspace-center"],
            ".source.js",
          ).length,
        ).toEqual(1);
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );
        expect(
          autocompleteManager.providerManager.applicableProviders(
            ["workspace-center"],
            ".source.js",
          ).length,
        ).toEqual(2);
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider2,
        );
        expect(
          autocompleteManager.providerManager.applicableProviders(["testProvider2"], ".source.js")
            .length,
        ).toEqual(1);
        expect(
          autocompleteManager.providerManager.applicableProviders(
            ["testProvider2", "workspace-center"],
            ".source.js",
          ).length,
        ).toEqual(3);
      });

      it("passes the correct parameters to getSuggestions for the version", async () => {
        testProvider = {
          scopeSelector: ".source.js,.source.coffee",
          getSuggestions(_options) {
            return [{ text: "ohai", replacementPrefix: "ohai" }];
          },
        };

        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        spyOn(testProvider, "getSuggestions");
        triggerAutocompletion(editor, true, "o");
        await waitForAutocomplete(editor);

        let args = testProvider.getSuggestions.mostRecentCall.args[0];
        expect(args.editor).toBeDefined();
        expect(args.bufferPosition).toBeDefined();
        expect(args.scopeDescriptor).toBeDefined();
        expect(args.prefix).toBeDefined();

        expect(args.scope).not.toBeDefined();
        expect(args.scopeChain).not.toBeDefined();
        expect(args.buffer).not.toBeDefined();
        expect(args.cursor).not.toBeDefined();
      });

      it("correctly displays the suggestion options", async () => {
        testProvider = {
          scopeSelector: ".source.js, .source.coffee",
          getSuggestions(_options) {
            return [
              {
                text: "ohai",
                replacementPrefix: "o",
                rightLabelHTML: '<span style="color: red">ohai</span>',
                description: "There be documentation",
              },
            ];
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        triggerAutocompletion(editor, true, "o");
        await waitForAutocomplete(editor);

        let suggestionListView = autocompleteManager.suggestionList.suggestionListElement;
        expect(suggestionListView.element.querySelector("li .right-label")).toHaveHtml(
          '<span style="color: red">ohai</span>',
        );
        expect(suggestionListView.element.querySelector(".word")).toHaveText("ohai");
        expect(
          suggestionListView.element.querySelector(".suggestion-description-content"),
        ).toHaveText("There be documentation");
        expect(
          suggestionListView.element.querySelector(".suggestion-description-more-link").style
            .display,
        ).toBe("none");
      });

      it("favors the `displayText` over text or snippet suggestion options", async () => {
        testProvider = {
          scopeSelector: ".source.js, .source.coffee",
          getSuggestions(_options) {
            return [
              {
                text: "ohai",
                snippet: "snippet",
                displayText: "displayOHAI",
                replacementPrefix: "o",
                rightLabelHTML: '<span style="color: red">ohai</span>',
                description: "There be documentation",
              },
            ];
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        triggerAutocompletion(editor, true, "o");
        await waitForAutocomplete(editor);

        let suggestionListView = autocompleteManager.suggestionList.suggestionListElement;
        expect(suggestionListView.element.querySelector(".word")).toHaveText("displayOHAI");
      });

      it("correctly displays the suggestion description and More link", async () => {
        testProvider = {
          scopeSelector: ".source.js, .source.coffee",
          getSuggestions(_options) {
            return [
              {
                text: "ohai",
                replacementPrefix: "o",
                rightLabelHTML: '<span style="color: red">ohai</span>',
                description: "There be documentation",
                descriptionMoreURL: "http://google.com",
              },
            ];
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        triggerAutocompletion(editor, true, "o");
        await waitForAutocomplete(editor);

        let suggestionListView = autocompleteManager.suggestionList.suggestionListElement;
        let content = suggestionListView.element.querySelector(".suggestion-description-content");
        let moreLink = suggestionListView.element.querySelector(
          ".suggestion-description-more-link",
        );
        expect(content).toHaveText("There be documentation");
        expect(moreLink).toHaveText("More..");
        expect(moreLink.style.display).toBe("inline");
        expect(moreLink.getAttribute("href")).toBe("http://google.com");
      });

      it("it calls getSuggestionDetailsOnSelect if available and replaces suggestion", async () => {
        testProvider = {
          scopeSelector: ".source.js, .source.coffee",
          getSuggestions(_options) {
            return [
              {
                text: "ohai",
              },
            ];
          },
          getSuggestionDetailsOnSelect(suggestion) {
            return Object.assign({}, suggestion, { description: "foo" });
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        triggerAutocompletion(editor, true, "o");
        await waitForAutocomplete(editor);

        expect(autocompleteManager.suggestionList.items[0].description).toBe("foo");
      });

      it("waits for an in-flight detail request before inserting", async () => {
        let releaseDetail;
        const detailArrived = new Promise((resolve) => {
          releaseDetail = resolve;
        });
        testProvider = {
          scopeSelector: ".source.js, .source.coffee",
          getSuggestions(_options) {
            return [{ text: "ohai" }];
          },
          getSuggestionDetailsOnSelect(suggestion) {
            // The edits an auto-import would carry only exist after resolve.
            return detailArrived.then(() =>
              Object.assign({}, suggestion, {
                additionalTextEdits: [
                  { newText: "// imported\n", range: new Range([0, 0], [0, 0]) },
                ],
              }),
            );
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        triggerAutocompletion(editor, true, "o");
        await waitForAutocomplete(editor);

        // Confirm while the detail is still pending, then let it land.
        const confirmed = autocompleteManager.confirm(autocompleteManager.suggestionList.items[0]);
        releaseDetail();
        await confirmed;

        expect(editor.getText()).toContain("// imported");
      });

      it("inserts without the detail when the provider is too slow", async () => {
        testProvider = {
          scopeSelector: ".source.js, .source.coffee",
          getSuggestions(_options) {
            return [{ text: "ohai" }];
          },
          // Never resolves: confirming must fall back to the plain suggestion
          // rather than hanging on it.
          getSuggestionDetailsOnSelect(_suggestion) {
            return new Promise(() => {});
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        triggerAutocompletion(editor, true, "o");
        await waitForAutocomplete(editor);

        await autocompleteManager.confirm(autocompleteManager.suggestionList.items[0]);
        expect(editor.getText()).toContain("ohai");
      });
    });

    describe("when the filterSuggestions option is set to true", () => {
      let getSuggestions = () =>
        autocompleteManager.suggestionList.items.map(({ text }) => ({ text }));

      beforeEach(() => editor.setText(""));

      it("filters suggestions based on the default prefix", async () => {
        testProvider = {
          scopeSelector: ".source.js",
          filterSuggestions: true,
          getSuggestions(_options) {
            return [
              { text: "okwow" },
              { text: "ohai" },
              { text: "ok" },
              { text: "cats" },
              { text: "something" },
            ];
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        editor.insertText("o");
        editor.insertText("k");
        await waitForAutocomplete(editor);

        expect(getSuggestions()).toEqual([{ text: "ok" }, { text: "okwow" }]);
      });

      it("filters suggestions based on the specified replacementPrefix for each suggestion", async () => {
        testProvider = {
          scopeSelector: ".source.js",
          filterSuggestions: true,
          getSuggestions(_options) {
            return [
              { text: "ohai" },
              { text: "hai" },
              { text: "okwow", replacementPrefix: "z" },
              { text: "ok", replacementPrefix: "nope" },
              { text: "::cats", replacementPrefix: "::c" },
              { text: "something", replacementPrefix: "sm" },
            ];
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        editor.insertText("h");
        await waitForAutocomplete(editor);

        expect(getSuggestions()).toEqual([
          { text: "::cats" },
          { text: "hai" },
          { text: "ohai" },
          { text: "something" },
        ]);
      });

      it("ranks a literal prefix match above what the provider prefers", async () => {
        testProvider = {
          scopeSelector: ".source.js",
          filterSuggestions: true,
          getSuggestions(_options) {
            // "sFooNo" contains s, f, n in order, so it matches as a
            // subsequence; only "sfn" starts with what was typed. The provider
            // ranks the subsequence first, and must not win: what the user
            // typed outranks a provider's opinion, and only decides between
            // items that answer it equally well.
            return [
              { text: "sFooNo", sortText: "a" },
              { text: "sfn", sortText: "b" },
            ];
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        editor.insertText("s");
        editor.insertText("f");
        editor.insertText("n");
        await waitForAutocomplete(editor);

        expect(getSuggestions()[0]).toEqual({ text: "sfn" });
      });

      it("matches against filterText when a provider supplies one", async () => {
        testProvider = {
          scopeSelector: ".source.js",
          filterSuggestions: true,
          getSuggestions(_options) {
            // The inserted text shares no characters with the query, so only
            // the provider's filterText can match it — which is the point of
            // the field.
            return [
              { text: "@@@", filterText: "foo" },
              { text: "###", filterText: "bar" },
            ];
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        editor.insertText("f");
        editor.insertText("o");
        await waitForAutocomplete(editor);

        expect(getSuggestions()).toEqual([{ text: "@@@" }]);
      });

      it("uses sortText to order suggestions that match equally well", async () => {
        testProvider = {
          scopeSelector: ".source.js",
          filterSuggestions: true,
          getSuggestions(_options) {
            // Both are exact prefix matches of "op", so the provider's own
            // preference decides.
            return [
              { text: "opBeta", sortText: "z" },
              { text: "opAlpha", sortText: "a" },
            ];
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        editor.insertText("o");
        editor.insertText("p");
        await waitForAutocomplete(editor);

        expect(getSuggestions()).toEqual([{ text: "opAlpha" }, { text: "opBeta" }]);
      });

      it("filters suggestions carrying a textEdit like any other", async () => {
        testProvider = {
          scopeSelector: ".source.js",
          filterSuggestions: true,
          getSuggestions(_options) {
            // A textEdit replaces the word being typed, so the prefix is
            // meaningful; exempting these from filtering left an entire LSP
            // list unfiltered.
            const range = [
              [0, 0],
              [0, 2],
            ];
            return [
              { text: "okay", textEdit: { range, newText: "okay" } },
              { text: "nope", textEdit: { range, newText: "nope" } },
            ];
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        editor.insertText("o");
        editor.insertText("k");
        await waitForAutocomplete(editor);

        expect(getSuggestions()).toEqual([{ text: "okay" }]);
      });

      it("allows all suggestions when the prefix is an empty string / space", async () => {
        testProvider = {
          scopeSelector: ".source.js",
          filterSuggestions: true,
          getSuggestions(_options) {
            return [
              { text: "ohai" },
              { text: "hai" },
              { text: "okwow", replacementPrefix: " " },
              { text: "ok", replacementPrefix: "nope" },
            ];
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );

        editor.insertText("h");
        editor.insertText(" ");
        await waitForAutocomplete(editor);

        expect(getSuggestions()).toEqual([{ text: "ohai" }, { text: "hai" }, { text: "okwow" }]);
      });
    });
  });

  describe("removing redundant suggestions", () => {
    it("drops a bare duplicate of a richer suggestion", () => {
      // What the buffer-word provider produces alongside a real completion of
      // the same name.
      const shown = autocompleteManager.removeRedundantSuggestions([
        { text: "map", leftLabel: "(method)", description: "Calls a function." },
        { text: "map" },
      ]);
      expect(shown.length).toBe(1);
      expect(shown[0].leftLabel).toBe("(method)");
    });

    it("drops a suggestion that repeats one already shown", () => {
      const shown = autocompleteManager.removeRedundantSuggestions([
        { text: "map", leftLabel: "(method)" },
        { text: "map", leftLabel: "(method)" },
      ]);
      expect(shown.length).toBe(1);
    });

    it("keeps the same symbol offered from two different modules", () => {
      // Both insert "readFile" and differ only in where it comes from and the
      // import each brings. Collapsing them would choose a module silently.
      const shown = autocompleteManager.removeRedundantSuggestions([
        { text: "readFile", rightLabel: "node:fs" },
        { text: "readFile", rightLabel: "node:fs/promises" },
      ]);
      expect(shown.length).toBe(2);
      expect(shown.map((item) => item.rightLabel)).toEqual(["node:fs", "node:fs/promises"]);
    });

    it("keeps suggestions that insert different text", () => {
      const shown = autocompleteManager.removeRedundantSuggestions([
        { text: "map" },
        { text: "filter" },
      ]);
      expect(shown.length).toBe(2);
    });

    it("tells a snippet apart from a word that inserts the same text", () => {
      const shown = autocompleteManager.removeRedundantSuggestions([
        { snippet: "for (${1:i}) {}", displayText: "for" },
        { text: "for" },
      ]);
      expect(shown.length).toBe(2);
    });
  });

  describe("range-based replacement", () => {
    const triggerAutocompletion = () => {
      atom.commands.dispatch(atom.views.getView(editor), "autocomplete:activate");
      return waitForAutocomplete(editor);
    };
    const confirmChoice = () => {
      atom.commands.dispatch(atom.views.getView(editor), "autocomplete:confirm");
      return waitForAutocompleteToDisappear(editor);
    };

    beforeEach(() => {
      editor.setText("");
      // Collapses to a single cursor: a spec that adds one would otherwise
      // leave it in place for the next.
      editor.setCursorBufferPosition([0, 0]);
    });

    it("applies a textEdit at every cursor", () => {
      editor.setText("oh\noh\n");
      editor.setCursorBufferPosition([0, 2]);
      editor.addCursorAtBufferPosition([1, 2]);

      // Driven directly rather than through the popup: the insertion path is
      // what is under test, and a suggestion list needs a single cursor's
      // worth of activation machinery to open at all.
      autocompleteManager.replaceTextWithMatch({
        text: "ohai",
        // As a server reports it: the range covers the typed prefix and ends
        // at the cursor the request was made for — the last one, on row 1.
        textEdit: {
          range: [
            [1, 0],
            [1, 2],
          ],
          newText: "ohai",
        },
      });

      // Applying the edit once leaves the other line as "oh".
      expect(editor.getText()).toBe("ohai\nohai\n");
    });

    it("re-indents a multi-line plain-text edit when asked to", () => {
      editor.setText("  const x = 1;\n");
      editor.setCursorBufferPosition([0, 14]);

      autocompleteManager.replaceTextWithMatch({
        text: "block",
        // LSP insertTextMode 2: adjust the inserted lines to their new
        // surroundings. Plain text has no tab stops, so nothing else does it.
        insertTextMode: 2,
        textEdit: {
          range: [
            [0, 14],
            [0, 14],
          ],
          newText: "\nif (x) {\nreturn x;\n}",
        },
      });

      const lines = editor.getText().split("\n");
      expect(lines[1].startsWith("  ")).toBe(true);
      expect(lines[2].startsWith("    ")).toBe(true);
    });

    it("leaves a multi-line plain-text edit alone by default", () => {
      editor.setText("  const x = 1;\n");
      editor.setCursorBufferPosition([0, 14]);

      autocompleteManager.replaceTextWithMatch({
        text: "block",
        textEdit: {
          range: [
            [0, 14],
            [0, 14],
          ],
          newText: "\nif (x) {\nreturn x;\n}",
        },
      });

      expect(editor.getText().split("\n")[1]).toBe("if (x) {");
    });

    it("applies a textEdit once when there is a single cursor", () => {
      editor.setText("oh\noh\n");
      editor.setCursorBufferPosition([0, 2]);

      autocompleteManager.replaceTextWithMatch({
        text: "ohai",
        textEdit: {
          range: [
            [0, 0],
            [0, 2],
          ],
          newText: "ohai",
        },
      });

      expect(editor.getText()).toBe("ohai\noh\n");
    });

    it("replaces the right range on the editor when `range` is present", async () => {
      testProvider = {
        scopeSelector: ".source.js",
        filterSuggestions: true,
        getSuggestions(_options) {
          return [
            {
              text: "ohai",
              ranges: [
                [
                  [0, 0],
                  [0, 5],
                ],
                [
                  [0, 7],
                  [0, 12],
                ],
              ],
            },
            { text: "ca.ts" },
            { text: "::dogs" },
          ];
        },
      };
      registration = atom.packages.serviceHub.provide(
        "autocomplete.provider",
        "1.0.0",
        testProvider,
      );
      editor.insertText("hello, world\n");
      await triggerAutocompletion();
      await confirmChoice(0);

      expect(editor.getText()).toEqual("ohai, ohai\n");
    });

    describe("when `firstCharacterMustMatch` is `true`", () => {
      beforeEach(() => {
        atom.config.set("autocomplete.firstCharacterMustMatch", true);
      });

      it("ignores `prefix` if `ranges` is present", async () => {
        testProvider = {
          scopeSelector: ".source.js",
          filterSuggestions: true,
          getSuggestions(_options) {
            return [
              {
                text: "notmatch/foololohairange",
                ranges: [
                  [
                    [0, 0],
                    [0, 5],
                  ],
                ],
              },
              { text: "notmatch/foololohaiprefix" },
              { text: "foololohaiprefix2" },
            ];
          },
        };
        registration = atom.packages.serviceHub.provide(
          "autocomplete.provider",
          "1.0.0",
          testProvider,
        );
        editor.insertText("foololohai");
        await triggerAutocompletion();

        // Because we're pruning results whose first characters do not match
        // the first character of the prefix, both `notmatch/` options would
        // ordinarily be removed — except one of them has `ranges` defined, so
        // it's wrong to prune it because it is operating on an arbitrary
        // buffer range.
        expect(document.querySelector("autocomplete-suggestion-list").innerText).toMatch(
          /notmatch\/foololohairange/,
        );
        expect(document.querySelector("autocomplete-suggestion-list").innerText).toMatch(
          /foololohaiprefix2/,
        );
        expect(document.querySelector("autocomplete-suggestion-list").innerText).toNotMatch(
          /notmatch\/foololohaiprefix/,
        );
      });
    });

    it("does not remove a non-matching suggestion if `ranges` is present", async () => {
      testProvider = {
        scopeSelector: ".source.js",
        filterSuggestions: true,
        getSuggestions(_options) {
          return [
            {
              text: "notmatch/anything",
              ranges: [
                [
                  [0, 0],
                  [0, 5],
                ],
              ],
            },
            { text: "notmatch/foololohaiprefix" },
            { text: "foololohaiprefix2" },
          ];
        },
      };
      registration = atom.packages.serviceHub.provide(
        "autocomplete.provider",
        "1.0.0",
        testProvider,
      );
      editor.insertText("foololohai");
      await triggerAutocompletion();

      // Because we are applying true fuzzy search to all suggestions, only
      // those that score 0 will be removed. Hence `notmatch/foololohaiprefix`
      // remains even though the matching prefix does not start the string.
      //
      // `notmatch/anything` also remains because it specifies `ranges`,
      // meaning that it operates on an arbitrary buffer range.
      expect(document.querySelector("autocomplete-suggestion-list").innerText).toMatch(
        /notmatch\/anything/,
      );
      expect(document.querySelector("autocomplete-suggestion-list").innerText).toMatch(
        /foololohaiprefix2/,
      );
      expect(document.querySelector("autocomplete-suggestion-list").innerText).toMatch(
        /notmatch\/foololohaiprefix/,
      );
    });
  });

  describe("text edits", () => {
    function triggerAutocompletion() {
      atom.commands.dispatch(atom.views.getView(editor), "autocomplete:activate");
      return waitForAutocomplete(editor);
    }

    function confirmChoice() {
      atom.commands.dispatch(atom.views.getView(editor), "autocomplete:confirm");
      return waitForAutocompleteToDisappear(editor);
    }

    beforeEach(async () => {
      await atom.packages.activatePackage("snippets");
      editor.setText("");
    });

    it("replaces the correct range on the editor when `textEdit` is present", async () => {
      testProvider = {
        scopeSelector: ".source.js",
        filterSuggestions: true,
        getSuggestions() {
          return [
            {
              text: "ohai",
              textEdit: {
                range: [
                  { row: 0, column: 0 },
                  { row: 0, column: 5 },
                ],
                newText: "kbye",
              },
            },
            { text: "ca.ts" },
            { text: "::dogs" },
          ];
        },
      };
      registration = atom.packages.serviceHub.provide(
        "autocomplete.provider",
        "1.0.0",
        testProvider,
      );
      editor.insertText("hello, world\n");

      await triggerAutocompletion();
      await confirmChoice(0);

      expect(editor.getText()).toEqual("kbye, world\n");
    });

    it("applies the suggestion as a snippet when `textEdit` is present and `snippet` is truthy", async () => {
      testProvider = {
        scopeSelector: ".source.js",
        filterSuggestions: true,
        getSuggestions() {
          return [
            {
              text: "ohai",
              textEdit: {
                range: [
                  { row: 0, column: 0 },
                  { row: 0, column: 5 },
                ],
                newText: "kb${1:yyy}ye",
              },
              snippet: "x",
            },
            { text: "ca.ts" },
            { text: "::dogs" },
          ];
        },
      };
      registration = atom.packages.serviceHub.provide(
        "autocomplete.provider",
        "1.0.0",
        testProvider,
      );
      editor.insertText("hello, world\n");

      await triggerAutocompletion();
      await confirmChoice(0);

      expect(editor.getText()).toEqual("kbyyyye, world\n");
      let cursor = editor.getLastCursor();
      expect(cursor.getBufferPosition()).toEqual([0, 5]);
      expect(editor.getSelectedText()).toEqual("yyy");
    });

    it("applies the suggestion as plain text when `textEdit` is present and `snippet` is falsy", async () => {
      testProvider = {
        scopeSelector: ".source.js",
        filterSuggestions: true,
        getSuggestions() {
          return [
            {
              text: "ohai",
              textEdit: {
                range: [
                  { row: 0, column: 0 },
                  { row: 0, column: 5 },
                ],
                newText: "kb${1:yyy}ye",
              },
              snippet: 0,
            },
            { text: "ca.ts" },
            { text: "::dogs" },
          ];
        },
      };
      registration = atom.packages.serviceHub.provide(
        "autocomplete.provider",
        "1.0.0",
        testProvider,
      );
      editor.insertText("hello, world\n");

      await triggerAutocompletion();
      await confirmChoice(0);

      expect(editor.getText()).toEqual("kb${1:yyy}ye, world\n");
    });

    it("applies the textEdit if it is present", async () => {
      testProvider = {
        scopeSelector: ".source.js",
        filterSuggestions: true,
        getSuggestions() {
          return [
            {
              text: "ohai",
              textEdit: {
                range: [
                  [2, 0],
                  [2, 5],
                ],
                // Our new text will insert a newline, thereby changing the
                // buffer range of one of our `additionalTextEdits`.
                newText: "kbye\n",
              },
            },
            { text: "ca.ts" },
            { text: "::dogs" },
          ];
        },
      };
      registration = atom.packages.serviceHub.provide(
        "autocomplete.provider",
        "1.0.0",
        testProvider,
      );
      editor.insertText("\nlorem\nhello, world\ndolor\n");

      await triggerAutocompletion();
      await confirmChoice(0);

      expect(editor.getText()).toEqual("\nlorem\nkbye\n, world\ndolor\n");
    });

    it("applies additional text edits if they are specified on the suggestion, even if their original buffer ranges are invalidated", async () => {
      testProvider = {
        scopeSelector: ".source.js",
        filterSuggestions: true,
        getSuggestions() {
          return [
            {
              text: "ohai",
              textEdit: {
                range: [
                  [2, 0],
                  [2, 5],
                ],
                // Our new text will insert a newline, thereby changing the
                // buffer range of one of our `additionalTextEdits`.
                newText: "kbye\n",
              },
              additionalTextEdits: [
                {
                  range: [
                    [1, 0],
                    [1, 5],
                  ],
                  newText: "ipsum",
                },
                { range: new Range([3, 0], [3, 5]), newText: "amet" },
              ],
            },
            { text: "ca.ts" },
            { text: "::dogs" },
          ];
        },
      };
      registration = atom.packages.serviceHub.provide(
        "autocomplete.provider",
        "1.0.0",
        testProvider,
      );
      editor.insertText("\nlorem\nhello, world\ndolor\n");

      await triggerAutocompletion();
      await confirmChoice(0);

      expect(editor.getText()).toEqual("\nipsum\nkbye\n, world\namet\n");
    });

    it("applies additional text edits as plain text, even when the main suggestion insertion is a snippet", async () => {
      testProvider = {
        scopeSelector: ".source.js",
        filterSuggestions: true,
        getSuggestions() {
          return [
            {
              text: "ohai",
              textEdit: {
                range: [
                  [2, 0],
                  [2, 5],
                ],
                // Our new text will insert a newline, thereby changing the
                // buffer range of one of our `additionalTextEdits`.
                newText: "k$0bye\n",
              },
              // Even though the main suggestion will be inserted as a snippet,
              // it makes no sense to treat `additionalTextEdits` insertions as
              // snippets, since they're not added interactively.
              snippet: true,
              additionalTextEdits: [
                {
                  range: [
                    [1, 0],
                    [1, 5],
                  ],
                  newText: "ips$0um",
                },
                { range: new Range([3, 0], [3, 5]), newText: "ame$0t" },
              ],
            },
            { text: "ca.ts" },
            { text: "::dogs" },
          ];
        },
      };
      registration = atom.packages.serviceHub.provide(
        "autocomplete.provider",
        "1.0.0",
        testProvider,
      );
      editor.insertText("\nlorem\nhello, world\ndolor\n");

      await triggerAutocompletion();
      await confirmChoice(0);

      expect(editor.getText()).toEqual("\nips$0um\nkbye\n, world\name$0t\n");
    });
  });
});
