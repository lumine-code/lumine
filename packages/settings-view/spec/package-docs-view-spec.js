const path = require("path");

const PackageDocsView = require("../lib/package-docs-view");

describe("PackageDocsView", () => {
  let view = null;

  const fixture = (name) => path.join(__dirname, "fixtures", name);

  afterEach(() => {
    if (view) {
      view.destroy();
    }
    view = null;
  });

  it("reads the markdown a package ships in docs/", () => {
    view = new PackageDocsView(fixture("package-with-docs"));

    const docs = Array.from(view.packageDocs.querySelectorAll(".package-doc"));
    expect(docs.map((element) => element.dataset.docFile)).toEqual([
      "a.provider.md",
      "b.provider.md",
    ]);
    expect(docs[0].querySelector("h1").textContent).toBe("a.provider");
  });

  it("orders the documents by file name, so a number sets the reading order", () => {
    view = new PackageDocsView(fixture("package-with-ordered-docs"));

    const docs = Array.from(view.packageDocs.querySelectorAll(".package-doc"));
    expect(docs.map((element) => element.dataset.docFile)).toEqual(["1_second.md", "2_first.md"]);
    // The number never shows: each document is listed by its own headers.
    expect(docs.map((element) => element.querySelector("h1").textContent)).toEqual([
      "second",
      "first",
    ]);
  });

  it("adds safely prefixed heading ids for fragment links", () => {
    view = new PackageDocsView(fixture("package-with-docs"));
    expect(view.packageDocs.querySelector("#user-content-contract")).not.toBeNull();
  });

  it("renders nothing for a package with no docs/ directory", () => {
    view = new PackageDocsView(fixture("package-with-readme"));
    expect(view.packageDocs.querySelector(".package-doc")).toBeNull();
  });

  it("renders nothing for a package with no path", () => {
    view = new PackageDocsView(undefined);
    expect(view.packageDocs.querySelector(".package-doc")).toBeNull();
  });

  it("scrolls within the document that was clicked rather than its namesake", () => {
    view = new PackageDocsView(fixture("package-with-docs"));

    const [first, second] = view.packageDocs.querySelectorAll(".package-doc");
    const link = second.querySelector('a[href="#contract"]');
    const target = second.querySelector("#user-content-contract");
    const namesake = first.querySelector("#user-content-contract");
    spyOn(target, "scrollIntoView");
    spyOn(namesake, "scrollIntoView");

    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(namesake.scrollIntoView).not.toHaveBeenCalled();
  });
});
