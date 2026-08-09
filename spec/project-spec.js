const temp = require("@lumine-code/temp").track();
const TextBuffer = require("../src/text-buffer");
const Project = require("../src/project");
const fs = require("@lumine-code/fs-plus");
const path = require("path");
const ProjectDirectory = require("../src/project-directory");
const { stopAllWatchers } = require("../src/path-watcher");
const GitRepository = require("../src/git-repository");
const RepositoryRegistry = require("../src/repository-registry");

describe("Project", () => {
  const standaloneRegistries = [];
  const buildProject = (options) => {
    const repositoryRegistry = new RepositoryRegistry({
      config: lumine.config,
      notificationManager: lumine.notifications,
    });
    standaloneRegistries.push(repositoryRegistry);
    return new Project({ ...options, repositoryRegistry });
  };

  beforeEach(() => {
    const directory = lumine.project.getDirectories()[0];
    const paths = directory ? [directory.resolve("dir")] : [null];
    lumine.project.setPaths(paths);
  });

  afterEach(() => {
    for (const registry of standaloneRegistries.splice(0)) registry.destroy();
  });

  describe("::setState(projectPaths)", () => {
    // The environment supplies what actually restores the state, because only
    // it can reach the window state store and the workspace. A project built
    // without one has no window to change.
    it("resolves to false with no environment behind it", async () => {
      const detached = buildProject({
        notificationManager: lumine.notifications,
        packageManager: lumine.packages,
        grammarRegistry: lumine.grammars,
      });

      expect(await detached.setState([__dirname])).toBe(false);
      expect(detached.getPaths()).toEqual([]);
    });
  });

  describe("serialization", () => {
    let deserializedProject = null;
    let notQuittingProject = null;
    let quittingProject = null;

    afterEach(() => {
      if (deserializedProject != null) {
        deserializedProject.destroy();
      }
      if (notQuittingProject != null) {
        notQuittingProject.destroy();
      }
      if (quittingProject != null) {
        quittingProject.destroy();
      }
    });

    it("does not deserialize paths to directories that don't exist", async () => {
      deserializedProject = buildProject({
        notificationManager: lumine.notifications,
        packageManager: lumine.packages,
        confirm: lumine.window.confirm,
        grammarRegistry: lumine.grammars,
      });
      const state = lumine.project.serialize();
      state.paths.push("/directory/that/does/not/exist");

      let err = null;
      await deserializedProject.deserialize(state, lumine.deserializers).catch((e) => (err = e));

      expect(deserializedProject.getPaths()).toEqual(lumine.project.getPaths());
      expect(err.missingProjectPaths).toEqual(["/directory/that/does/not/exist"]);
    });

    it("does not deserialize paths that are now files", async () => {
      const childPath = path.join(temp.mkdirSync("lumine-spec-project"), "child");
      fs.mkdirSync(childPath);

      deserializedProject = buildProject({
        notificationManager: lumine.notifications,
        packageManager: lumine.packages,
        confirm: lumine.window.confirm,
        grammarRegistry: lumine.grammars,
      });
      lumine.project.setPaths([childPath]);
      const state = lumine.project.serialize();

      fs.rmdirSync(childPath);
      fs.writeFileSync(childPath, "surprise!\n");

      let err = null;
      await deserializedProject.deserialize(state, lumine.deserializers).catch((e) => (err = e));

      expect(deserializedProject.getPaths()).toEqual([]);
      expect(err.missingProjectPaths).toEqual([childPath]);
    });

    it("does not include unretained buffers in the serialized state", async () => {
      await lumine.project.bufferForPath("a");

      expect(lumine.project.getBuffers().length).toBe(1);

      deserializedProject = buildProject({
        notificationManager: lumine.notifications,
        packageManager: lumine.packages,
        confirm: lumine.window.confirm,
        grammarRegistry: lumine.grammars,
      });

      await deserializedProject.deserialize(lumine.project.serialize({ isUnloading: false }));

      expect(deserializedProject.getBuffers().length).toBe(0);
    });

    it("listens for destroyed events on deserialized buffers and removes them when they are destroyed", async () => {
      await lumine.workspace.open("a");

      expect(lumine.project.getBuffers().length).toBe(1);
      deserializedProject = buildProject({
        notificationManager: lumine.notifications,
        packageManager: lumine.packages,
        confirm: lumine.window.confirm,
        grammarRegistry: lumine.grammars,
      });

      await deserializedProject.deserialize(lumine.project.serialize({ isUnloading: false }));

      expect(deserializedProject.getBuffers().length).toBe(1);
      deserializedProject.getBuffers()[0].destroy();
      expect(deserializedProject.getBuffers().length).toBe(0);
    });

    it("does not deserialize buffers when their path is now a directory", async () => {
      const pathToOpen = path.join(temp.mkdirSync("lumine-spec-project"), "file.txt");

      await lumine.workspace.open(pathToOpen);

      expect(lumine.project.getBuffers().length).toBe(1);
      fs.mkdirSync(pathToOpen);
      deserializedProject = buildProject({
        notificationManager: lumine.notifications,
        packageManager: lumine.packages,
        confirm: lumine.window.confirm,
        grammarRegistry: lumine.grammars,
      });

      await deserializedProject.deserialize(lumine.project.serialize({ isUnloading: false }));

      expect(deserializedProject.getBuffers().length).toBe(0);
    });

    it("does not deserialize buffers when their path is inaccessible", async () => {
      jasmine.filterByPlatform({ except: ["win32"] }); // chmod not supported on win32

      const pathToOpen = path.join(temp.mkdirSync("lumine-spec-project"), "file.txt");
      fs.writeFileSync(pathToOpen, "");

      await lumine.workspace.open(pathToOpen);

      expect(lumine.project.getBuffers().length).toBe(1);
      fs.chmodSync(pathToOpen, "000");
      deserializedProject = buildProject({
        notificationManager: lumine.notifications,
        packageManager: lumine.packages,
        confirm: lumine.window.confirm,
        grammarRegistry: lumine.grammars,
      });

      await deserializedProject.deserialize(lumine.project.serialize({ isUnloading: false }));

      expect(deserializedProject.getBuffers().length).toBe(0);
    });

    it("does not deserialize buffers with their path is no longer present", async () => {
      const pathToOpen = path.join(temp.mkdirSync("lumine-spec-project"), "file.txt");
      fs.writeFileSync(pathToOpen, "");

      await lumine.workspace.open(pathToOpen);

      expect(lumine.project.getBuffers().length).toBe(1);
      fs.unlinkSync(pathToOpen);
      deserializedProject = buildProject({
        notificationManager: lumine.notifications,
        packageManager: lumine.packages,
        confirm: lumine.window.confirm,
        grammarRegistry: lumine.grammars,
      });

      await deserializedProject.deserialize(lumine.project.serialize({ isUnloading: false }));

      expect(deserializedProject.getBuffers().length).toBe(0);
    });

    it("deserializes buffers that have never been saved before", async () => {
      const pathToOpen = path.join(temp.mkdirSync("lumine-spec-project"), "file.txt");

      await lumine.workspace.open(pathToOpen);

      lumine.workspace.getActiveTextEditor().setText("unsaved\n");
      expect(lumine.project.getBuffers().length).toBe(1);

      deserializedProject = buildProject({
        notificationManager: lumine.notifications,
        packageManager: lumine.packages,
        confirm: lumine.window.confirm,
        grammarRegistry: lumine.grammars,
      });

      await deserializedProject.deserialize(lumine.project.serialize({ isUnloading: false }));

      expect(deserializedProject.getBuffers().length).toBe(1);
      expect(deserializedProject.getBuffers()[0].getPath()).toBe(pathToOpen);
      expect(deserializedProject.getBuffers()[0].getText()).toBe("unsaved\n");
    });

    it("serializes marker layers and history only if Lumine is quitting", async () => {
      await lumine.workspace.open("a");

      let bufferA = lumine.project.getBuffers()[0];
      let layerA = bufferA.addMarkerLayer({ persistent: true });
      let markerA = layerA.markPosition([0, 3]);

      bufferA.append("!");
      notQuittingProject = buildProject({
        notificationManager: lumine.notifications,
        packageManager: lumine.packages,
        confirm: lumine.window.confirm,
        grammarRegistry: lumine.grammars,
      });

      await notQuittingProject.deserialize(lumine.project.serialize({ isUnloading: false }));

      expect(notQuittingProject.getBuffers()[0].getMarkerLayer(layerA.id), (x) =>
        x.getMarker(markerA.id),
      ).toBeUndefined();
      expect(notQuittingProject.getBuffers()[0].undo()).toBe(false);
      quittingProject = buildProject({
        notificationManager: lumine.notifications,
        packageManager: lumine.packages,
        confirm: lumine.window.confirm,
        grammarRegistry: lumine.grammars,
      });

      await quittingProject.deserialize(lumine.project.serialize({ isUnloading: true }));

      expect(quittingProject.getBuffers()[0].getMarkerLayer(layerA.id), (x) =>
        x.getMarker(markerA.id),
      ).not.toBeUndefined();
      expect(quittingProject.getBuffers()[0].undo()).toBe(true);
    });
  });

  describe("when an editor is saved and the project has no path", () => {
    it("sets the project's path to the saved file's parent directory", async () => {
      const tempFile = temp.openSync().path;
      lumine.project.setPaths([]);
      expect(lumine.project.getPaths()[0]).toBeUndefined();
      let editor = await lumine.workspace.open();

      await editor.saveAs(tempFile);

      expect(lumine.project.getPaths()[0]).toBe(path.dirname(tempFile));
    });
  });

  describe(".replace", () => {
    let projectSpecification, projectPath1, projectPath2;
    beforeEach(() => {
      lumine.project.replace(null);
      projectPath1 = temp.mkdirSync("project-path1");
      projectPath2 = temp.mkdirSync("project-path2");
      projectSpecification = {
        paths: [projectPath1, projectPath2],
        originPath: "originPath",
        config: {
          baz: "buzz",
        },
      };
    });
    it("sets a project specification", () => {
      expect(lumine.config.get("baz")).toBeUndefined();
      lumine.project.replace(projectSpecification);
      expect(lumine.project.getPaths()).toEqual([projectPath1, projectPath2]);
      expect(lumine.config.get("baz")).toBe("buzz");
    });

    it("clears a project through replace with no params", () => {
      expect(lumine.config.get("baz")).toBeUndefined();
      lumine.project.replace(projectSpecification);
      expect(lumine.config.get("baz")).toBe("buzz");
      expect(lumine.project.getPaths()).toEqual([projectPath1, projectPath2]);
      lumine.project.replace();
      expect(lumine.config.get("baz")).toBeUndefined();
      expect(lumine.project.getPaths()).toEqual([]);
    });

    it("responds to change of project specification", () => {
      let wasCalled = false;
      const callback = () => {
        wasCalled = true;
      };
      lumine.project.onDidReplace(callback);
      lumine.project.replace(projectSpecification);
      expect(wasCalled).toBe(true);
      wasCalled = false;
      lumine.project.replace();
      expect(wasCalled).toBe(true);
    });
  });

  describe("before and after saving a buffer", () => {
    let buffer;
    beforeEach(async () => {
      buffer = await lumine.project.bufferForPath(path.join(__dirname, "fixtures", "sample.js"));
      buffer.retain();
    });

    afterEach(() => buffer.release());

    it("emits save events on the main process", async () => {
      spyOn(lumine.project.applicationDelegate, "emitDidSavePath");
      spyOn(lumine.project.applicationDelegate, "emitWillSavePath");

      await buffer.save();

      expect(lumine.project.applicationDelegate.emitDidSavePath.calls.count()).toBe(1);
      expect(lumine.project.applicationDelegate.emitDidSavePath).toHaveBeenCalledWith(
        buffer.getPath(),
      );
      expect(lumine.project.applicationDelegate.emitWillSavePath.calls.count()).toBe(1);
      expect(lumine.project.applicationDelegate.emitWillSavePath).toHaveBeenCalledWith(
        buffer.getPath(),
      );
    });
  });

  describe("when a watch error is thrown from the TextBuffer", () => {
    let editor = null;
    beforeEach(async () => {
      editor = await lumine.workspace.open(require.resolve("./fixtures/dir/a"));
    });

    it("creates a warning notification", () => {
      let noteSpy;
      lumine.notifications.onDidAddNotification((noteSpy = jasmine.createSpy()));

      const error = new Error("SomeError");
      error.eventType = "resurrect";
      editor.buffer.emitter.emit("will-throw-watch-error", {
        handle: jasmine.createSpy(),
        error,
      });

      expect(noteSpy).toHaveBeenCalled();

      const notification = noteSpy.calls.mostRecent().args[0];
      expect(notification.getType()).toBe("warning");
      expect(notification.getDetail()).toBe("SomeError");
      expect(notification.getMessage()).toContain("`resurrect`");
      expect(notification.getMessage()).toContain(path.join("fixtures", "dir", "a"));
    });
  });

  describe("when a custom repository-provider service is provided", () => {
    let fakeRepositoryProvider, fakeRepository;

    beforeEach(() => {
      fakeRepository = {
        workingDirectory: null,
        destroyed: false,
        getWorkingDirectory() {
          return this.workingDirectory;
        },
        getPath() {
          return path.join(this.workingDirectory, ".git");
        },
        isDestroyed() {
          return this.destroyed;
        },
        onDidDestroy() {
          return { dispose() {} };
        },
        destroy() {
          this.destroyed = true;
        },
      };
      fakeRepositoryProvider = {
        repositoryForDirectory(directory) {
          fakeRepository.workingDirectory = directory.getPath();
          return Promise.resolve(fakeRepository);
        },
        repositoryForDirectorySync(directory) {
          fakeRepository.workingDirectory = directory.getPath();
          return fakeRepository;
        },
      };
    });

    it("uses it to create repositories for any directories that need one", () => {
      const projectPath = temp.mkdirSync("lumine-project");
      lumine.project.setPaths([projectPath]);
      expect(lumine.repositories.getForPath(projectPath)).toBeNull();

      lumine.packages.serviceHub.provide(
        "project.repository-provider",
        "1.0.0",
        fakeRepositoryProvider,
      );
      expect(lumine.repositories.resolveForPathSync(projectPath)).toBe(fakeRepository);
    });

    it("allows a newly provided repository to become the nearest repository", () => {
      const projectPath = lumine.project.getPaths()[0];
      const repository = lumine.repositories.getForPath(projectPath);
      expect(repository).toBeTruthy();

      lumine.packages.serviceHub.provide(
        "project.repository-provider",
        "1.0.0",
        fakeRepositoryProvider,
      );
      expect(lumine.repositories.getForPath(projectPath)).toBe(fakeRepository);
      expect(repository.isDestroyed()).toBe(false);
    });

    it("stops using it to create repositories when the service is removed", () => {
      lumine.project.setPaths([]);

      const disposable = lumine.packages.serviceHub.provide(
        "project.repository-provider",
        "1.0.0",
        fakeRepositoryProvider,
      );

      disposable.dispose();
      const projectPath = temp.mkdirSync("lumine-project");
      lumine.project.addPath(projectPath);
      expect(lumine.repositories.getForPath(projectPath)).toBeNull();
    });
  });

  describe("when a custom directory-provider service is provided", () => {
    class DummyDirectory {
      constructor(aPath) {
        this.path = aPath;
      }
      getPath() {
        return this.path;
      }
      getFile() {
        return {
          existsSync() {
            return false;
          },
        };
      }
      getSubdirectory() {
        return {
          existsSync() {
            return false;
          },
        };
      }
      isRoot() {
        return true;
      }
      existsSync() {
        return this.path.endsWith("does-exist");
      }
      contains(filePath) {
        return filePath.startsWith(this.path);
      }
      onDidChangeFiles(callback) {
        onDidChangeFilesCallback = callback;
        return { dispose: () => {} };
      }
    }

    let serviceDisposable = null;
    let onDidChangeFilesCallback = null;

    beforeEach(() => {
      serviceDisposable = lumine.packages.serviceHub.provide(
        "project.directory-provider",
        "1.0.0",
        {
          directoryForURISync(uri) {
            if (uri.startsWith("ssh://")) {
              return new DummyDirectory(uri);
            } else {
              return null;
            }
          },
        },
      );
      onDidChangeFilesCallback = null;
    });

    it("uses the provider's custom directories for any paths that it handles", () => {
      const localPath = temp.mkdirSync("local-path");
      const remotePath = "ssh://foreign-directory:8080/does-exist";

      lumine.project.setPaths([localPath, remotePath]);

      let directories = lumine.project.getDirectories();
      expect(directories[0].getPath()).toBe(localPath);
      expect(directories[0] instanceof ProjectDirectory).toBe(true);
      expect(directories[1].getPath()).toBe(remotePath);
      expect(directories[1] instanceof DummyDirectory).toBe(true);

      // It does not add new remote paths that do not exist
      const nonExistentRemotePath = "ssh://another-directory:8080/does-not-exist";
      lumine.project.addPath(nonExistentRemotePath);
      expect(lumine.project.getDirectories().length).toBe(2);

      // It adds new remote paths if their directories exist.
      const newRemotePath = "ssh://another-directory:8080/does-exist";
      lumine.project.addPath(newRemotePath);
      directories = lumine.project.getDirectories();
      expect(directories[2].getPath()).toBe(newRemotePath);
      expect(directories[2] instanceof DummyDirectory).toBe(true);
    });

    it("stops using the provider when the service is removed", () => {
      serviceDisposable.dispose();
      lumine.project.setPaths(["ssh://foreign-directory:8080/does-exist"]);
      expect(lumine.project.getDirectories().length).toBe(0);
    });

    it("uses the custom onDidChangeFiles as the watcher if available", async () => {
      // Ensure that all preexisting watchers are stopped
      await stopAllWatchers();

      const remotePath = "ssh://another-directory:8080/does-exist";
      lumine.project.setPaths([remotePath]);
      await lumine.project.getWatcherPromise(remotePath);

      expect(onDidChangeFilesCallback).not.toBeNull();

      const changeSpy = jasmine.createSpy("lumine.project.onDidChangeFiles");
      const disposable = lumine.project.onDidChangeFiles(changeSpy);

      const events = [{ action: "created", path: remotePath + "/test.txt" }];
      onDidChangeFilesCallback(events);

      expect(changeSpy).toHaveBeenCalledWith(events);
      disposable.dispose();
    });
  });

  describe(".open(path)", () => {
    let absolutePath, newBufferHandler;

    beforeEach(() => {
      absolutePath = require.resolve("./fixtures/dir/a");
      newBufferHandler = jasmine.createSpy("newBufferHandler");
      lumine.project.onDidAddBuffer(newBufferHandler);
    });

    describe("when given an absolute path that isn't currently open", () => {
      it("returns a new edit session for the given path and emits 'buffer-created'", async () => {
        let editor = await lumine.workspace.open(absolutePath);

        expect(editor.buffer.getPath()).toBe(absolutePath);
        expect(newBufferHandler).toHaveBeenCalledWith(editor.buffer);
      });
    });

    describe("when given a relative path that isn't currently opened", () => {
      it("returns a new edit session for the given path (relative to the project root) and emits 'buffer-created'", async () => {
        let editor = await lumine.workspace.open(absolutePath);

        expect(editor.buffer.getPath()).toBe(absolutePath);
        expect(newBufferHandler).toHaveBeenCalledWith(editor.buffer);
      });
    });

    describe("when passed the path to a buffer that is currently opened", () => {
      it("returns a new edit session containing currently opened buffer", async () => {
        let editor = await lumine.workspace.open(absolutePath);
        let buffer;

        newBufferHandler.calls.reset();

        buffer = (await lumine.workspace.open(absolutePath)).buffer;
        expect(buffer).toBe(editor.buffer);

        buffer = (await lumine.workspace.open("a")).buffer;
        expect(buffer).toBe(editor.buffer);
        expect(newBufferHandler).not.toHaveBeenCalled();
      });
    });

    describe("when not passed a path", () => {
      it("returns a new edit session and emits 'buffer-created'", async () => {
        let editor = await lumine.workspace.open();

        expect(editor.buffer.getPath()).toBeUndefined();
        expect(newBufferHandler).toHaveBeenCalledWith(editor.buffer);
      });
    });
  });

  describe(".bufferForPath(path)", () => {
    let buffer = null;

    beforeEach(async () => {
      buffer = await lumine.project.bufferForPath("a");
      buffer.retain();
    });

    afterEach(() => buffer.release());

    describe("when opening a previously opened path", () => {
      it("does not create a new buffer", async () => {
        expect(await lumine.project.bufferForPath("a")).toBe(buffer);
        expect(await lumine.project.bufferForPath("b")).not.toBe(buffer);

        const [buffer1, buffer2] = await Promise.all([
          lumine.project.bufferForPath("c"),
          lumine.project.bufferForPath("c"),
        ]);

        expect(buffer1).toBe(buffer2);
      });

      it("retries loading the buffer if it previously failed", async () => {
        const error = new Error("Could not open file");
        spyOn(TextBuffer, "load").and.callFake(() => Promise.reject(error));
        await lumine.project.bufferForPath("b").catch((e) => expect(e).toBe(error));

        TextBuffer.load.and.callThrough();
        await lumine.project.bufferForPath("b");
      });

      it("creates a new buffer if the previous buffer was destroyed", async () => {
        buffer.release();
        expect(await lumine.project.bufferForPath("b")).not.toBe(buffer);
      });
    });
  });

  describe(".repositoryForDirectory(directory)", () => {
    it("resolves to null when the directory does not have a repository", async () => {
      const directory = new ProjectDirectory("/tmp");
      const result = await lumine.project.repositoryForDirectory(directory);

      expect(result).toBeNull();
      expect(lumine.project.repositoryProviders.length).toBeGreaterThan(0);
      expect(lumine.project.repositoryPromisesByPath.size).toBe(0);
    });

    it("resolves to a GitRepository and is cached when the given directory is a Git repo", async () => {
      const directory = new ProjectDirectory(path.join(__dirname, ".."));

      const promise = lumine.project.repositoryForDirectory(directory);
      const result = await promise;

      expect(result).toEqual(jasmine.any(GitRepository));
      const dirPath = directory.getRealPathSync();
      expect(result.getPath()).toBe(path.join(dirPath, ".git"));

      // Verify that the repository identity is cached.
      expect(await lumine.project.repositoryForDirectory(directory)).toBe(result);
    });

    it("creates a new repository if a previous one with the same directory had been destroyed", async () => {
      let repository;
      const directory = new ProjectDirectory(path.join(__dirname, ".."));

      repository = await lumine.project.repositoryForDirectory(directory);

      expect(repository.isDestroyed()).toBe(false);
      repository.destroy();
      expect(repository.isDestroyed()).toBe(true);

      repository = await lumine.project.repositoryForDirectory(directory);

      expect(repository.isDestroyed()).toBe(false);
    });
  });

  describe(".repositoryForPath(filePath)", () => {
    it("resolves to null for a falsy path", async () => {
      expect(await lumine.project.repositoryForPath("")).toBeNull();
      expect(await lumine.project.repositoryForPath(null)).toBeNull();
    });

    it("resolves to null when the path is not inside a repository", async () => {
      const dir = temp.mkdirSync("linter-no-repo");
      expect(await lumine.project.repositoryForPath(path.join(dir, "file.txt"))).toBeNull();
    });

    it("resolves the repository that contains a given file path", async () => {
      // The caller passes a file path (not a Directory); it resolves to the
      // repository containing that file, mirroring repositoryForDirectory.
      const filePath = path.join(__dirname, "project-spec.js");
      const result = await lumine.project.repositoryForPath(filePath);

      expect(result).toEqual(jasmine.any(GitRepository));
      const dirPath = new ProjectDirectory(path.join(__dirname, "..")).getRealPathSync();
      expect(result.getPath()).toBe(path.join(dirPath, ".git"));
    });
  });

  describe(".setPaths(paths, options)", () => {
    describe("when path is a file", () => {
      it("sets its path to the file's parent directory and updates the root directory", () => {
        const filePath = require.resolve("./fixtures/dir/a");
        lumine.project.setPaths([filePath]);
        expect(lumine.project.getPaths()[0]).toEqual(path.dirname(filePath));
        expect(lumine.project.getDirectories()[0].path).toEqual(path.dirname(filePath));
      });
    });

    describe("when path is a directory", () => {
      it("assigns the directories and repositories", async () => {
        const directory1 = temp.mkdirSync("non-git-repo");
        const directory2 = temp.mkdirSync("git-repo1");
        const directory3 = temp.mkdirSync("git-repo2");

        const gitDirPath = fs.absolute(path.join(__dirname, "fixtures", "git", "master.git"));
        fs.copySync(gitDirPath, path.join(directory2, ".git"));
        fs.copySync(gitDirPath, path.join(directory3, ".git"));

        lumine.project.setPaths([directory1, directory2, directory3]);

        const repo1 = lumine.repositories.getForPath(directory1);
        const repo2 = lumine.repositories.getForPath(directory2);
        const repo3 = lumine.repositories.getForPath(directory3);
        expect(repo1).toBeNull();
        // The short head is read from the refs snapshot, loaded on demand.
        await repo2.ensureRefsSnapshot();
        await repo3.ensureRefsSnapshot();
        expect(repo2.getShortHead()).toBe("master");
        // `realpathSync.native` canonicalizes 8.3 short path segments (e.g. a
        // shortened temp dir) to their long form, matching how the repository
        // resolves its path. Plain `realpathSync` leaves them short.
        expect(repo2.getPath()).toBe(fs.realpathSync.native(path.join(directory2, ".git")));
        expect(repo3.getShortHead()).toBe("master");
        expect(repo3.getPath()).toBe(fs.realpathSync.native(path.join(directory3, ".git")));
      });

      it("calls callbacks registered with ::onDidChangePaths", () => {
        const onDidChangePathsSpy = jasmine.createSpy("onDidChangePaths spy");
        lumine.project.onDidChangePaths(onDidChangePathsSpy);

        const paths = [temp.mkdirSync("dir1"), temp.mkdirSync("dir2")];
        lumine.project.setPaths(paths);

        expect(onDidChangePathsSpy.calls.count()).toBe(1);
        expect(onDidChangePathsSpy.calls.mostRecent().args[0]).toEqual(paths);
      });

      it("optionally throws an error with any paths that did not exist", () => {
        const paths = [
          temp.mkdirSync("exists0"),
          "/doesnt-exists/0",
          temp.mkdirSync("exists1"),
          "/doesnt-exists/1",
        ];

        try {
          lumine.project.setPaths(paths, { mustExist: true });
          expect("no exception thrown").toBeUndefined();
        } catch (e) {
          expect(e.missingProjectPaths).toEqual([paths[1], paths[3]]);
        }

        expect(lumine.project.getPaths()).toEqual([paths[0], paths[2]]);
      });
    });

    describe("when no paths are given", () => {
      it("clears its path", () => {
        lumine.project.setPaths([]);
        expect(lumine.project.getPaths()).toEqual([]);
        expect(lumine.project.getDirectories()).toEqual([]);
      });
    });

    it("normalizes the path to remove consecutive slashes, ., and .. segments", () => {
      lumine.project.setPaths([
        `${require.resolve("./fixtures/dir/a")}${path.sep}b${path.sep}${path.sep}..`,
      ]);
      expect(lumine.project.getPaths()[0]).toEqual(
        path.dirname(require.resolve("./fixtures/dir/a")),
      );
      expect(lumine.project.getDirectories()[0].path).toEqual(
        path.dirname(require.resolve("./fixtures/dir/a")),
      );
    });
  });

  describe(".addPath(path, options)", () => {
    it("calls callbacks registered with ::onDidChangePaths", () => {
      const onDidChangePathsSpy = jasmine.createSpy("onDidChangePaths spy");
      lumine.project.onDidChangePaths(onDidChangePathsSpy);

      const [oldPath] = lumine.project.getPaths();

      const newPath = temp.mkdirSync("dir");
      lumine.project.addPath(newPath);

      expect(onDidChangePathsSpy.calls.count()).toBe(1);
      expect(onDidChangePathsSpy.calls.mostRecent().args[0]).toEqual([oldPath, newPath]);
    });

    it("doesn't add redundant paths", () => {
      const onDidChangePathsSpy = jasmine.createSpy("onDidChangePaths spy");
      lumine.project.onDidChangePaths(onDidChangePathsSpy);
      const [oldPath] = lumine.project.getPaths();

      // Doesn't re-add an existing root directory
      lumine.project.addPath(oldPath);
      expect(lumine.project.getPaths()).toEqual([oldPath]);
      expect(onDidChangePathsSpy).not.toHaveBeenCalled();

      // Doesn't add an entry for a file-path within an existing root directory
      lumine.project.addPath(path.join(oldPath, "some-file.txt"));
      expect(lumine.project.getPaths()).toEqual([oldPath]);
      expect(onDidChangePathsSpy).not.toHaveBeenCalled();

      // Does add an entry for a directory within an existing directory
      const newPath = path.join(oldPath, "a-dir");
      lumine.project.addPath(newPath);
      expect(lumine.project.getPaths()).toEqual([oldPath, newPath]);
      expect(onDidChangePathsSpy).toHaveBeenCalled();
    });

    it("doesn't add non-existent directories", () => {
      const previousPaths = lumine.project.getPaths();
      lumine.project.addPath("/this-definitely/does-not-exist");
      expect(lumine.project.getPaths()).toEqual(previousPaths);
    });

    it("optionally throws on non-existent directories", () => {
      expect(() =>
        lumine.project.addPath("/this-definitely/does-not-exist", {
          mustExist: true,
        }),
      ).toThrow();
    });
  });

  describe(".addPaths(projectPaths, options)", () => {
    it("adds multiple paths and emits a single did-change-paths event", () => {
      const onDidChangePathsSpy = jasmine.createSpy("onDidChangePaths spy");
      lumine.project.onDidChangePaths(onDidChangePathsSpy);

      const [oldPath] = lumine.project.getPaths();
      const newPath1 = temp.mkdirSync("dir1");
      const newPath2 = temp.mkdirSync("dir2");
      lumine.project.addPaths([newPath1, newPath2]);

      expect(lumine.project.getPaths()).toEqual([oldPath, newPath1, newPath2]);
      expect(onDidChangePathsSpy.calls.count()).toBe(1);
      expect(onDidChangePathsSpy.calls.mostRecent().args[0]).toEqual([oldPath, newPath1, newPath2]);
    });

    it("does not fire an event if all paths are already project paths", () => {
      const onDidChangePathsSpy = jasmine.createSpy("onDidChangePaths spy");
      lumine.project.onDidChangePaths(onDidChangePathsSpy);

      const [oldPath] = lumine.project.getPaths();
      lumine.project.addPaths([oldPath]);

      expect(onDidChangePathsSpy).not.toHaveBeenCalled();
    });

    it("fires an event if only some paths are already project paths", () => {
      const onDidChangePathsSpy = jasmine.createSpy("onDidChangePaths spy");
      lumine.project.onDidChangePaths(onDidChangePathsSpy);

      const [oldPath] = lumine.project.getPaths();
      const newPath = temp.mkdirSync("dir");
      lumine.project.addPaths([oldPath, newPath]);

      expect(lumine.project.getPaths()).toEqual([oldPath, newPath]);
      expect(onDidChangePathsSpy.calls.count()).toBe(1);
    });
  });

  describe(".removePath(path)", () => {
    let onDidChangePathsSpy = null;

    beforeEach(() => {
      onDidChangePathsSpy = jasmine.createSpy("onDidChangePaths listener");
      lumine.project.onDidChangePaths(onDidChangePathsSpy);
    });

    it("removes the directory and repository for the path", () => {
      const result = lumine.project.removePath(lumine.project.getPaths()[0]);
      expect(lumine.project.getDirectories()).toEqual([]);
      expect(lumine.repositories.getRepositories()).toEqual([]);
      expect(lumine.project.getPaths()).toEqual([]);
      expect(result).toBe(true);
      expect(onDidChangePathsSpy).toHaveBeenCalled();
    });

    it("does nothing if the path is not one of the project's root paths", () => {
      const originalPaths = lumine.project.getPaths();
      const result = lumine.project.removePath(originalPaths[0] + "xyz");
      expect(result).toBe(false);
      expect(lumine.project.getPaths()).toEqual(originalPaths);
      expect(onDidChangePathsSpy).not.toHaveBeenCalled();
    });

    it("doesn't destroy the repository if it is shared by another root directory", () => {
      lumine.project.setPaths([__dirname, path.join(__dirname, "..", "src")]);
      lumine.project.removePath(__dirname);
      expect(lumine.project.getPaths()).toEqual([path.join(__dirname, "..", "src")]);
      expect(lumine.repositories.getRepositories()[0].isSubmodule("src")).toBe(false);
    });

    it("removes a path that is represented as a URI", () => {
      lumine.packages.serviceHub.provide("project.directory-provider", "1.0.0", {
        directoryForURISync(uri) {
          return {
            getPath() {
              return uri;
            },
            getSubdirectory() {
              return {};
            },
            isRoot() {
              return true;
            },
            existsSync() {
              return true;
            },
            off() {},
          };
        },
      });

      const ftpURI = "ftp://example.com/some/folder";

      lumine.project.setPaths([ftpURI]);
      expect(lumine.project.getPaths()).toEqual([ftpURI]);

      lumine.project.removePath(ftpURI);
      expect(lumine.project.getPaths()).toEqual([]);
    });
  });

  describe(".onDidChangeFiles()", () => {
    let sub;
    let events;
    let checkCallback = () => {};

    beforeEach(() => {
      events = [];
      sub = lumine.project.onDidChangeFiles((incoming) => {
        events.push(...incoming);
        checkCallback();
      });
    });

    afterEach(() => sub.dispose());

    // Watcher-event round-trips on a loaded CI runner can far exceed the
    // default spec deadline.
    const CHANGE_NOTIFICATION_DEADLINE = 30000;

    const waitForEvents = (paths) => {
      const remaining = new Set(paths.map((p) => fs.realpathSync(p)));
      return new Promise((resolve, reject) => {
        let expireTimeoutId;
        checkCallback = () => {
          for (let event of events) {
            remaining.delete(event.path);
          }
          if (remaining.size === 0) {
            clearTimeout(expireTimeoutId);
            resolve();
          }
        };

        const expire = () => {
          checkCallback = () => {};
          console.error("Paths not seen:", remaining);
          reject(new Error("Expired before all expected events were delivered."));
        };

        expireTimeoutId = setTimeout(expire, 10000);
        checkCallback();
      });
    };

    it(
      "reports filesystem changes within project paths",
      async () => {
        jasmine.useRealClock();
        const dirOne = temp.mkdirSync("lumine-spec-project-one");
        const fileOne = path.join(dirOne, "file-one.txt");
        const fileTwo = path.join(dirOne, "file-two.txt");
        const dirTwo = temp.mkdirSync("lumine-spec-project-two");
        const fileThree = path.join(dirTwo, "file-three.txt");

        // Ensure that all preexisting watchers are stopped
        await stopAllWatchers();

        lumine.project.setPaths([dirOne]);
        await lumine.project.getWatcherPromise(dirOne);

        // The watcher promise confirms the subscription exists, but events can
        // still be dropped in the watcher's start-up window. Prove the watch is
        // delivering before the real writes: touch a probe file (with fresh
        // content each attempt) until its event arrives.
        const probeFile = path.join(dirOne, "probe.txt");
        const probeRealPath = () => fs.realpathSync(probeFile);
        await new Promise((resolve) => {
          let probeCount = 0;
          let probeTimer;
          checkCallback = () => {
            if (events.some((event) => event.path === probeRealPath())) {
              clearInterval(probeTimer);
              resolve();
            }
          };
          const probe = () => {
            probeCount++;
            fs.writeFileSync(probeFile, `probe ${probeCount}`);
          };
          probeTimer = setInterval(probe, 500);
          probe();
        });
        events = [];

        expect(lumine.project.watcherPromisesByPath[dirTwo]).toEqual(undefined);
        fs.writeFileSync(fileThree, "three\n");
        fs.writeFileSync(fileTwo, "two\n");
        fs.writeFileSync(fileOne, "one\n");
        await waitForEvents([fileOne, fileTwo]);
        expect(events.some((event) => event.path === fileThree)).toBeFalsy();
      },
      CHANGE_NOTIFICATION_DEADLINE,
    );
  });

  describe(".onDidAddBuffer()", () => {
    it("invokes the callback with added text buffers", async () => {
      const buffers = [];
      const added = [];

      buffers.push(await lumine.project.buildBuffer(require.resolve("./fixtures/dir/a")));

      expect(buffers.length).toBe(1);
      lumine.project.onDidAddBuffer((buffer) => added.push(buffer));

      buffers.push(await lumine.project.buildBuffer(require.resolve("./fixtures/dir/b")));

      expect(buffers.length).toBe(2);
      expect(added).toEqual([buffers[1]]);
    });
  });

  describe(".observeBuffers()", () => {
    it("invokes the observer with current and future text buffers", async () => {
      const buffers = [];
      const observed = [];

      buffers.push(await lumine.project.buildBuffer(require.resolve("./fixtures/dir/a")));
      buffers.push(await lumine.project.buildBuffer(require.resolve("./fixtures/dir/b")));

      expect(buffers.length).toBe(2);
      lumine.project.observeBuffers((buffer) => observed.push(buffer));
      expect(observed).toEqual(buffers);

      buffers.push(await lumine.project.buildBuffer(require.resolve("./fixtures/dir/b")));

      expect(observed.length).toBe(3);
      expect(buffers.length).toBe(3);
      expect(observed).toEqual(buffers);
    });
  });

  describe("lumine.repositories.observeRepositories() driven by project roots", () => {
    it("invokes the observer with current and future repositories", async () => {
      const observed = [];

      const directory1 = temp.mkdirSync("git-repo1");
      const gitDirPath1 = fs.absolute(path.join(__dirname, "fixtures", "git", "master.git"));
      fs.copySync(gitDirPath1, path.join(directory1, ".git"));

      const directory2 = temp.mkdirSync("git-repo2");
      const gitDirPath2 = fs.absolute(
        path.join(__dirname, "fixtures", "git", "repo-with-submodules", "git.git"),
      );
      fs.copySync(gitDirPath2, path.join(directory2, ".git"));

      lumine.project.setPaths([directory1]);

      const disposable = lumine.repositories.observeRepositories((repo) => observed.push(repo));
      const firstRepository = lumine.repositories.getForPath(directory1);
      expect(observed).toContain(firstRepository);
      await firstRepository.ensureRefsSnapshot();
      expect(firstRepository.getReferenceTarget("refs/heads/master")).toBe(
        "ef046e9eecaa5255ea5e9817132d4001724d6ae1",
      );

      lumine.project.addPath(directory2);
      const secondRepository = lumine.repositories.getForPath(directory2);
      expect(observed).toContain(secondRepository);
      await secondRepository.ensureRefsSnapshot();
      expect(secondRepository.getReferenceTarget("refs/heads/master")).toBe(
        "d2b0ad9cbc6f6c4372e8956e5cc5af771b2342e5",
      );

      disposable.dispose();
    });
  });

  describe("lumine.repositories.onDidAddRepository() driven by project roots", () => {
    it("invokes callback when a path is added and the path is the root of a repository", async () => {
      const observed = [];
      const disposable = lumine.repositories.onDidAddRepository((repo) => observed.push(repo));

      const projectRootPath = temp.mkdirSync();
      const fixtureRepoPath = fs.absolute(path.join(__dirname, "fixtures", "git", "master.git"));
      fs.copySync(fixtureRepoPath, path.join(projectRootPath, ".git"));

      lumine.project.addPath(projectRootPath);
      expect(observed.length).toBe(1);
      await observed[0].ensureRefsSnapshot();
      expect(observed[0].getOriginURL()).toEqual(
        "https://github.com/example-user/example-repo.git",
      );

      disposable.dispose();
    });

    it("invokes callback when a path is added and the path is subdirectory of a repository", async () => {
      const observed = [];
      const disposable = lumine.repositories.onDidAddRepository((repo) => observed.push(repo));

      const projectRootPath = temp.mkdirSync();
      const fixtureRepoPath = fs.absolute(path.join(__dirname, "fixtures", "git", "master.git"));
      fs.copySync(fixtureRepoPath, path.join(projectRootPath, ".git"));

      const projectSubDirPath = path.join(projectRootPath, "sub-dir");
      fs.mkdirSync(projectSubDirPath);

      lumine.project.addPath(projectSubDirPath);
      expect(observed.length).toBe(1);
      await observed[0].ensureRefsSnapshot();
      expect(observed[0].getOriginURL()).toEqual(
        "https://github.com/example-user/example-repo.git",
      );

      disposable.dispose();
    });

    it("does not invoke callback when a path is added and the path is not part of a repository", () => {
      const observed = [];
      const disposable = lumine.repositories.onDidAddRepository((repo) => observed.push(repo));

      lumine.project.addPath(temp.mkdirSync("not-a-repository"));
      expect(observed.length).toBe(0);

      disposable.dispose();
    });
  });

  describe(".reset()", () => {
    it("re-attaches the repository registry when a destroyed project is reset", () => {
      // Legacy window specs destroy the window's project and rely on the
      // between-spec reset to bring it back; the registry must survive that.
      lumine.project.destroy();
      expect(() => lumine.project.reset(lumine.packages)).not.toThrow();

      lumine.project.setPaths([__dirname]);
      expect(lumine.repositories.getForPath(__dirname)).toBeTruthy();
    });
  });

  describe(".relativize(path)", () => {
    it("returns the path, relative to whichever root directory it is inside of", () => {
      lumine.project.addPath(temp.mkdirSync("another-path"));

      let rootPath = lumine.project.getPaths()[0];
      let childPath = path.join(rootPath, "some", "child", "directory");
      expect(lumine.project.relativize(childPath)).toBe(path.join("some", "child", "directory"));

      rootPath = lumine.project.getPaths()[1];
      childPath = path.join(rootPath, "some", "child", "directory");
      expect(lumine.project.relativize(childPath)).toBe(path.join("some", "child", "directory"));
    });

    it("returns the given path if it is not in any of the root directories", () => {
      const randomPath = path.join("some", "random", "path");
      expect(lumine.project.relativize(randomPath)).toBe(randomPath);
    });
  });

  describe(".relativizePath(path)", () => {
    it("returns the root path that contains the given path, and the path relativized to that root path", () => {
      lumine.project.addPath(temp.mkdirSync("another-path"));

      let rootPath = lumine.project.getPaths()[0];
      let childPath = path.join(rootPath, "some", "child", "directory");
      expect(lumine.project.relativizePath(childPath)).toEqual([
        rootPath,
        path.join("some", "child", "directory"),
      ]);

      rootPath = lumine.project.getPaths()[1];
      childPath = path.join(rootPath, "some", "child", "directory");
      expect(lumine.project.relativizePath(childPath)).toEqual([
        rootPath,
        path.join("some", "child", "directory"),
      ]);
    });

    describe("when the given path isn't inside of any of the project's path", () => {
      it("returns null for the root path, and the given path unchanged", () => {
        const randomPath = path.join("some", "random", "path");
        expect(lumine.project.relativizePath(randomPath)).toEqual([null, randomPath]);
      });
    });

    describe("when the given path is a URL", () => {
      it("returns null for the root path, and the given path unchanged", () => {
        const url = "http://the-path";
        expect(lumine.project.relativizePath(url)).toEqual([null, url]);
      });
    });

    describe("when the given path is inside more than one root folder", () => {
      it("uses the root folder that is closest to the given path", () => {
        lumine.project.addPath(path.join(lumine.project.getPaths()[0], "a-dir"));

        const inputPath = path.join(lumine.project.getPaths()[1], "somewhere/something.txt");

        expect(lumine.project.getDirectories()[0].contains(inputPath)).toBe(true);
        expect(lumine.project.getDirectories()[1].contains(inputPath)).toBe(true);
        expect(lumine.project.relativizePath(inputPath)).toEqual([
          lumine.project.getPaths()[1],
          path.join("somewhere", "something.txt"),
        ]);
      });
    });
  });

  describe(".contains(path)", () => {
    it("returns whether or not the given path is in one of the root directories", () => {
      const rootPath = lumine.project.getPaths()[0];
      const childPath = path.join(rootPath, "some", "child", "directory");
      expect(lumine.project.contains(childPath)).toBe(true);

      const randomPath = path.join("some", "random", "path");
      expect(lumine.project.contains(randomPath)).toBe(false);
    });
  });

  describe(".resolvePath(uri)", () => {
    it("normalizes disk drive letter in passed path on win32", (done) => {
      jasmine.filterByPlatform({ only: ["win32"] }, done);

      expect(lumine.project.resolvePath("d:\\file.txt")).toEqual("D:\\file.txt");

      done();
    });
  });
});
