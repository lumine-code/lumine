const timers = require("node:timers");
const formatNodeTimer = require("./helpers/format-node-timer");

describe("Native timer diagnostics", () => {
  it("formats timer identities without reading their async context or other internal properties", () => {
    // Exercise the renderer's real native handles here. Creating an ALS context
    // in this renderer aborts Electron before the formatter can run; genuine
    // ALS coverage lives in main-process/jasmine-native-timers.test.js.
    const handles = [
      timers.setTimeout(() => {}, 10000),
      timers.setInterval(() => {}, 10000),
      timers.setImmediate(() => {}),
    ];
    try {
      for (const handle of handles) {
        Object.defineProperty(handle, Symbol("opaque context"), {
          enumerable: true,
          get() {
            throw new Error("Native timer internals must not be inspected");
          },
        });
        expect(handle).toBe(handle);
        expect(jasmine.pp(handle)).toBe(formatNodeTimer(handle));
      }
      expect(handles[0]).not.toBe(handles[1]);
      expect(formatNodeTimer(handles[0])).not.toBe(formatNodeTimer(handles[1]));
      expect(formatNodeTimer(handles[2])).toMatch(/^Node Immediate #\d+$/);
      expect(formatNodeTimer({})).toBeUndefined();
      expect(formatNodeTimer(null)).toBeUndefined();
    } finally {
      timers.clearTimeout(handles[0]);
      timers.clearInterval(handles[1]);
      timers.clearImmediate(handles[2]);
    }
  });
});
