const {
  configureNativeBackend,
  createNativeBackendCapability,
  validateNativeBackend,
} = require("../src/git-native-backend");

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

  it("loads and configures an injected backend only on first use", () => {
    const configurations = [];
    const native = backend();
    native.configure = (options) => configurations.push(options);
    const capability = createNativeBackendCapability({
      nativeBackend: native,
      trustAllRepositories: true,
    });

    expect(capability.status().state).toBe("uninitialized");
    expect(configurations).toEqual([]);
    expect(capability.get()).toBe(native);
    expect(capability.get()).toBe(native);
    expect(capability.status().state).toBe("ready");
    expect(capability.status().versions.libgit2).toBe("1.9.6");
    expect(configurations).toEqual([{ validateOwnership: false }]);
  });

  it("memoizes a native initialization failure", () => {
    const native = backend({ gitUtils: "9.0.0", napi: 10, libgit2: "1.9.6" });
    const versions = spyOn(native, "versions").and.callThrough();
    const capability = createNativeBackendCapability({ nativeBackend: native });

    let first;
    let second;
    try {
      capability.get();
    } catch (error) {
      first = error;
    }
    try {
      capability.get();
    } catch (error) {
      second = error;
    }

    expect(second).toBe(first);
    expect(versions.calls.count()).toBe(1);
    expect(capability.status().state).toBe("failed");
  });
});
