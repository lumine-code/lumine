const path = require("node:path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/fs-temp").track();
const GitRepository = require("../src/git-repository");

describe("repository remote reads", () => {
  let repository;

  afterEach(() => repository?.destroy());

  it("reads effective fetch and push URLs without loading either snapshot", async () => {
    const directory = temp.mkdirSync("git-remotes-");
    fs.copySync(path.join(__dirname, "fixtures", "git", "working-dir"), directory);
    const gitDirectory = path.join(directory, ".git");
    fs.renameSync(path.join(directory, "git.git"), gitDirectory);
    const config = path.join(gitDirectory, "config");
    fs.appendFileSync(
      config,
      '\n[remote "remote-spec"]\n\turl = remote-spec-prefix:owner/repo.git\n' +
        '\tpushurl = git@example.invalid:owner/repo.git\n[url "https://example.invalid/"]\n' +
        "\tinsteadOf = remote-spec-prefix:\n",
    );
    repository = await GitRepository.open(directory);
    const request = spyOn(repository.gitHostClient, "request").and.callThrough();

    const remotes = await repository.readRemotes();
    const remote = remotes.find(({ name }) => name === "remote-spec");
    expect(remote).toEqual({
      name: "remote-spec",
      fetchUrl: "https://example.invalid/owner/repo.git",
      pushUrl: "git@example.invalid:owner/repo.git",
    });
    expect(Object.isFrozen(remotes)).toBe(true);
    expect(Object.isFrozen(remote)).toBe(true);
    expect(request.calls.allArgs().map(([operation]) => operation)).toEqual(["readRemotes"]);
    expect(repository.getStatusSnapshot().initialized).toBe(false);
    expect(repository.getRefsSnapshot().initialized).toBe(false);
  });
});
