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

  it("does not fall back to synchronous realpath calls during asynchronous discovery", async () => {
    const workingDir = copyFixture("working-dir");
    const realpathSync = spyOn(fs.realpathSync, "native").and.callThrough();

    const descriptor = await discoverRepositoryDescriptorAsync(
      path.join(workingDir, "missing", "file.txt"),
    );

    expect(descriptor).not.toBeNull();
    expect(realpathSync).not.toHaveBeenCalled();
  });

  it("discovers the repository from a nested path", () => {
    const workingDir = copyFixture("working-dir");
    const descriptor = discoverRepositoryDescriptor(path.join(workingDir, "a.txt"));

    expect(real(descriptor.getWorkingDirectory())).toBe(real(workingDir));
    expect(real(descriptor.getPath())).toBe(real(path.join(workingDir, ".git")));
  });

  it("discovers sync and async from a missing nested path", async () => {
    const workingDir = copyFixture("working-dir");
    const missingPath = path.join(workingDir, "missing", "b#", "file#hash.md");

    const synchronous = discoverRepositoryDescriptor(missingPath);
    const asynchronous = await discoverRepositoryDescriptorAsync(missingPath);

    expect(real(synchronous.getWorkingDirectory())).toBe(real(workingDir));
    expect(real(asynchronous.getWorkingDirectory())).toBe(real(workingDir));
    expect(real(synchronous.getPath())).toBe(real(path.join(workingDir, ".git")));
    expect(asynchronous.getPath()).toBe(synchronous.getPath());
  });

  it("retains a symlink alias for a missing descendant", async () => {
    const workingDir = copyFixture("working-dir");
    const aliasRoot = temp.mkdirSync("descriptor-alias-");
    const alias = path.join(aliasRoot, "repo-link");
    fs.symlinkSync(workingDir, alias, process.platform === "win32" ? "junction" : "dir");
    const missingPath = path.join(alias, "missing", "file.txt");

    const synchronous = discoverRepositoryDescriptor(missingPath);
    const asynchronous = await discoverRepositoryDescriptorAsync(missingPath);

    expect(path.resolve(synchronous.openedWorkingDirectory)).toBe(path.resolve(alias));
    expect(path.resolve(asynchronous.openedWorkingDirectory)).toBe(path.resolve(alias));
    expect(
      asynchronous
        .getGitDirectoryAliases()
        .some((gitDirectory) => path.resolve(gitDirectory) === path.resolve(alias, ".git")),
    ).toBe(true);
  });

  it("walks up into a bare-style git directory", () => {
    const descriptor = discoverRepositoryDescriptor(fixturePath("master.git", "objects"));

    expect(real(descriptor.getPath())).toBe(real(fixturePath("master.git")));
    // master.git declares core.bare = false, so its working directory is the
    // directory that contains it.
    expect(real(descriptor.getWorkingDirectory())).toBe(real(fixturePath()));
  });

  it("returns null outside a repository", () => {
    const dir = temp.mkdirSync("descriptor-no-repo-");
    expect(discoverRepositoryDescriptor(dir)).toBeNull();
    expect(discoverGitDirectory(path.join(dir, "missing.txt"))).toBeNull();
  });
});
