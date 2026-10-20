// Optional historical oracle; never imported by src/ or the normal test suite.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");

function resolveReference(directory = process.env.LUMINE_NATIVE_SUPERSTRING) {
  if (!directory)
    throw new Error(
      "Native comparison is opt-in. Set LUMINE_NATIVE_SUPERSTRING to a separately built " +
        "native Superstring directory (reference revision 809c57b536eca226a6cb9433bc75e07a39462574).",
    );
  const root = fs.realpathSync(path.resolve(directory));
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@lumine-code/superstring")
    throw new Error("Expected the native @lumine-code/superstring reference package");
  const binding = path.join(root, "build", "Release", "superstring.node");
  if (!fs.existsSync(binding)) throw new Error(`Build the native reference first: ${binding}`);
  return {
    root,
    entry: createRequire(manifestPath).resolve(root),
    binding,
    bindingSha256: createHash("sha256").update(fs.readFileSync(binding)).digest("hex"),
  };
}

module.exports = {
  resolveReference,
  load: () => {
    const reference = resolveReference();
    const value = require(reference.entry);
    if (!require.cache[reference.binding])
      throw new Error("The selected reference did not load its native Release binding");
    return value;
  },
};
