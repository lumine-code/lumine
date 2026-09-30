const fs = require("fs");
// The editor and its Node-mode child both provide the built-in SQLite API.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { DatabaseSync } = require("node:sqlite");
const { collectRetiredSnapshots, pruneRetiredSnapshots } = require("./session-state-retention");

let database = null;
let candidates = null;

function finish(message) {
  database?.close();
  database = null;
  process.send(message, () => process.disconnect());
}

process.on("message", (message) => {
  try {
    if (message?.type === "scan") {
      if (!fs.existsSync(message.databasePath)) {
        finish({ type: "complete", result: { removed: 0 } });
        return;
      }
      database = new DatabaseSync(message.databasePath);
      // Never make foreground saves wait behind a long cleanup transaction.
      // If another writer owns the lock, leave this sweep for another event.
      database.exec("PRAGMA busy_timeout = 100");
      candidates = collectRetiredSnapshots(database);
      process.send({ type: "candidates-ready" });
    } else if (message?.type === "prune" && database && candidates) {
      const result = pruneRetiredSnapshots(database, candidates, {
        protectedWindowIds: message.protectedWindowIds,
      });
      finish({ type: "complete", result });
    }
  } catch (error) {
    finish({ type: "failure", message: error.message });
  }
});

process.on("disconnect", () => {
  database?.close();
  database = null;
});
