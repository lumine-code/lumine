const fs = require("fs");
const temp = require("@lumine-code/temp").track();

describe("Git repository discovery in the renderer", () => {
  // Repeated real discoveries cross renderer callbacks and spec teardown. A
  // Node AsyncLocalStorage context here previously crashed the fourth run.
  for (let index = 0; index < 4; index++) {
    it(`initializes and forgets repository ${index + 1} in the renderer`, async () => {
      const directory = fs.realpathSync.native(temp.mkdirSync("git-discovery-renderer-"));
      const repository = await lumine.repositories.initialize(directory, { initialBranch: "main" });
      try {
        expect(repository.getWorkingDirectory().replace(/\\/g, "/")).toBe(
          directory.replace(/\\/g, "/"),
        );
      } finally {
        lumine.repositories.forget(repository);
      }
    });
  }
});
