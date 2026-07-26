const { Disposable, CompositeDisposable } = require("event-kit");
const { Range, SemVer } = require("semver");

class Consumer {
  constructor(keyPath, versionRange, callback) {
    this.keyPath = keyPath;
    this.callback = callback;
    this.versionRange = new Range(versionRange);
  }
}

class Provider {
  constructor(keyPath, servicesByVersion) {
    this.keyPath = keyPath;
    this.consumersDisposable = new CompositeDisposable();
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
    for (const version of this.versions) {
      if (consumer.versionRange.test(version)) {
        const service = this.servicesByVersion[version.toString()];
        if (service) {
          const consumerDisposable = consumer.callback.call(null, service);
          if (typeof consumerDisposable?.dispose === "function") {
            this.consumersDisposable.add(consumerDisposable);
          }
          return;
        }
      }
    }
  }

  destroy() {
    return this.consumersDisposable.dispose();
  }
}

module.exports = class ServiceHub {
  constructor() {
    this.consumers = [];
    this.providers = [];
  }

  // Public: Provide a service by invoking the callback of all current and future
  // consumers matching the given service name and version range.
  //
  // * `keyPath` A {String} naming the service. Names are matched exactly. A `.`
  //   is a grouping convention for related services (`linter.provider`,
  //   `linter.registry`) and carries no lookup meaning: consuming `linter` does
  //   not match a provider of `linter.provider`.
  // * `version` A {String} containing a [semantic version](http://semver.org/)
  //   for the service's API.
  // * `service` An object exposing the service API.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to remove the
  // provided service.
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
      return this.providers.splice(index, 1);
    });
  }

  // Public: Consume a service by invoking the given callback for all current
  // and future provided services matching the given service name and version
  // range.
  //
  // * `keyPath` A {String} naming the service. Names are matched exactly; see
  //   {::provide}.
  // * `versionRange` A {String} containing a [semantic version range](https://www.npmjs.org/doc/misc/semver.html)
  //   that any provided services for the given service name must satisfy.
  // * `callback` A {Function} to be called with current and future matching
  //   service objects.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to remove the
  // consumer.
  consume(keyPath, versionRange, callback) {
    const consumer = new Consumer(keyPath, versionRange, callback);
    this.consumers.push(consumer);
    for (const provider of this.providers.slice()) {
      provider.provide(consumer);
    }
    return new Disposable(() => {
      const index = this.consumers.indexOf(consumer);
      if (index >= 0) {
        return this.consumers.splice(index, 1);
      }
    });
  }

  // Public: Clear out all service consumers and providers, disposing of any
  // disposables returned by previous consumers.
  clear() {
    for (const provider of this.providers.slice()) {
      provider.destroy();
    }
    this.providers = [];
    return (this.consumers = []);
  }
};
