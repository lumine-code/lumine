const dedent = require("dedent");
const path = require("path");
const { pathToFileURL } = require("url");
const TextEditor = require("../src/text-editor");

describe("Renders Markdown", () => {
  describe("properly when given no opts", () => {
    it("handles bold", () => {
      expect(lumine.tools.markdown.render("**Hello World**")).toBe(
        "<p><strong>Hello World</strong></p>\n",
      );
    });
  });

  it(`escapes HTML in code blocks properly`, () => {
    let input = dedent`
    Lorem ipsum dolor.

    \`\`\`html
    <p>sit amet</p>
    \`\`\`
    `;

    let expected = dedent`
    <p>Lorem ipsum dolor.</p>
    <pre><code class="language-html">&lt;p&gt;sit amet&lt;/p&gt;
    </code></pre>
    `;

    expect(lumine.tools.markdown.render(input).trim()).toBe(expected);
  });

  describe("transforms links correctly", () => {
    it("makes no changes to a fqdn link", () => {
      expect(lumine.tools.markdown.render("[Hello World](https://github.com)")).toBe(
        '<p><a href="https://github.com">Hello World</a></p>\n',
      );
    });
    it("resolves incomplete local links", () => {
      expect(
        lumine.tools.markdown.render("[Hello](./readme.md)", {
          rootDomain: "https://github.com/lumine-code/lumine",
        }),
      ).toBe(
        '<p><a href="https://github.com/lumine-code/lumine/blob/HEAD/readme.md">Hello</a></p>\n',
      );
    });
    it("resolves incomplete root links", () => {
      expect(
        lumine.tools.markdown.render("[Hello](/readme.md)", {
          rootDomain: "https://github.com/lumine-code/lumine",
        }),
      ).toBe(
        '<p><a href="https://github.com/lumine-code/lumine/blob/HEAD/readme.md">Hello</a></p>\n',
      );
    });
    it("preserves in-page fragment links", () => {
      expect(
        lumine.tools.markdown.render("[Install](#install)", {
          rootDomain: "https://github.com/lumine-code/lumine",
        }),
      ).toBe('<p><a href="#install">Install</a></p>\n');
    });
    it("still rewrites relative links that contain a fragment", () => {
      expect(
        lumine.tools.markdown.render("[Install](./README.md#install)", {
          rootDomain: "https://github.com/lumine-code/lumine",
        }),
      ).toBe(
        '<p><a href="https://github.com/lumine-code/lumine/blob/HEAD/README.md#install">Install</a></p>\n',
      );
    });
  });

  describe("handles GitHub headings", () => {
    it("does not add heading ids unless enabled", () => {
      const output = lumine.tools.markdown.render("## Install");
      expect(output).not.toContain("id=");
      expect(output).not.toContain("<a");
    });
    it("adds a safely prefixed id while preserving the fragment href", () => {
      const output = lumine.tools.markdown.render("## Install", {
        useGitHubHeadings: true,
      });
      expect(output).toContain('id="user-content-install"');
      expect(output).toContain('href="#install"');
    });
    it("does not inject heading link icons", () => {
      const output = lumine.tools.markdown.render("## Install", {
        useGitHubHeadings: true,
      });
      expect(output).not.toContain("<svg");
      expect(output).not.toContain("octicon");
    });
    it("keeps DOM-clobbering heading ids after sanitization", () => {
      const output = lumine.tools.markdown.render("## Title", {
        useGitHubHeadings: true,
        sanitize: true,
      });
      expect(output).toContain('id="user-content-title"');
    });
    it("does not rewrite the heading's own fragment href when a rootDomain is set", () => {
      const output = lumine.tools.markdown.render("## Install", {
        useGitHubHeadings: true,
        rootDomain: "https://github.com/lumine-code/lumine",
      });
      expect(output).toContain('href="#install"');
      expect(output).not.toContain("blob/HEAD");
    });
  });

  describe("transforms images correctly", () => {
    it("resolves images relative to a local Markdown file", () => {
      const readmePath = path.join(
        __dirname,
        "fixtures",
        "packages",
        "package-with-index",
        "index.js",
      );

      expect(
        lumine.tools.markdown.render("![Local image](./index.js)", {
          filePath: readmePath,
        }),
      ).toBe(`<p><img src="${pathToFileURL(readmePath).href}" alt="Local image"></p>\n`);
    });

    it("leaves missing local images unchanged", () => {
      const readmePath = path.join(
        __dirname,
        "fixtures",
        "packages",
        "package-with-index",
        "README.md",
      );

      expect(
        lumine.tools.markdown.render("![Missing](./missing.png)", {
          filePath: readmePath,
        }),
      ).toBe('<p><img src="./missing.png" alt="Missing"></p>\n');
    });

    it("resolves images against non-GitHub root domains", () => {
      expect(
        lumine.tools.markdown.render("![Remote image](./static/image.png)", {
          rootDomain: "https://example.com/packages/example",
        }),
      ).toBe(
        '<p><img src="https://example.com/packages/example/static/image.png" alt="Remote image"></p>\n',
      );
    });

    it("properly handles a standard PNG image", () => {
      expect(
        lumine.tools.markdown.render("![Alt Text](/image-link.png)", {
          rootDomain: "https://github.com/lumine-code/lumine",
        }),
      ).toBe(
        '<p><img src="https://github.com/lumine-code/lumine/raw/HEAD/image-link.png" alt="Alt Text"></p>\n',
      );
    });

    it("handles 'data:image/svg+xml' images", () => {
      expect(
        lumine.tools.markdown.render(
          "![Baseline icon](data:image/svg+xml;base64,SoMeBaSe64cArAcTerS+)",
        ),
      ).toBe(
        '<p><img src="data:image/svg+xml;base64,SoMeBaSe64cArAcTerS+" alt="Baseline icon"></p>\n',
      );
    });
  });
});

