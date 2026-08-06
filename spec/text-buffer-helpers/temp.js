const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "text-buffer-"));

// Retries because Windows keeps a directory non-empty until the last handle on a child
// closes, and `force` swallows only ENOENT.
process.on("exit", () =>
  fs.rmSync(rootPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
);

module.exports = {
  track() {},

  mkdirSync(prefix = "directory") {
    return fs.mkdtempSync(path.join(rootPath, `${prefix}-`));
  },

  openSync(prefix = "file") {
    const filePath = path.join(rootPath, `${prefix}-${randomUUID()}`);
    fs.closeSync(fs.openSync(filePath, "w"));
    return { path: filePath };
  },
};
