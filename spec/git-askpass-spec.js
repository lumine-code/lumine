const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();
const { fromUserAskpass } = require("../src/askpass");
const GitAuthBroker = require("../src/git-auth-broker");

describe("Git askpass delegation", () => {
  it("passes prompt and program punctuation as literal arguments", async () => {
    const directory = temp.mkdirSync("git-askpass-delegation");
    const program = path.join(directory, "helper's script.sh");
    fs.writeFileSync(program, '#!/bin/sh\nprintf "%s" "$1"\n');
    fs.chmodSync(program, 0o700);
    const message = "Password for 'https://user@host': $(printf injected); ' and \\ quotes";
    const broker = new GitAuthBroker();
    try {
      await broker.ensureStarted();
      const shell = broker.getEnvironment({}).env.LUMINE_GIT_AUTH_SHELL;
      expect(
        await fromUserAskpass({
          program: program.replace(/\\/g, "/"),
          message,
          cwd: directory,
          shell,
        }),
      ).toBe(message);
    } finally {
      await broker.terminate();
    }
  });
});
