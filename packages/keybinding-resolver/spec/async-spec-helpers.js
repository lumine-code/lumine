function beforeEach(fn) {
  global.beforeEach(function () {
    const result = fn();
    if (result instanceof Promise) {
      waitsForPromise(() => result);
    }
  });
}

function afterEach(fn) {
  global.afterEach(function () {
    const result = fn();
    if (result instanceof Promise) {
      waitsForPromise(() => result);
    }
  });
}

["it", "fit", "ffit", "fffit"].forEach(function (name) {
  module.exports[name] = function (description, fn) {
    global[name](description, function () {
      const result = fn();
      if (result instanceof Promise) {
        waitsForPromise(() => result);
      }
    });
  };
});

function waitsForPromise(fn) {
  const promise = fn();
  global.waitsFor("spec promise to resolve", function (done) {
    promise.then(done, function (error) {
      jasmine.getEnv().currentSpec.fail(error);
      done();
    });
  });
}

// Merge rather than assign: the forEach above already hung it/fit/ffit/fffit
// onto module.exports.
Object.assign(module.exports, { beforeEach, afterEach });
