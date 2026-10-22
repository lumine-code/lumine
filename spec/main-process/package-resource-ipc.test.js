/* globals assert */

const { handlePackageResource } = require("../../src/lumine-application");

describe("Package resource lifecycle IPC", () => {
  let originalApplication, sender, frame, publications;

  beforeEach(() => {
    originalApplication = global.lumineApplication;
    publications = [];
    frame = {};
    sender = { mainFrame: frame };
    global.lumineApplication = {
      lumineWindowForSender(candidate) {
        if (candidate !== sender) throw new Error("Unknown window sender");
        return { resourceProtocol: { updatePackage: (request) => publications.push(request) } };
      },
    };
  });

  afterEach(() => {
    global.lumineApplication = originalApplication;
  });

  it("acknowledges the exact top-frame publication synchronously", () => {
    const request = {
      action: "add",
      name: "actual-manifest-name",
      root: "/different-directory",
      owner: "package-generation",
      generation: "renderer-generation",
    };
    assert.deepEqual(handlePackageResource({ sender, senderFrame: frame }, request), { ok: true });
    assert.deepEqual(publications, [request]);
  });

  it("rejects unknown windows and embedded frames without mutating the map", () => {
    assert.match(
      handlePackageResource({ sender: {}, senderFrame: frame }, {}).error.message,
      /Unknown window sender/,
    );
    assert.match(
      handlePackageResource({ sender, senderFrame: {} }, {}).error.message,
      /Only the workspace/,
    );
    assert.deepEqual(publications, []);
  });

  it("always replies when validation fails so sync IPC cannot wait indefinitely", () => {
    global.lumineApplication.lumineWindowForSender = () => ({
      resourceProtocol: {
        updatePackage() {
          throw new TypeError("Invalid package root");
        },
      },
    });
    assert.deepEqual(handlePackageResource({ sender, senderFrame: frame }, {}), {
      error: { message: "Invalid package root" },
    });
  });
});
