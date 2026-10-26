// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { DatabaseSync } = require("node:sqlite");

let database, insert;
process.on("message", (message) => {
  try {
    if (message.type === "open") {
      database = new DatabaseSync(message.databasePath);
      database.exec("PRAGMA busy_timeout = 5000");
      insert = database.prepare("INSERT OR IGNORE INTO TextSnapshotNodes1 VALUES (?, ?, ?, ?)");
    } else if (message.type === "write") {
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const row of message.rows) insert.run(...row);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } else if (message.type === "close") {
      database.close();
      database = null;
      process.send({ id: message.id }, () => process.disconnect());
      return;
    }
    process.send({ id: message.id });
  } catch (error) {
    process.send({ id: message.id, error: error.message });
  }
});

process.on("disconnect", () => {
  database?.close();
  database = null;
});
