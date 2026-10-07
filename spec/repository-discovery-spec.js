const RepositoryDiscovery = require("../src/repository-discovery");

describe("Repository discovery transactions", () => {
  it("abandons candidates returned by providers that did not win", async () => {
    const selected = {};
    const unused = {};
    const first = {
      repositoryForPath: async () => selected,
      abandonRepositoryForPath: jasmine.createSpy("abandon selected"),
    };
    const second = {
      repositoryForPath: async () => unused,
      abandonRepositoryForPath: jasmine.createSpy("abandon unused"),
    };
    const discovery = new RepositoryDiscovery({ providers: [first, second] });
    expect(await discovery.repositoryForPathFromProviders(__filename)).toBe(selected);
    await new Promise((resolve) => setImmediate(resolve));
    expect(first.abandonRepositoryForPath).not.toHaveBeenCalled();
    expect(second.abandonRepositoryForPath).toHaveBeenCalledOnceWith(unused, __filename);
  });

  it("releases candidates when another provider throws synchronously", async () => {
    const candidate = {};
    const first = {
      repositoryForPath: () => candidate,
      abandonRepositoryForPath: jasmine.createSpy("abandon candidate"),
    };
    const failure = new Error("Discovery failed");
    const second = {
      repositoryForPath: () => {
        throw failure;
      },
    };
    const discovery = new RepositoryDiscovery({ providers: [first, second] });
    await expectAsync(discovery.repositoryForPathFromProviders(__filename)).toBeRejectedWith(
      failure,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(first.abandonRepositoryForPath).toHaveBeenCalledOnceWith(candidate, __filename);
    expect(discovery.repositoryPromisesByPath.size).toBe(0);
  });
});
