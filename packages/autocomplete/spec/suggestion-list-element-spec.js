const SuggestionListElement = require("../lib/suggestion-list-element");
const { conditionPromise } = require("./spec-helper");

const fragmentToHtml = (fragment) => {
  const el = document.createElement("span");
  el.appendChild(fragment.cloneNode(true));
  return el.innerHTML;
};

describe("Suggestion List Element", () => {
  let [suggestionListElement] = [];

  beforeEach(() => {
    suggestionListElement = new SuggestionListElement();
  });

  afterEach(() => {
    if (suggestionListElement) {
      suggestionListElement.dispose();
    }
    suggestionListElement = null;
  });

  describe("renderItem", () => {
    beforeEach(() => jasmine.attachToDOM(suggestionListElement.element));

    it("HTML escapes displayText", () => {
      let suggestion = { text: "Animal<Cat>" };
      suggestionListElement.renderItem(suggestion);
      expect(suggestionListElement.selectedLi.innerHTML).toContain("Animal&lt;Cat&gt;");

      suggestion = { text: "Animal<Cat>", displayText: "Animal<Cat>" };
      suggestionListElement.renderItem(suggestion);
      expect(suggestionListElement.selectedLi.innerHTML).toContain("Animal&lt;Cat&gt;");

      suggestion = { snippet: "Animal<Cat>", displayText: "Animal<Cat>" };
      suggestionListElement.renderItem(suggestion);
      expect(suggestionListElement.selectedLi.innerHTML).toContain("Animal&lt;Cat&gt;");
    });

    it("HTML escapes snippets", () => {
      let suggestion = { snippet: "Animal<Cat>(${1:omg<wow>}, ${2:ok<yeah>})" };
      suggestionListElement.renderItem(suggestion);
      expect(suggestionListElement.selectedLi.innerHTML).toContain("Animal&lt;Cat&gt;");
      expect(suggestionListElement.selectedLi.innerHTML).toContain("omg&lt;wow&gt;");
      expect(suggestionListElement.selectedLi.innerHTML).toContain("ok&lt;yeah&gt;");

      suggestion = {
        snippet: "Animal<Cat>(${1:omg<wow>}, ${2:ok<yeah>})",
        displayText: "Animal<Cat>(omg<wow>, ok<yeah>)",
      };
      suggestionListElement.renderItem(suggestion);
      expect(suggestionListElement.selectedLi.innerHTML).toContain("Animal&lt;Cat&gt;");
      expect(suggestionListElement.selectedLi.innerHTML).toContain("omg&lt;wow&gt;");
      expect(suggestionListElement.selectedLi.innerHTML).toContain("ok&lt;yeah&gt;");
    });

    it("renders a letter icon for types that only exist on Object.prototype", () => {
      // "constructor" resolves through the prototype of the icon-class map, so
      // a truthiness check set the class name to the source of Object itself.
      suggestionListElement.renderItem({ text: "Thing", type: "constructor" });
      const icon = suggestionListElement.selectedLi.querySelector(".icon");
      expect(icon.classList.contains("constructor")).toBe(true);
      expect(icon.innerHTML).not.toContain("native code");
      const letter = icon.querySelector(".icon-letter");
      expect(letter).not.toBeNull();
      expect(letter.textContent).toBe("c");
    });

    it("still maps the types that do have an icon class", () => {
      suggestionListElement.renderItem({ text: "Thing", type: "snippet" });
      const icon = suggestionListElement.selectedLi.querySelector(".icon");
      expect(icon.querySelector(".icon-move-right")).not.toBeNull();
    });

    it("renders the label detail after the word", () => {
      suggestionListElement.renderItem({ text: "readFile", displayTextDetail: "(path: string)" });
      const container = suggestionListElement.selectedLi.querySelector(".word-container");
      expect(container.querySelector(".word").textContent).toBe("readFile");
      expect(container.querySelector(".word-detail").textContent).toBe("(path: string)");
      // The word span is rebuilt on every render; the detail must survive it.
      expect(container.querySelector(".word").nextElementSibling).toBe(
        container.querySelector(".word-detail"),
      );
    });

    it("empties the label detail when a suggestion has none", () => {
      suggestionListElement.renderItem({ text: "readFile", displayTextDetail: "(path: string)" });
      suggestionListElement.renderItem({ text: "readFile" });
      expect(suggestionListElement.selectedLi.querySelector(".word-detail").textContent).toBe("");
    });

    it("HTML escapes the label detail", () => {
      suggestionListElement.renderItem({ text: "get", displayTextDetail: "(): Animal<Cat>" });
      expect(suggestionListElement.selectedLi.querySelector(".word-detail").innerHTML).toContain(
        "Animal&lt;Cat&gt;",
      );
    });

    it("starts on the entry a provider preselected", () => {
      suggestionListElement.model = {
        items: [{ text: "first" }, { text: "second", preselect: true }, { text: "third" }],
        select() {},
      };
      suggestionListElement.render();
      expect(suggestionListElement.selectedIndex).toBe(1);
      // Still the default selection: the user has not moved yet, so
      // confirm-if-non-default must not treat this as a deliberate choice.
      expect(suggestionListElement.nonDefaultIndex).toBe(false);
    });

    it("starts on the first entry when none is preselected", () => {
      suggestionListElement.model = {
        items: [{ text: "first" }, { text: "second" }],
        select() {},
      };
      suggestionListElement.render();
      expect(suggestionListElement.selectedIndex).toBe(0);
    });

    it("reuses pooled list items instead of building new ones", () => {
      suggestionListElement.renderItem({ text: "one" }, 0);
      const li = suggestionListElement.ol.childNodes[0];

      suggestionListElement.returnItemsToPool(0);
      expect(suggestionListElement.nodePool.length).toBe(1);

      // The pool exists to keep the list from allocating a row per keystroke;
      // a misspelled read of it made every render build fresh nodes and let
      // the pool grow without bound.
      suggestionListElement.renderItem({ text: "two" }, 0);
      expect(suggestionListElement.ol.childNodes[0]).toBe(li);
      expect(suggestionListElement.nodePool.length).toBe(0);
    });

    it("HTML escapes labels", () => {
      let suggestion = { text: "something", leftLabel: "Animal<Cat>", rightLabel: "Animal<Dog>" };
      suggestionListElement.renderItem(suggestion);
      expect(suggestionListElement.selectedLi.querySelector(".left-label").innerHTML).toContain(
        "Animal&lt;Cat&gt;",
      );
      return expect(
        suggestionListElement.selectedLi.querySelector(".right-label").innerHTML,
      ).toContain("Animal&lt;Dog&gt;");
    });
  });

  describe("deferred rendering", () => {
    const modelWith = (count) => ({
      items: Array.from({ length: count }, (_, index) => ({ text: `item${index}` })),
      select() {},
    });

    beforeEach(() => {
      jasmine.attachToDOM(suggestionListElement.element);
      suggestionListElement.maxVisibleSuggestions = 2;
    });

    it("caps the list and selects from the same capped list", () => {
      // The cap is observed from `autocomplete.maxSuggestions` when a model is
      // attached; set directly here because this element is built without one.
      suggestionListElement.maxItems = 3;
      suggestionListElement.model = modelWith(10);
      suggestionListElement.render();

      expect(suggestionListElement.visibleItems().length).toBe(3);
      // Selection must read the capped list too: indexing the model's full
      // list agreed only while the selection could not exceed the cap.
      suggestionListElement.selectedIndex = 5;
      expect(suggestionListElement.getSelectedItem()).toBeUndefined();
      suggestionListElement.selectedIndex = 2;
      expect(suggestionListElement.getSelectedItem()).toBe(suggestionListElement.model.items[2]);
    });

    it("exposes the cap as a setting", () => {
      const { configSchema } = require("../package.json");
      expect(configSchema.maxSuggestions.default).toBe(200);
      expect(configSchema.maxSuggestions.minimum).toBe(1);
    });

    it("renders the deferred rows when the selection lands on the first of them", () => {
      suggestionListElement.model = modelWith(5);
      suggestionListElement.render();
      // Rows 0 through `maxVisibleSuggestions` are rendered eagerly; the rest
      // wait for a scroll or a selection.
      expect(suggestionListElement.ol.childNodes.length).toBe(3);

      // Exactly `maxVisibleSuggestions + 1` is the first unrendered row, so a
      // strict `>` here left the selection with no node to highlight.
      suggestionListElement.setSelectedIndex(3);
      expect(suggestionListElement.ol.childNodes.length).toBe(5);
      expect(suggestionListElement.ol.childNodes[3].classList.contains("selected")).toBe(true);
    });

    it("renders the deferred rows a chunk at a time", () => {
      suggestionListElement.model = modelWith(120);
      suggestionListElement.render();
      expect(suggestionListElement.ol.childNodes.length).toBe(3);

      suggestionListElement.renderExtraItems();
      // One frame's worth. Writing all 117 remaining rows in the frame the
      // user scrolled in is what this avoids.
      expect(suggestionListElement.ol.childNodes.length).toBe(53);
      expect(suggestionListElement.extraItems.length).toBe(67);
    });

    it("keeps rendering until every deferred row exists", async () => {
      jasmine.useRealClock();
      suggestionListElement.model = modelWith(120);
      suggestionListElement.render();

      suggestionListElement.renderExtraItems();
      await conditionPromise(() => suggestionListElement.extraItems == null);
      expect(suggestionListElement.ol.childNodes.length).toBe(120);
    });

    it("renders far enough to reach a selection beyond the first chunk", () => {
      suggestionListElement.model = modelWith(120);
      suggestionListElement.render();

      // A page-down or an end key jumps past a chunk boundary, and
      // `renderSelectedItem` runs before the next frame arrives.
      suggestionListElement.setSelectedIndex(119);
      expect(suggestionListElement.ol.childNodes.length).toBe(120);
      expect(suggestionListElement.ol.childNodes[119].classList.contains("selected")).toBe(true);
    });

    it("drops the pending tail when the list is replaced", () => {
      suggestionListElement.model = modelWith(120);
      suggestionListElement.render();
      suggestionListElement.renderExtraItems();
      expect(suggestionListElement.extraItemsFrame).not.toBeNull();

      suggestionListElement.model = modelWith(4);
      suggestionListElement.render();
      expect(suggestionListElement.extraItemsFrame).toBeNull();
      expect(suggestionListElement.extraItems.length).toBe(1);
    });
  });

  describe("updateDescription", () => {
    let content;

    beforeEach(() => {
      jasmine.attachToDOM(suggestionListElement.element);
      content = suggestionListElement.element.querySelector(".suggestion-description-content");
    });

    it("renders a markdown description", () => {
      suggestionListElement.updateDescription({ descriptionMarkdown: "**bold** and `code`" });
      expect(content.querySelector("strong").textContent).toBe("bold");
      expect(content.querySelector("code").textContent).toBe("code");
      expect(content.classList.contains("markdown-description")).toBe(true);
    });

    it("does not eat a leading rule as front matter", () => {
      suggestionListElement.updateDescription({
        descriptionMarkdown: "---\nkey: value\n---\n\nBody",
      });
      expect(content.textContent).toContain("key: value");
      expect(content.textContent).toContain("Body");
    });

    it("does not rewrite links in provider documentation", () => {
      suggestionListElement.updateDescription({
        descriptionMarkdown: "[docs](https://atom.io/packages/foo)",
      });
      expect(content.querySelector("a").getAttribute("href")).toBe("https://atom.io/packages/foo");
    });

    it("does not turn a wrapped line into a break", () => {
      suggestionListElement.updateDescription({ descriptionMarkdown: "line one\nline two" });
      expect(content.querySelector("br")).toBeNull();
    });

    it("syntax highlights fenced code blocks", () => {
      suggestionListElement.updateDescription({
        descriptionMarkdown: "```js\nlet x = 1\n```",
      });
      // `applySyntaxHighlighting` swaps the `pre` for a read-only editor.
      expect(content.querySelector("pre")).toBeNull();
      const editorElement = content.querySelector("atom-text-editor");
      expect(editorElement).not.toBeNull();
      expect(editorElement.getModel().getText()).toBe("let x = 1");
    });

    it("destroys the code block editors of the previous description", () => {
      suggestionListElement.updateDescription({
        descriptionMarkdown: "```js\nlet x = 1\n```",
      });
      const editor = content.querySelector("atom-text-editor").getModel();

      suggestionListElement.updateDescription({ description: "plain" });
      expect(content.querySelector("atom-text-editor")).toBeNull();
      expect(content.classList.contains("markdown-description")).toBe(false);
      expect(editor.isDestroyed()).toBe(true);
    });

    it("falls back to the plain description", () => {
      suggestionListElement.updateDescription({ description: "**not bold**" });
      expect(content.querySelector("strong")).toBeNull();
      expect(content.textContent).toBe("**not bold**");
    });
  });

  describe("descriptionLength", () => {
    it("measures whichever description will be rendered", () => {
      // The markdown field wins in `updateDescription`, so a markdown-only item
      // has to score for the popup to be sized off the widest one.
      expect(suggestionListElement.descriptionLength({ descriptionMarkdown: "abcd" })).toBe(4);
      expect(suggestionListElement.descriptionLength({ description: "abc" })).toBe(3);
      expect(
        suggestionListElement.descriptionLength({
          description: "ab",
          descriptionMarkdown: "abcd",
        }),
      ).toBe(4);
      expect(
        suggestionListElement.descriptionLength({
          descriptionMarkdown: "abcd",
          descriptionMoreURL: "https://example.com",
        }),
      ).toBe(10);
    });
  });

  describe("itemChanged", () => {
    beforeEach(() => {
      jasmine.useRealClock();
      jasmine.attachToDOM(suggestionListElement.element);
    });

    it("updates the list item", async () => {
      const suggestion = { text: "foo" };
      const newSuggestion = { text: "foo", description: "foobar", rightLabel: "foo" };
      suggestionListElement.model = { items: [newSuggestion] };
      suggestionListElement.selectedIndex = 0;
      suggestionListElement.renderItem(suggestion, 0);
      expect(suggestionListElement.element.querySelector(".right-label").innerText).toBe("");

      suggestionListElement.itemChanged({ suggestion: newSuggestion, index: 0 });

      await conditionPromise(
        () => suggestionListElement.element.querySelector(".right-label").innerText,
      );
      expect(suggestionListElement.element.querySelector(".right-label").innerText).toBe("foo");

      expect(
        suggestionListElement.element.querySelector(".suggestion-description-content").innerText,
      ).toBe("foobar");
    });
  });

  describe("getDisplayHTML", () => {
    it("uses displayText over text or snippet", () => {
      let text = "abcd()";
      let snippet = undefined;
      let displayText = "acd";
      let replacementPrefix = "a";
      let html = suggestionListElement.getDisplayFragment(
        text,
        snippet,
        displayText,
        replacementPrefix,
      );
      expect(fragmentToHtml(html)).toBe('<span class="character-match">a</span>cd');
    });

    it("handles the empty string in the text field", () => {
      let text = "";
      let snippet = undefined;
      let replacementPrefix = "a";
      let html = suggestionListElement.getDisplayFragment(text, snippet, null, replacementPrefix);
      expect(fragmentToHtml(html)).toBe("");
    });

    it("handles the empty string in the snippet field", () => {
      let text = undefined;
      let snippet = "";
      let replacementPrefix = "a";
      let html = suggestionListElement.getDisplayFragment(text, snippet, null, replacementPrefix);
      expect(fragmentToHtml(html)).toBe("");
    });

    it("handles an empty prefix", () => {
      let text = undefined;
      let snippet = "abc";
      let replacementPrefix = "";
      let html = suggestionListElement.getDisplayFragment(text, snippet, null, replacementPrefix);
      expect(fragmentToHtml(html)).toBe("abc");
    });

    it("outputs correct html when there are no snippets in the snippet field", () => {
      let text = "";
      let snippet = "abc(d, e)f";
      let replacementPrefix = "a";
      let html = suggestionListElement.getDisplayFragment(text, snippet, null, replacementPrefix);
      expect(fragmentToHtml(html)).toBe('<span class="character-match">a</span>bc(d, e)f');
    });

    it("outputs correct html when there are not character matches", () => {
      let text = "";
      let snippet = "abc(d, e)f";
      let replacementPrefix = "omg";
      let html = suggestionListElement.getDisplayFragment(text, snippet, null, replacementPrefix);
      expect(fragmentToHtml(html)).toBe("abc(d, e)f");
    });

    it("outputs correct html when the text field is used", () => {
      let text = "abc(d, e)f";
      let snippet = undefined;
      let replacementPrefix = "a";
      let html = suggestionListElement.getDisplayFragment(text, snippet, null, replacementPrefix);
      expect(fragmentToHtml(html)).toBe('<span class="character-match">a</span>bc(d, e)f');
    });

    it("replaces a snippet with no escaped right braces", () => {
      let text = "";
      let snippet = "abc(${1:d}, ${2:e})f";
      let replacementPrefix = "a";
      let html = suggestionListElement.getDisplayFragment(text, snippet, null, replacementPrefix);
      expect(fragmentToHtml(html)).toBe(
        '<span class="character-match">a</span>bc(<span class="snippet-completion">d</span>, <span class="snippet-completion">e</span>)f',
      );
    });

    it("replaces a snippet with no escaped right braces", () => {
      let text = "";
      let snippet = "text(${1:ab}, ${2:cd})";
      let replacementPrefix = "ta";
      let html = suggestionListElement.getDisplayFragment(text, snippet, null, replacementPrefix);
      expect(fragmentToHtml(html)).toBe(
        '<span class="character-match">t</span>ext(<span class="snippet-completion"><span class="character-match">a</span>b</span>, <span class="snippet-completion">cd</span>)',
      );
    });

    it("replaces a snippet with escaped right braces", () => {
      let text = "";
      let snippet = "abc(${1:d}, ${2:e})f ${3:interface{\\}}";
      let replacementPrefix = "a";
      let display = suggestionListElement.getDisplayFragment(
        text,
        snippet,
        null,
        replacementPrefix,
      );
      expect(fragmentToHtml(display)).toBe(
        '<span class="character-match">a</span>bc(<span class="snippet-completion">d</span>, <span class="snippet-completion">e</span>)f <span class="snippet-completion">interface{}</span>',
      );
    });

    it("replaces a snippet with escaped multiple right braces", () => {
      let text = "";
      let snippet = "abc(${1:d}, ${2:something{ok\\}}, ${3:e})f ${4:interface{\\}}";
      let replacementPrefix = "a";
      let display = suggestionListElement.getDisplayFragment(
        text,
        snippet,
        null,
        replacementPrefix,
      );
      expect(fragmentToHtml(display)).toBe(
        '<span class="character-match">a</span>bc(<span class="snippet-completion">d</span>, <span class="snippet-completion">something{ok}</span>, <span class="snippet-completion">e</span>)f <span class="snippet-completion">interface{}</span>',
      );
    });

    it("replaces a snippet with elements that have no text", () => {
      let text = "";
      let snippet = "abc(${1:d}, ${2:e})f${3}";
      let replacementPrefix = "a";
      let display = suggestionListElement.getDisplayFragment(
        text,
        snippet,
        null,
        replacementPrefix,
      );
      expect(fragmentToHtml(display)).toBe(
        '<span class="character-match">a</span>bc(<span class="snippet-completion">d</span>, <span class="snippet-completion">e</span>)f',
      );
    });
  });

  describe("findCharacterMatches", () => {
    let assertMatches = (text, replacementPrefix, truthyIndices) => {
      text = suggestionListElement.removeEmptySnippets(text);
      let snippets = suggestionListElement.snippetParser.findSnippets(text);
      text = suggestionListElement.removeSnippetsFromText(snippets, text);
      let matches = suggestionListElement.findCharacterMatchIndices(text, replacementPrefix);
      matches = new Set(matches);

      for (var i = 0; i <= text.length; i++) {
        if (truthyIndices.indexOf(i) !== -1) {
          expect(matches.has(i)).toBeTruthy();
        } else {
          let m = matches;
          if (m) {
            m = m.has(i);
          }
          expect(m).toBeFalsy();
        }
      }
    };

    it("finds matches when no snippets exist", () => {
      assertMatches("hello", "", []);
      assertMatches("hello", "h", [0]);
      assertMatches("hello", "hl", [0, 2]);
      assertMatches("hello", "hlo", [0, 3, 4]);
    });

    it("finds matches when snippets exist", () => {
      assertMatches("${0:hello}", "", []);
      assertMatches("${0:hello}", "h", [0]);
      assertMatches("${0:hello}", "hl", [0, 2]);
      assertMatches("${0:hello}", "hlo", [0, 3, 4]);
      assertMatches("${0:hello}world", "", []);
      assertMatches("${0:hello}world", "h", [0]);
      assertMatches("${0:hello}world", "hw", [0, 5]);
      assertMatches("${0:hello}world", "hlw", [0, 2, 5]);
      assertMatches("hello${0:world}", "", []);
      assertMatches("hello${0:world}", "h", [0]);
      assertMatches("hello${0:world}", "hw", [0, 5]);
      assertMatches("hello${0:world}", "hlw", [0, 2, 5]);
    });
  });

  describe("removeEmptySnippets", () => {
    it("removes an empty snippet group", () => {
      expect(suggestionListElement.removeEmptySnippets("$0")).toBe("");
      expect(suggestionListElement.removeEmptySnippets("$1000")).toBe("");
    });

    it("removes an empty snippet group with surrounding text", () => {
      expect(suggestionListElement.removeEmptySnippets("hello$0")).toBe("hello");
      expect(suggestionListElement.removeEmptySnippets("$0hello")).toBe("hello");
      expect(suggestionListElement.removeEmptySnippets("hello$0hello")).toBe("hellohello");
      expect(suggestionListElement.removeEmptySnippets("hello$1000hello")).toBe("hellohello");
    });

    it("removes an empty snippet group with braces", () => {
      expect(suggestionListElement.removeEmptySnippets("${0}")).toBe("");
      expect(suggestionListElement.removeEmptySnippets("${1000}")).toBe("");
    });

    it("removes an empty snippet group with braces with surrounding text", () => {
      expect(suggestionListElement.removeEmptySnippets("hello${0}")).toBe("hello");
      expect(suggestionListElement.removeEmptySnippets("${0}hello")).toBe("hello");
      expect(suggestionListElement.removeEmptySnippets("hello${0}hello")).toBe("hellohello");
      expect(suggestionListElement.removeEmptySnippets("hello${1000}hello")).toBe("hellohello");
    });

    it("removes an empty snippet group with braces and a colon", () => {
      expect(suggestionListElement.removeEmptySnippets("${0:}")).toBe("");
      expect(suggestionListElement.removeEmptySnippets("${1000:}")).toBe("");
    });

    it("removes an empty snippet group with braces and a colon with surrounding text", () => {
      expect(suggestionListElement.removeEmptySnippets("hello${0:}")).toBe("hello");
      expect(suggestionListElement.removeEmptySnippets("${0:}hello")).toBe("hello");
      expect(suggestionListElement.removeEmptySnippets("hello${0:}hello")).toBe("hellohello");
      expect(suggestionListElement.removeEmptySnippets("hello${1000:}hello")).toBe("hellohello");
    });
  });

  describe("moveSelectionUp", () => {
    it("decreases the selected index when the current index is greater than zero", () => {
      spyOn(suggestionListElement, "setSelectedIndex");
      suggestionListElement.selectedIndex = 1;

      suggestionListElement.moveSelectionUp();

      expect(suggestionListElement.setSelectedIndex).toHaveBeenCalledWith(0);
    });

    it("dismisses the suggestion list if the current selection is at the start of the list and moveToCancel is true", () => {
      const model = {
        activeEditor: {
          moveUp() {},
        },
        cancel() {},
      };
      spyOn(model.activeEditor, "moveUp");
      spyOn(model, "cancel");

      suggestionListElement.model = model;
      suggestionListElement.selectedIndex = 0;
      suggestionListElement.moveToCancel = true;

      suggestionListElement.moveSelectionUp();

      expect(model.activeEditor.moveUp).toHaveBeenCalledWith(1);
      expect(model.cancel).toHaveBeenCalled();
    });

    it("cycles to the last element in the suggestion list when the current selection is at the start of the list", () => {
      spyOn(suggestionListElement, "visibleItems").andReturn(["a", "b", "c", "d", "e"]);
      spyOn(suggestionListElement, "setSelectedIndex");

      suggestionListElement.moveSelectionUp();

      expect(suggestionListElement.setSelectedIndex).toHaveBeenCalledWith(4);
    });
  });

  describe("moveSelectionDown", () => {
    it("increases the selected index if the current selection is not at the end of the list", () => {
      spyOn(suggestionListElement, "visibleItems").andReturn(["a", "b", "c", "d", "e"]);
      spyOn(suggestionListElement, "setSelectedIndex");
      suggestionListElement.selectedIndex = 3;

      suggestionListElement.moveSelectionDown();

      expect(suggestionListElement.setSelectedIndex).toHaveBeenCalledWith(4);
    });

    it("dismisses the suggestion list if the current selection is at the end of the list and moveToCancel is true", () => {
      const model = {
        activeEditor: {
          moveDown() {},
        },
        cancel() {},
      };
      spyOn(model.activeEditor, "moveDown");
      spyOn(model, "cancel");
      spyOn(suggestionListElement, "visibleItems").andReturn(["a", "b", "c", "d", "e"]);

      suggestionListElement.model = model;
      suggestionListElement.selectedIndex = 4;
      suggestionListElement.moveToCancel = true;

      suggestionListElement.moveSelectionDown();

      expect(model.activeEditor.moveDown).toHaveBeenCalledWith(1);
      expect(model.cancel).toHaveBeenCalled();
    });

    it("cycles to the first element in the suggestion list when the current suggestion is at the end of the list", () => {
      spyOn(suggestionListElement, "visibleItems").andReturn(["a", "b", "c", "d", "e"]);
      spyOn(suggestionListElement, "setSelectedIndex");
      suggestionListElement.selectedIndex = 4;

      suggestionListElement.moveSelectionDown();

      expect(suggestionListElement.setSelectedIndex).toHaveBeenCalledWith(0);
    });
  });

  describe("moveSelectionPageUp", () => {
    it("dismisses the list if moveToCancel is true", () => {
      const model = {
        activeEditor: {
          getScreenLineCount: () => 42,
          moveUp() {},
        },
        cancel() {},
      };
      spyOn(model.activeEditor, "moveUp");
      spyOn(model, "cancel");

      suggestionListElement.model = model;
      suggestionListElement.moveToCancel = true;

      suggestionListElement.moveSelectionPageUp();

      expect(model.activeEditor.moveUp).toHaveBeenCalledWith(42);
      expect(model.cancel).toHaveBeenCalled();
    });
  });

  describe("moveSelectionPageDown", () => {
    it("dismisses the list if moveToCancel is true", () => {
      const model = {
        activeEditor: {
          getScreenLineCount: () => 42,
          moveDown() {},
        },
        cancel() {},
      };
      spyOn(model.activeEditor, "moveDown");
      spyOn(model, "cancel");
      spyOn(suggestionListElement, "visibleItems").andReturn(["a"]);

      suggestionListElement.model = model;
      suggestionListElement.moveToCancel = true;

      suggestionListElement.moveSelectionPageDown();

      expect(model.activeEditor.moveDown).toHaveBeenCalledWith(42);
      expect(model.cancel).toHaveBeenCalled();
    });
  });

  describe("moveSelectionToTop", () => {
    it("dismisses the list if moveToCancel is true", () => {
      const model = {
        activeEditor: {
          moveToTop() {},
        },
        cancel() {},
      };
      spyOn(model.activeEditor, "moveToTop");
      spyOn(model, "cancel");

      suggestionListElement.model = model;
      suggestionListElement.moveToCancel = true;

      suggestionListElement.moveSelectionToTop();

      expect(model.activeEditor.moveToTop).toHaveBeenCalled();
      expect(model.cancel).toHaveBeenCalled();
    });
  });

  describe("moveSelectionToBottom", () => {
    it("dismisses the list if moveToCancel is true", () => {
      const model = {
        activeEditor: {
          moveToBottom() {},
        },
        cancel() {},
      };
      spyOn(model.activeEditor, "moveToBottom");
      spyOn(model, "cancel");
      spyOn(suggestionListElement, "visibleItems").andReturn(["a"]);

      suggestionListElement.model = model;
      suggestionListElement.moveToCancel = true;

      suggestionListElement.moveSelectionToBottom();

      expect(model.activeEditor.moveToBottom).toHaveBeenCalled();
      expect(model.cancel).toHaveBeenCalled();
    });
  });
});
