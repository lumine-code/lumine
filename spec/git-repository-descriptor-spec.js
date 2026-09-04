const fs = require("@lumine-code/fs-plus");
const path = require("path");
const temp = require("@lumine-code/temp").track();
const {
  discoverRepositoryDescriptor,
  discoverRepositoryDescriptorAsync,
  discoverGitDirectory,
} = require("../src/git-repository-descriptor");

// Pin repository discovery and working-directory computation against the real
// filesystem so identity and path routing cannot silently drift.
describe("git repository descriptor", () => {
  const fixturePath = (...segments) => path.join(__dirname, "fixtures", "git", ...segments);
  const real = (p) => fs.realpathSync.native(p);

  function copyFixture(name) {
    const dir = temp.mkdirSync(`descriptor-${name}-`);
    fs.copySync(fixturePath(name), dir);
    fs.renameSync(path.join(dir, "git.git"), path.join(dir, ".git"));
    return dir;
  }

  it("discovers the git directory and working directory for a working tree", () => {
    const workingDir = copyFixture("working-dir");
    const descriptor = discoverRepositoryDescriptor(workingDir);

    expect(real(descriptor.getWorkingDirectory())).toBe(real(workingDir));
    expect(real(descriptor.getPath())).toBe(real(path.join(workingDir, ".git")));
    expect(descriptor.caseInsensitiveFs).toBe(fs.isCaseInsensitive());
  });

  it("matches synchronous descriptor semantics through asynchronous discovery", async () => {
    const workingDir = copyFixture("working-dir");
    const synchronous = discoverRepositoryDescriptor(workingDir);
    const asynchronous = await discoverRepositoryDescriptorAsync(workingDir);

    expect(asynchronous.getPath()).toBe(synchronous.getPath());
    expect(asynchronous.getWorkingDirectory()).toBe(synchronous.getWorkingDirectory());
    expect(asynchronous.openedWorkingDirectory).toBe(synchronous.openedWorkingDirectory);
    expect(asynchronous.caseInsensitiveFs).toBe(synchronous.caseInsensitiveFs);
  });

  it("discovers the repository from a nested path", () => {
    const workingDir = copyFixture("working-dir");
    const descriptor = discoverRepositoryDescriptor(path.join(workingDir, "a.txt"));

    expect(real(descriptor.getWorkingDirectory())).toBe(real(workingDir));
    expect(real(descriptor.getPath())).toBe(real(path.join(workingDir, ".git")));
  });

  it("walks up into a bare-style git directory", () => {
    const descriptor = discoverRepositoryDescriptor(fixturePath("master.git", "objects"));

    expect(real(descriptor.getPath())).toBe(real(fixturePath("master.git")));
    // master.git declares core.bare = false, so its working directory is the
    // directory that contains it.
    expect(real(descriptor.getWorkingDirectory())).toBe(real(fixturePath()));
  });

  it("reads submodule paths from .gitmodules", () => {
    const repoDir = copyFixture("repo-with-submodules");
    const descriptor = discoverRepositoryDescriptor(repoDir);

    expect([...descriptor.getSubmodulePaths()].sort()).toEqual(["You-Dont-Need-jQuery", "jstips"]);
    expect(descriptor.isSubmodule("jstips")).toBe(true);
    expect(descriptor.isSubmodule("You-Dont-Need-jQuery")).toBe(true);
    expect(descriptor.isSubmodule("README")).toBe(false);
  });

  it("refreshes cached submodule paths when .gitmodules is added, changed, or removed", () => {
    const repoDir = copyFixture("working-dir");
    const descriptor = discoverRepositoryDescriptor(repoDir);
    const manifestPath = path.join(repoDir, ".gitmodules");

    // Prime the missing-file cache before simulating a checkout to a branch
    // that declares a submodule.
    expect(descriptor.getSubmodulePaths()).toEqual([]);
    fs.writeFileSync(
      manifestPath,
      '[submodule "first"]\n\tpath = vendor/first\n\turl = ../first.git\n',
    );
    expect(descriptor.getSubmodulePaths()).toEqual(["vendor/first"]);
    expect(descriptor.isSubmodule("vendor/first")).toBe(true);

    fs.writeFileSync(
      manifestPath,
      '[submodule "replacement-with-a-longer-name"]\n\tpath = dependencies/replacement\n\turl = ../replacement.git\n',
    );
    expect(descriptor.getSubmodulePaths()).toEqual(["dependencies/replacement"]);
    expect(descriptor.isSubmodule("vendor/first")).toBe(false);
    expect(descriptor.isSubmodule("dependencies/replacement")).toBe(true);

    fs.removeSync(manifestPath);
    expect(descriptor.getSubmodulePaths()).toEqual([]);
    expect(descriptor.isSubmodule("dependencies/replacement")).toBe(false);
  });

  it("returns null outside a repository", () => {
    const dir = temp.mkdirSync("descriptor-no-repo-");
    expect(discoverRepositoryDescriptor(dir)).toBeNull();
    expect(discoverGitDirectory(path.join(dir, "missing.txt"))).toBeNull();
  });
});
