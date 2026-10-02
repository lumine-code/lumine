const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();
const Project = require("../src/project");
const GitRepository = require("../src/git-repository");
const RepositoryRegistry = require("../src/repository-registry");

function deferred() {
  let resolve;
  const promise = new Promise((complete) => (resolve = complete));
  return { promise, resolve };
}

function copyRepository(targetPath) {
  fs.cpSync(path.join(__dirname, "fixtures", "git", "working-dir"), targetPath, {
    recursive: true,
  });
  fs.renameSync(path.join(targetPath, "git.git"), path.join(targetPath, ".git"));
  return targetPath;
}

describe("Project repository discovery", () => {
  let registry, project, workingDirectory;

  beforeEach(() => {
    jasmine.useRealClock?.();
    workingDirectory = fs.realpathSync.native(
      copyRepository(temp.mkdirSync("project-discovery-repository")),
    );
    registry = new RepositoryRegistry({ config: lumine.config });
    project = new Project({
      repositoryRegistry: registry,
      config: lumine.config,
      grammarRegistry: lumine.grammars,
      notificationManager: lumine.notifications,
      packageManager: { serviceHub: { consume: () => ({ dispose() {} }) } },
    });
  });

  afterEach(async () => {
    project.destroy();
    registry.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    for (const provider of project.repositoryProviders) provider.sweepUnregisteredRepositories?.();
  });

  it("shares a pending explicit lookup with the automatic scan when its project root is added", async () => {
    const entered = deferred();
    const finishCandidate = deferred();
    const finishSecondLookup = deferred();
    const stat = fs.promises.stat.bind(fs.promises);
    const metadataPath = path.join(workingDirectory, ".git");
    let holdCandidate = true;
    spyOn(fs.promises, "stat").and.callFake(async (filePath, options) => {
      const value = await stat(filePath, options);
      if (path.resolve(filePath) === metadataPath) {
        if (holdCandidate && options?.bigint !== true) {
          holdCandidate = false;
          entered.resolve();
          await finishCandidate.promise;
        }
      }
      return value;
    });
    const provider = project.repositoryProviders[0];
    const lookup = provider.repositoryForPath.bind(provider);
    let lookupCount = 0;
    const providerLookups = spyOn(provider, "repositoryForPath").and.callFake(async (filePath) => {
      const call = ++lookupCount;
      const repository = await lookup(filePath);
      if (call === 2) {
        // Hold a duplicate scan result so its registration cannot mask the
        // failed explicit discovery that the newer provider call superseded.
        await finishSecondLookup.promise;
      }
      return repository;
    });
    const lookups = spyOn(project, "repositoryForPathFromProviders").and.callThrough();
    const scanned = deferred();
    const scan = registry.scanProjectRoots.bind(registry);
    spyOn(registry, "scanProjectRoots").and.callFake(async (...args) => {
      const result = await scan(...args);
      scanned.resolve(result);
      return result;
    });
    project.setPaths([workingDirectory]);
    const explicit = project.repositoryForPath(workingDirectory);
    await entered.promise;
    try {
      await conditionPromise(() => lookups.calls.count() >= 2, "automatic project discovery");
      finishCandidate.resolve();
      expect(await explicit).toEqual(jasmine.any(GitRepository));
      expect(providerLookups.calls.count()).toBe(1);
    } finally {
      finishCandidate.resolve();
      finishSecondLookup.resolve();
      await scanned.promise;
    }
  });

  for (const change of ["a retargeted directory alias", "replaced Git metadata"]) {
    it(`keeps explicit refresh fresh after ${change} before watcher notification`, async () => {
      const entered = deferred();
      const finishOlder = deferred();
      const stat = fs.promises.stat.bind(fs.promises);
      const metadataPath = path.join(workingDirectory, ".git");
      let hold = true;
      spyOn(fs.promises, "stat").and.callFake(async (filePath, options) => {
        const value = await stat(filePath, options);
        if (hold && path.resolve(filePath) === metadataPath && options?.bigint === true) {
          hold = false;
          entered.resolve(value);
          await finishOlder.promise;
        }
        return value;
      });
      let lookupPath = workingDirectory;
      if (change === "a retargeted directory alias") {
        lookupPath = path.join(temp.mkdirSync("project-discovery-alias"), "alias");
        fs.symlinkSync(
          workingDirectory,
          lookupPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const older = project.repositoryForPath(lookupPath);
      const originalIdentity = await entered.promise;
      let expectedWorkingDirectory = workingDirectory;
      try {
        if (change === "a retargeted directory alias") {
          expectedWorkingDirectory = copyRepository(temp.mkdirSync("project-discovery-new-target"));
          fs.unlinkSync(lookupPath);
          fs.symlinkSync(
            expectedWorkingDirectory,
            lookupPath,
            process.platform === "win32" ? "junction" : "dir",
          );
        } else {
          const savedMetadata = path.join(workingDirectory, "saved-metadata.git");
          fs.renameSync(metadataPath, savedMetadata);
          fs.cpSync(savedMetadata, metadataPath, { recursive: true });
        }
        const current = await project.repositoryForPath(lookupPath, { refresh: true });
        expect(current).toEqual(jasmine.any(GitRepository));
        expect(path.resolve(current.getWorkingDirectory())).toBe(
          fs.realpathSync.native(expectedWorkingDirectory),
        );
        const identity = current.getGitDirectoryIdentity();
        expect(identity.inode).not.toBe(String(originalIdentity.ino));
      } finally {
        // End the older consumer's lifecycle before releasing its old reads;
        // the explicit refresh above must complete independently of those reads.
        project.destroy();
        finishOlder.resolve();
        expect(await older).toBeNull();
      }
    });
  }
});
