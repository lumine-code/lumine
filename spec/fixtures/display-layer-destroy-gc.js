const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");

async function collect() {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    global.gc();
  }
}

function createViews() {
  const buffer = new TextBuffer({ text: "\talpha beta gamma delta\n".repeat(2000) });
  const first = buffer.addDisplayLayer({ softWrapColumn: 12 });
  const text = first.getText();
  const second = first.copy();
  assert.equal(second.layoutState, first.layoutState);
  const references = {
    layout: new WeakRef(first.layoutState),
    index: new WeakRef(first.spatialIndex),
    rows: new WeakRef(first.screenLineLengths),
    builder: new WeakRef(first.screenLineBuilder),
  };
  first.destroy();
  assert.equal(second.getText(), text);
  return { buffer, first, second, references };
}

async function main() {
  // Keep both destroyed view objects reachable, as an error's saved stack can.
  // Their heavyweight geometry must follow live views, not those stack frames.
  const retained = createViews();
  await collect();
  assert.ok(!retained.references.builder.deref(), "Destroyed view retained its line builder");
  assert.ok(retained.references.layout.deref(), "The live split lost its shared geometry");
  retained.second.destroy();
  retained.buffer.destroy();
  await collect();
  for (const [name, reference] of Object.entries(retained.references))
    assert.ok(!reference.deref(), `Destroyed views retained ${name}`);
  assert.ok(retained.first.isDestroyed());
  assert.ok(retained.second.isDestroyed());
  console.log("Destroyed views release geometry while live splits keep it");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
