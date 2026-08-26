const fs = require("@lumine-code/fs-plus");
const path = require("path");
const temp = require("@lumine-code/temp").track();

describe("RipgrepDirectorySearcher", () => {
  it("converts every UTF-8 submatch range from bytes to buffer columns", async () => {
    const projectDirectory = fs.realpathSync.native(temp.mkdirSync("ripgrep-unicode-ranges-"));
    const filePath = path.join(projectDirectory, "unicode.txt");
    fs.writeFileSync(filePath, "CAFÉ café\n");
    lumine.project.setPaths([projectDirectory]);
    const results = [];

    await lumine.workspace.scan(/café/giu, {}, (result) => results.push(result));

    expect(results).toHaveLength(1);
    expect(results[0].matches.map((match) => match.range)).toEqual([
      [
        [0, 0],
        [0, 4],
      ],
      [
        [0, 5],
        [0, 9],
      ],
    ]);
  });
});