describe("Highlights markdown code blocks", () => {
  let container;
  const codeSource = "const first = 1;\nconst second = 2;";
  const fencedCode = `\`\`\`js\n${codeSource}\n\`\`\``;

  beforeEach(() => {
    container = document.createElement("div");
    // A box sized by what it holds — a hover tooltip, a completion's
    // documentation — which is where a code block has to report its own width.
    container.style.position = "absolute";
    container.style.width = "max-content";
    jasmine.attachToDOM(container);
  });

  afterEach(() => {
    for (const element of container.querySelectorAll("lumine-text-editor")) {
      element.getModel().destroy();
    }
    container.remove();
  });

  async function render(markdown, opts) {
    const fragment = lumine.tools.markdown.convertToDOM(lumine.tools.markdown.render(markdown));
    await lumine.tools.markdown.applySyntaxHighlighting(fragment, {
      renderMode: "fragment",
      ...opts,
    });
    container.appendChild(fragment);
    return container.querySelector("lumine-text-editor");
  }

  function startFullRender(markdown = fencedCode, { attach = true, ...options } = {}) {
    const fragment = lumine.tools.markdown.convertToDOM(lumine.tools.markdown.render(markdown));
    const preElement = fragment.querySelector("pre");
    const promise = lumine.tools.markdown.applySyntaxHighlighting(fragment, {
      renderMode: "full",
      ...options,
    });
    if (attach) container.appendChild(fragment);
    return {
      fragment,
      preElement,
      promise,
    };
  }

  it("swaps each fence for an editor that renders no caret", async () => {
    const element = await render("```js\nconst answer = 42;\n```");
    expect(container.querySelector("pre")).toBeNull();
    expect(element.getModel().getText()).toBe("const answer = 42;");
    expect(element.getModel().isReadOnly()).toBe(true);
    expect(element.classList.contains("non-interactive")).toBe(true);
    expect(getComputedStyle(element.querySelector(".cursors")).display).toBe("none");
  });

  it("sizes a code block to its longest line when asked to", async () => {
    const element = await render("```js\nconst theAnswerToEverything = 42;\n```", {
      autoWidth: true,
    });
    expect(element.getModel().getAutoWidth()).toBe(true);
    // Without a width of its own the block fills a container that is itself
    // waiting on the block, and the whole box collapses to nothing.
    expect(container.getBoundingClientRect().width).toBeGreaterThan(100);
  });

  it("waits for a cold grammar, copies the ready rendering, and destroys its editor", async () => {
    let editor;
    let grammarSignal;
    let settleGrammar;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function ({ signal } = {}) {
      editor = this;
      grammarSignal = signal;
      return new Promise((resolve) => {
        settleGrammar = resolve;
      });
    });

    const { fragment, preElement, promise } = startFullRender();
    await conditionPromise(() => Boolean(settleGrammar));

    expect(grammarSignal.aborted).toBe(false);
    expect(preElement.querySelector("code").textContent).toBe(`${codeSource}\n`);
    expect(preElement.hidden).toBe(true);
    expect(fragment.querySelector("lumine-text-editor")).toBeNull();

    settleGrammar(true);
    await promise;

    expect(Array.from(preElement.children, (line) => line.textContent)).toEqual([
      "const first = 1;",
      "const second = 2;",
    ]);
    expect(preElement.querySelector("code")).toBeNull();
    expect(preElement.hidden).toBe(false);
    expect(editor.isDestroyed()).toBe(true);
    expect(grammarSignal.aborted).toBe(true);
  });

  it("renders full mode before its document fragment is attached", async () => {
    await lumine.packages.activatePackage("language-javascript");
    const whenGrammarSettled = TextEditor.prototype.whenGrammarSettled;
    let editor;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function (options) {
      editor = this;
      return whenGrammarSettled.call(this, options);
    });
    const { fragment, preElement, promise } = startFullRender(fencedCode, {
      attach: false,
      syntaxScopeNameFunc: () => "source.js",
    });

    await promise;

    expect(fragment.isConnected).toBe(false);
    expect(Array.from(preElement.children, (line) => line.textContent)).toEqual([
      "const first = 1;",
      "const second = 2;",
    ]);
    expect(preElement.querySelector(".syntax--storage.syntax--type")).not.toBeNull();
    expect(preElement.querySelector(".syntax--constant.syntax--numeric")).not.toBeNull();
    expect(fragment.querySelector("lumine-text-editor")).toBeNull();
    expect(editor.isDestroyed()).toBe(true);

    container.appendChild(fragment);
    expect(preElement.hidden).toBe(false);
  });

  it("keeps a long physical line intact in full mode", async () => {
    const source = "x".repeat(600);
    const { preElement, promise } = startFullRender(`\`\`\`text\n${source}\n\`\`\``, {
      attach: false,
    });

    await promise;

    expect(preElement.querySelectorAll(".line").length).toBe(1);
    expect(preElement.textContent).toBe(source);
  });

  it("preserves the source and finishes when grammar settlement reports failure", async () => {
    let editor;
    const waitForGrammar = spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(
      function () {
        editor = this;
        return Promise.resolve(false);
      },
    );

    const { fragment, preElement, promise } = startFullRender();
    await promise;

    expect(waitForGrammar).toHaveBeenCalledTimes(1);
    expect(preElement.querySelector("code").textContent).toBe(`${codeSource}\n`);
    expect(preElement.hidden).toBe(false);
    expect(preElement.querySelectorAll(".line").length).toBe(0);
    expect(fragment.querySelector("lumine-text-editor")).toBeNull();
    expect(editor.isDestroyed()).toBe(true);
  });

  it("preserves the source and finishes when grammar settlement rejects", async () => {
    let editor;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function () {
      editor = this;
      return Promise.reject(new Error("parser load failed"));
    });

    const { fragment, preElement, promise } = startFullRender();
    await promise;

    expect(preElement.querySelector("code").textContent).toBe(`${codeSource}\n`);
    expect(preElement.querySelectorAll(".line").length).toBe(0);
    expect(fragment.querySelector("lumine-text-editor")).toBeNull();
    expect(editor.isDestroyed()).toBe(true);
  });

  it("aborts and finishes when its temporary editor is destroyed", async () => {
    let editor;
    let grammarSignal;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function ({ signal } = {}) {
      editor = this;
      grammarSignal = signal;
      return new Promise(() => {});
    });

    const { fragment, preElement, promise } = startFullRender();
    await conditionPromise(() => Boolean(grammarSignal));
    editor.destroy();
    await promise;

    expect(grammarSignal.aborted).toBe(true);
    expect(preElement.querySelector("code").textContent).toBe(`${codeSource}\n`);
    expect(fragment.querySelector("lumine-text-editor")).toBeNull();
  });

  it("finishes only once when grammar settlement races editor destruction", async () => {
    let editor;
    let settleGrammar;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function () {
      editor = this;
      return new Promise((resolve) => {
        settleGrammar = resolve;
      });
    });

    const { preElement, promise } = startFullRender();
    let completionCount = 0;
    promise.then(() => completionCount++);
    await conditionPromise(() => Boolean(settleGrammar));

    editor.destroy();
    settleGrammar(true);
    await promise;
    await Promise.resolve();

    expect(completionCount).toBe(1);
    expect(preElement.children.length).toBe(1);
    expect(preElement.querySelector("code").textContent).toBe(`${codeSource}\n`);
  });
});

describe("Removes diacritics", () => {
  it("folds combining accents onto the base letter", () => {
    expect(lumine.tools.removeDiacritics("café")).toBe("cafe");
    expect(lumine.tools.removeDiacritics("żółw")).toBe("zolw");
  });

  it("folds letters that carry their stroke in the codepoint", () => {
    // These have no decomposed form, so a plain NFD normalize would leave them
    // alone. The table-driven fold is what keeps them matchable.
    expect(lumine.tools.removeDiacritics("Øl")).toBe("Ol");
    expect(lumine.tools.removeDiacritics("Łódź")).toBe("Lodz");
  });

  it("expands ligatures rather than dropping them", () => {
    expect(lumine.tools.removeDiacritics("Æther")).toBe("AEther");
  });

  it("leaves text with nothing to fold untouched", () => {
    expect(lumine.tools.removeDiacritics("plain ascii")).toBe("plain ascii");
    expect(lumine.tools.removeDiacritics("")).toBe("");
  });
});
