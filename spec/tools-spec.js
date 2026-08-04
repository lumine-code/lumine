const dedent = require("dedent");
const path = require("path");
const { pathToFileURL } = require("url");

describe("Renders Markdown", () => {
  describe("properly when given no opts", () => {
    it("handles bold", () => {
      expect(atom.tools.markdown.render("**Hello World**")).toBe(
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

    expect(atom.tools.markdown.render(input).trim()).toBe(expected);
  });

  describe("transforms links correctly", () => {
    it("makes no changes to a fqdn link", () => {
      expect(atom.tools.markdown.render("[Hello World](https://github.com)")).toBe(
        '<p><a href="https://github.com">Hello World</a></p>\n',
      );
    });
    it("leaves a retired package link alone, having nowhere to send it", () => {
      expect(atom.tools.markdown.render("[Hello](https://atom.io/packages/hey-pane)")).toBe(
        '<p><a href="https://atom.io/packages/hey-pane">Hello</a></p>\n',
      );
    });
    it("resolves flight-manual links to web archive", () => {
      expect(atom.tools.markdown.render("[Hello](https://flight-manual.atom.io/some-docs)")).toBe(
        '<p><a href="https://web.archive.org/web/20221215003438/https://flight-manual.atom.io/some-docs">Hello</a></p>\n',
      );
    });
    it("resolves incomplete local links", () => {
      expect(
        atom.tools.markdown.render("[Hello](./readme.md)", {
          rootDomain: "https://github.com/lumine-code/lumine",
        }),
      ).toBe(
        '<p><a href="https://github.com/lumine-code/lumine/blob/HEAD/readme.md">Hello</a></p>\n',
      );
    });
    it("resolves incomplete root links", () => {
      expect(
        atom.tools.markdown.render("[Hello](/readme.md)", {
          rootDomain: "https://github.com/lumine-code/lumine",
        }),
      ).toBe(
        '<p><a href="https://github.com/lumine-code/lumine/blob/HEAD/readme.md">Hello</a></p>\n',
      );
    });
    it("preserves in-page fragment links", () => {
      expect(
        atom.tools.markdown.render("[Install](#install)", {
          rootDomain: "https://github.com/lumine-code/lumine",
        }),
      ).toBe('<p><a href="#install">Install</a></p>\n');
    });
    it("still rewrites relative links that contain a fragment", () => {
      expect(
        atom.tools.markdown.render("[Install](./README.md#install)", {
          rootDomain: "https://github.com/lumine-code/lumine",
        }),
      ).toBe(
        '<p><a href="https://github.com/lumine-code/lumine/blob/HEAD/README.md#install">Install</a></p>\n',
      );
    });
  });

  describe("handles GitHub headings", () => {
    it("does not add heading ids unless enabled", () => {
      const output = atom.tools.markdown.render("## Install");
      expect(output).not.toContain("id=");
      expect(output).not.toContain("<a");
    });
    it("adds a safely prefixed id while preserving the fragment href", () => {
      const output = atom.tools.markdown.render("## Install", {
        useGitHubHeadings: true,
      });
      expect(output).toContain('id="user-content-install"');
      expect(output).toContain('href="#install"');
    });
    it("does not inject heading link icons", () => {
      const output = atom.tools.markdown.render("## Install", {
        useGitHubHeadings: true,
      });
      expect(output).not.toContain("<svg");
      expect(output).not.toContain("octicon");
    });
    it("keeps DOM-clobbering heading ids after sanitization", () => {
      const output = atom.tools.markdown.render("## Title", {
        useGitHubHeadings: true,
        sanitize: true,
      });
      expect(output).toContain('id="user-content-title"');
    });
    it("does not rewrite the heading's own fragment href when a rootDomain is set", () => {
      const output = atom.tools.markdown.render("## Install", {
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
        "index.coffee",
      );

      expect(
        atom.tools.markdown.render("![Local image](./index.coffee)", {
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
        atom.tools.markdown.render("![Missing](./missing.png)", {
          filePath: readmePath,
        }),
      ).toBe('<p><img src="./missing.png" alt="Missing"></p>\n');
    });

    it("resolves images against non-GitHub root domains", () => {
      expect(
        atom.tools.markdown.render("![Remote image](./static/image.png)", {
          rootDomain: "https://example.com/packages/example",
        }),
      ).toBe(
        '<p><img src="https://example.com/packages/example/static/image.png" alt="Remote image"></p>\n',
      );
    });

    it("properly handles a standard PNG image", () => {
      expect(
        atom.tools.markdown.render("![Alt Text](/image-link.png)", {
          rootDomain: "https://github.com/lumine-code/lumine",
        }),
      ).toBe(
        '<p><img src="https://github.com/lumine-code/lumine/raw/HEAD/image-link.png" alt="Alt Text"></p>\n',
      );
    });

    it("handles 'data:image/svg+xml' images", () => {
      expect(
        atom.tools.markdown.render(
          "![Baseline icon](data:image/svg+xml;base64,SoMeBaSe64cArAcTerS+)",
        ),
      ).toBe(
        '<p><img src="data:image/svg+xml;base64,SoMeBaSe64cArAcTerS+" alt="Baseline icon"></p>\n',
      );
    });
  });
});

describe("Removes diacritics", () => {
  it("folds combining accents onto the base letter", () => {
    expect(atom.tools.removeDiacritics("café")).toBe("cafe");
    expect(atom.tools.removeDiacritics("żółw")).toBe("zolw");
  });

  it("folds letters that carry their stroke in the codepoint", () => {
    // These have no decomposed form, so a plain NFD normalize would leave them
    // alone. The table-driven fold is what keeps them matchable.
    expect(atom.tools.removeDiacritics("Øl")).toBe("Ol");
    expect(atom.tools.removeDiacritics("Łódź")).toBe("Lodz");
  });

  it("expands ligatures rather than dropping them", () => {
    expect(atom.tools.removeDiacritics("Æther")).toBe("AEther");
  });

  it("leaves text with nothing to fold untouched", () => {
    expect(atom.tools.removeDiacritics("plain ascii")).toBe("plain ascii");
    expect(atom.tools.removeDiacritics("")).toBe("");
  });
});
