require("./electron-rm-sync-compatibility");
const Module = require("node:module");
const Point = require("./point");
const Range = require("./range");
const SyntaxWorkerEndpoint = require("./syntax-worker-endpoint");
const SyntaxWorkerHost = require("./syntax-worker-host");

exports.connect = function (port) {
  // Syntax-only package modules share the public coordinate types. Renderer
  // objects deliberately have no counterpart in this execution environment.
  const load = Module._load;
  Module._load = function (request, ...args) {
    if (request === "lumine") return { Point, Range };
    return load.call(this, request, ...args);
  };
  const send = (message, transfer = []) => port.postMessage(message, transfer);
  const host = new SyntaxWorkerHost({ notify: (event) => send({ type: "event", ...event }) });
  const endpoint = new SyntaxWorkerEndpoint({
    send,
    dispatch: (operation, data, context) => host.dispatch(operation, data, context),
    control: (message) => host.control(message),
  });
  port.onmessage = ({ data }) => endpoint.receive(data);
  return { host, endpoint };
};
