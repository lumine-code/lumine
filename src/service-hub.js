const { Disposable } = require("@lumine-code/event-kit");
const { Range, SemVer } = require("semver");

// One service handed to one consumer, held by both sides.
//
// A provider going away means "the service is gone"; a consumer going away
// means "the package that took it is gone". Both have to reach the disposable
// the consumer returned, and neither may dispose it twice -- consumers hand
// back plain `{dispose}` objects that are not required to be idempotent.
class Registration {
  constructor(provider, consumer, disposable) {
    this.provider = provider;
    this.consumer = consumer;
    this.disposable = disposable;
    this.disposed = false;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.provider.registrations.delete(this);
    this.consumer.registrations.delete(this);
    this.disposable?.dispose();
  }
}

class Consumer {
  constructor(keyPath, versionRange, callback) {
    this.keyPath = keyPath;
    this.callback = callback;
    this.versionRange = new Range(versionRange);
    this.registrations = new Set();
    this.isDestroyed = false;
    // Whether any provider ever satisfied this consumer. A consumer that never
    // was is a feature that silently does not exist -- see `unmatchedConsumers`.
    this.isSatisfied = false;
  }

  destroy() {
    this.isDestroyed = true;
    for (const registration of [...this.registrations]) {
      registration.dispose();
    }
  }
}

class Provider {
  constructor(keyPath, servicesByVersion) {
    this.keyPath = keyPath;
    this.registrations = new Set();
    this.servicesByVersion = {};
    this.versions = [];
    for (const version in servicesByVersion) {
      this.servicesByVersion[version] = servicesByVersion[version];
      this.versions.push(new SemVer(version));
    }
    this.versions.sort((a, b) => b.compare(a));
  }

  provide(consumer) {
    if (consumer.keyPath !== this.keyPath) {
      return;
    }
    let versionMatched = false;
    for (const version of this.versions) {
      if (!consumer.versionRange.test(version)) {
        continue;
      }
      versionMatched = true;
      const service = this.servicesByVersion[version.toString()];
      if (service == null) {
        continue;
      }
      consumer.isSatisfied = true;
      const disposable = consumer.callback.call(null, service);
      if (typeof disposable?.dispose === "function") {
        const registration = new Registration(this, consumer, disposable);
        this.registrations.add(registration);
        consumer.registrations.add(registration);
      }
      return;
    }
    // The name matched and the delivery still did not happen, which is never
    // intentional: one side of a service was bumped without the other, or a
    // provider method returned nothing. Left alone the only symptom is a
    // feature quietly not being there. A given pair meets exactly once --
    // `provide` and `consume` each walk the other side one time -- so this
    // cannot repeat itself into noise.
    if (versionMatched) {
      console.warn(
        `Service "${this.keyPath}" matched ${consumer.versionRange.raw} but its provider ` +
          `supplied no service object; nothing was delivered`,
      );
    } else {
      console.warn(
        `Service "${this.keyPath}" is provided at ${this.versions.join(", ")} ` +
          `but consumed at ${consumer.versionRange.raw}; nothing was delivered`,
      );
    }
  }

  destroy() {
    for (const registration of [...this.registrations]) {
      registration.dispose();
    }
  }
}

module.exports = class ServiceHub {
  constructor() {
    this.consumers = [];
    this.providers = [];
  }

  /**
   * Provide a service by invoking the callback of all current and future
   * consumers matching the given service name and version range.
   *
   * @param keyPath - A `String` naming the service. Names are matched exactly. A `.` is a grouping convention for related services (`linter.provider`, `linter.registry`) and carries no lookup meaning: consuming `linter` does not match a provider of `linter.provider`.
   * @param version - A `String` containing a [semantic version](http://semver.org/) for the service's API.
   * @param service - An object exposing the service API.
   * @returns {Disposable} on which `.dispose()` can be called to remove the provided service.
   * @public
   * @api-status Public
   */
  provide(keyPath, version, service) {
    let servicesByVersion;
    if (service != null) {
      servicesByVersion = {};
      servicesByVersion[version] = service;
    } else {
      servicesByVersion = version;
    }
    const provider = new Provider(keyPath, servicesByVersion);
    this.providers.push(provider);
    for (const consumer of this.consumers.slice()) {
      if (!consumer.isDestroyed) {
        provider.provide(consumer);
      }
    }
    return new Disposable(() => {
      provider.destroy();
      const index = this.providers.indexOf(provider);
      if (index >= 0) {
        this.providers.splice(index, 1);
      }
    });
  }

  /**
   * Consume a service by invoking the given callback for all current
   * and future provided services matching the given service name and version
   * range.
   *
   * @param keyPath - A `String` naming the service. Names are matched exactly; see {@link #provide}.
   * @param versionRange - A `String` containing a [semantic version range](https://www.npmjs.org/doc/misc/semver.html) that any provided services for the given service name must satisfy.
   * @param callback - A `Function` to be called with current and future matching service objects.
   * @returns {Disposable} on which `.dispose()` can be called to remove the consumer. Disposing it also disposes whatever the callback returned, so a package that deactivates unregisters itself from the services it took.
   * @public
   * @api-status Public
   */
  consume(keyPath, versionRange, callback) {
    const consumer = new Consumer(keyPath, versionRange, callback);
    this.consumers.push(consumer);
    for (const provider of this.providers.slice()) {
      provider.provide(consumer);
    }
    return new Disposable(() => {
      consumer.destroy();
      const index = this.consumers.indexOf(consumer);
      if (index >= 0) {
        this.consumers.splice(index, 1);
      }
    });
  }

  /**
   * Names consumed by someone and provided by no one.
   *
   * Deliberately not reported on its own: packages activate lazily, so a
   * consumer with no provider *yet* is ordinary. It is a question to ask at a
   * moment the caller chooses -- a diagnostic command, `timecop` -- rather than
   * a warning this class can time correctly. Nothing makes the check statically
   * either, so this is the only place the question is answered at all.
   *
   * @returns {Array} of `{keyPath, versionRange}`.
   * @public
   * @api-status Public
   */
  unmatchedConsumers() {
    return this.consumers
      .filter((consumer) => !consumer.isSatisfied && !consumer.isDestroyed)
      .map((consumer) => ({
        keyPath: consumer.keyPath,
        versionRange: consumer.versionRange.raw,
      }));
  }

  /**
   * Clear out all service consumers and providers, disposing of any
   * disposables returned by previous consumers.
   *
   * @public
   * @api-status Public
   */
  clear() {
    for (const provider of this.providers.slice()) {
      provider.destroy();
    }
    for (const consumer of this.consumers.slice()) {
      consumer.destroy();
    }
    this.providers = [];
    this.consumers = [];
  }
};
