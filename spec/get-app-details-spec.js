const fs = require("@lumine-code/fs-plus");
const path = require("path");
const temp = require("@lumine-code/temp").track();
const { getConfigFilePath } = require("../src/get-app-details");

describe("get-app-details", () => {
  let originalAtomHome;

  beforeEach(() => {
    originalAtomHome = process.env.LUMINE_HOME;
    process.env.LUMINE_HOME = temp.mkdirSync("lumine-config-");
  });

  afterEach(() => {
    if (originalAtomHome == null) {
      delete process.env.LUMINE_HOME;
    } else {
      process.env.LUMINE_HOME = originalAtomHome;
    }
  });

  it("uses config.json as the default path", () => {
    expect(getConfigFilePath()).toBeNull();
    expect(getConfigFilePath({ returnPlaceholder: true })).toBe(
      path.join(process.env.LUMINE_HOME, "config.json"),
    );
  });

  it("prefers JSON over JSONC", () => {
    const jsoncPath = path.join(process.env.LUMINE_HOME, "config.jsonc");
    const jsonPath = path.join(process.env.LUMINE_HOME, "config.json");

    fs.writeFileSync(jsoncPath, "{ // comment\n}");
    expect(getConfigFilePath()).toBe(jsoncPath);

    fs.writeFileSync(jsonPath, "{}");
    expect(getConfigFilePath()).toBe(jsonPath);
  });
});
