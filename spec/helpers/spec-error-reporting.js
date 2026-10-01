const { CompositeDisposable, Disposable } = require("@lumine-code/event-kit");

// Keep renderer errors visible without opening DevTools into the test viewport.
// The error events and Jasmine's own uncaught-error handling remain intact.
module.exports = function installSpecErrorReporting(
  environment,
  { headless, log = (...args) => console.log(...args) },
) {
  const disposables = new CompositeDisposable(
    environment.runtime.onWillThrowError(({ message, url, line, column, originalError }) => {
      log(`Uncaught error during spec run: ${message}`);
      log(`  at ${url ? `${url}:${line}:${column}` : "unknown location"}`);
      if (originalError?.stack) log(String(originalError.stack));
    }),
  );

  if (headless) {
    for (const name of ["openDevTools", "executeJavaScriptInDevTools"]) {
      const descriptor = Object.getOwnPropertyDescriptor(environment.window, name);
      environment.window[name] = () => Promise.resolve();
      disposables.add(
        new Disposable(() => {
          if (descriptor) Object.defineProperty(environment.window, name, descriptor);
          else delete environment.window[name];
        }),
      );
    }
  }

  return disposables;
};
