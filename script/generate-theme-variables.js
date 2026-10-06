const fs = require("node:fs");
const path = require("node:path");
const { buildThemeVariablesStylesheet } = require("../src/theme-variables");
const prettier = require("prettier");
const options = require("../prettier.config");

const target = path.join(__dirname, "..", "static", "variables", "base-variables.css");
async function main() {
  const source = await prettier.format(buildThemeVariablesStylesheet(), {
    ...options,
    parser: "css",
    endOfLine: "lf",
  });
  if (process.argv.includes("--check")) {
    if (fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n") !== source) {
      console.error(
        "Theme defaults differ from the manifest. Run npm run generate:theme-variables.",
      );
      process.exitCode = 1;
    }
  } else {
    fs.writeFileSync(target, source);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
