const { configureNativeBackend, validateNativeBackend } = require("../src/git-native-backend");

function backend(versions = { gitUtils: "10.0.0", napi: 10, libgit2: "1.9.6" }) {
  const resolved = () => Promise.resolve(null);
  return {
    versions: () => versions,
    configure: (options) => options,
    snapshot: resolved,
    diff: resolved,
    history: resolved,
    commit: resolved,
    blame: resolved,
    describe: resolved,
    branchesContaining: resolved,
    readObjects: resolved,
    readConfig: resolved,
    fileMode: resolved,
    submodulePaths: resolved,
    lineDiff: resolved,
    mutate: resolved,
  };
}

describe("git-utils native backend gate", () => {
  it("accepts git-utils 10 backed by libgit2 1.9.6", () => {
    const native = backend();
    const loaded = validateNativeBackend(native);
    expect(loaded.nativeBackend).toBe(native);
    expect(loaded.versions.libgit2).toBe("1.9.6");
  });

  it("configures repository ownership validation from the trust setting", () => {
    const configurations = [];
    const native = backend();
    native.configure = (options) => configurations.push(options);
    const loaded = validateNativeBackend(native);

    configureNativeBackend(loaded, { trustAllRepositories: true });
    configureNativeBackend(loaded, { trustAllRepositories: false });

    expect(configurations).toEqual([{ validateOwnership: false }, { validateOwnership: true }]);
  });

  it("rejects an incompatible git-utils major as a non-retriable init error", () => {
    let error;
    try {
      validateNativeBackend(backend({ gitUtils: "9.9.0", napi: 10, libgit2: "1.9.6" }));
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_NATIVE_INIT");
    expect(error.operation).toBe("initialize");
    expect(error.retriable).toBe(false);
  });

  it("rejects a backend linked to a different libgit2 release", () => {
    let error;
    try {
      validateNativeBackend(backend({ gitUtils: "10.0.0", napi: 10, libgit2: "1.9.5" }));
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_NATIVE_INIT");
    expect(error.message).toContain("1.9.6");
  });
});
