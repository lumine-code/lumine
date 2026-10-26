const fs = require("node:fs");
const path = require("node:path");
const TextStore = require("../../src/text-store");
const file = path.join(process.argv[2], "reload-source.txt");
const print = (phase, extra = {}) => {
  global.gc();
  process.stdout.write(JSON.stringify({ phase, ...process.memoryUsage(), ...extra }) + "\n");
};

(async () => {
  const chunk = Buffer.from(("DAT 0123456789 " + "x".repeat(49) + "\n").repeat(1024));
  const size = 80 * 1024 * 1024,
    fd = fs.openSync(file, "wx");
  try {
    for (let offset = 0; offset < size;) {
      chunk.write(String(offset).padStart(12, "0"));
      const count = Math.min(chunk.length, size - offset);
      fs.writeSync(fd, chunk, 0, count);
      offset += count;
    }
  } finally {
    fs.closeSync(fd);
  }
  const original = new TextStore();
  await original.load(file, { patch: false });
  const copy = new TextStore(original.getTextSnapshot());
  copy.setTextInRange({ start: copy.getExtent(), end: copy.getExtent() }, "\nWF_SAVED_α😀\r\n");
  await copy.save(file);
  const loaded = new TextStore();
  await loaded.load(file, { patch: false });
  const base = loaded.getTextSnapshot();
  loaded.baseTextDigest();
  // Keep the original, saved copy and loaded saved base alive like the real
  // renderer workflow. The fixed heap is deliberately not raised for reload.
  global.retainedSources = [original, copy, loaded, base];
  loaded.setTextInRange({ start: { row: 0, column: 0 }, end: { row: 0, column: 0 } }, "WF_UNSAVED");
  print("before-reload");
  await loaded.load(file, { force: true });
  if (!loaded.getTextSnapshot().equals(copy.getTextSnapshot()))
    throw Error("Reload content mismatch");
  print("after-reload", { reusedBase: loaded.getTextSnapshot() === base });
})().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
