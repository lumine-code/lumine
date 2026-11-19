const { computeLineDiffHunks } = require("./line-diff");

function toText(source) {
  if (!ArrayBuffer.isView(source)) return String(source);
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
}

function compute({ oldSource, newSource, options }) {
  return computeLineDiffHunks(toText(oldSource), toText(newSource), options);
}

if (require.main === module) {
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", (message) => parentPort.postMessage(compute(message)));
}

exports.connect = (scope) => {
  scope.onmessage = ({ data }) => scope.postMessage(compute(data));
};
