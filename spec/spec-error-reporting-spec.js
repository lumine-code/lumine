const { Emitter } = require("@lumine-code/event-kit");
const installSpecErrorReporting = require("./helpers/spec-error-reporting");

describe("Spec error reporting", () => {
  let emitter, environment, reporting, log;

  beforeEach(() => {
    emitter = new Emitter();
    environment = {
      runtime: { onWillThrowError: (callback) => emitter.on("will-throw-error", callback) },
      window: Object.create({
        openDevTools: jasmine.createSpy("openDevTools"),
        executeJavaScriptInDevTools: jasmine.createSpy("executeJavaScriptInDevTools"),
      }),
    };
    log = jasmine.createSpy("log");
  });

  afterEach(() => {
    reporting?.dispose();
    emitter.dispose();
  });

  it("logs headless errors without preventing their delivery", async () => {
    reporting = installSpecErrorReporting(environment, { headless: true, log });
    const listener = jasmine.createSpy("error listener");
    emitter.on("will-throw-error", listener);
    const error = new Error("broken renderer");
    const event = {
      message: error.message,
      url: "source.js",
      line: 12,
      column: 3,
      originalError: error,
      preventDefault: jasmine.createSpy("preventDefault"),
    };

    emitter.emit("will-throw-error", event);

    expect(log).toHaveBeenCalledWith("Uncaught error during spec run: broken renderer");
    expect(log).toHaveBeenCalledWith("  at source.js:12:3");
    expect(log).toHaveBeenCalledWith(error.stack);
    expect(listener).toHaveBeenCalledWith(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    await expectAsync(environment.window.openDevTools()).toBeResolved();
    await expectAsync(environment.window.executeJavaScriptInDevTools("console")).toBeResolved();
    expect(Object.getPrototypeOf(environment.window).openDevTools).not.toHaveBeenCalled();
    expect(
      Object.getPrototypeOf(environment.window).executeJavaScriptInDevTools,
    ).not.toHaveBeenCalled();
  });

  it("keeps DevTools available in GUI runs and handles errors without a stack", () => {
    reporting = installSpecErrorReporting(environment, { headless: false, log });
    emitter.emit("will-throw-error", { message: "unknown fault" });
    environment.window.openDevTools();
    environment.window.executeJavaScriptInDevTools("console");

    expect(log.calls.allArgs()).toEqual([
      ["Uncaught error during spec run: unknown fault"],
      ["  at unknown location"],
    ]);
    expect(Object.getPrototypeOf(environment.window).openDevTools).toHaveBeenCalled();
    expect(
      Object.getPrototypeOf(environment.window).executeJavaScriptInDevTools,
    ).toHaveBeenCalledWith("console");
  });

  it("restores own and inherited methods and removes its observer on disposal", () => {
    environment.window.executeJavaScriptInDevTools = jasmine.createSpy("own method");
    const descriptor = Object.getOwnPropertyDescriptor(
      environment.window,
      "executeJavaScriptInDevTools",
    );
    reporting = installSpecErrorReporting(environment, { headless: true, log });
    reporting.dispose();

    expect(Object.hasOwn(environment.window, "openDevTools")).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(environment.window, "executeJavaScriptInDevTools"),
    ).toEqual(descriptor);
    emitter.emit("will-throw-error", { message: "after cleanup" });
    expect(log).not.toHaveBeenCalled();
  });
});
