const path = require("path");
const ProjectDirectory = require("../src/project-directory");

describe("ProjectDirectory", () => {
  it("keeps the filesystem root as an absolute directory", () => {
    const root = path.parse(process.cwd()).root;
    const directory = new ProjectDirectory(root);
    expect(directory.getPath()).toBe(root);
    expect(path.isAbsolute(directory.getPath())).toBe(true);
    expect(directory.getParent().getPath()).toBe(root);
  });

  it("contains and relativizes paths below a filesystem root", () => {
    const root = path.parse(process.cwd()).root;
    const directory = new ProjectDirectory(root);
    const child = path.join(root, "project", "file.txt");
    expect(directory.contains(child)).toBe(true);
    expect(directory.relativize(child)).toBe(path.join("project", "file.txt"));
    expect(directory.relativize(root)).toBe("");
  });

  if (process.platform === "win32") {
    it("preserves a UNC share root", () => {
      const root = "\\\\server\\share\\";
      const directory = new ProjectDirectory(root);
      expect(directory.getPath()).toBe(root);
      expect(directory.contains(`${root}file.txt`)).toBe(true);
      expect(directory.relativize(`${root}file.txt`)).toBe("file.txt");
    });
  }
});
