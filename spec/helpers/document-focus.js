// Specs that assert real focus behaviour need the spec window to own the OS
// focus: `document.hasFocus()` gates whether Chromium moves `activeElement` and
// fires focus and blur events at all, so without it the assertions describe the
// host's window manager rather than the editor.
//
// CI shows the window and focuses it before the runner loads a single spec (see
// src/initialize-test-window.js), so the precondition is guaranteed there and a
// missing focus means the harness broke: throw, so CI can never quietly stop
// covering these specs. Locally the window is shown without stealing focus from
// whatever the developer is doing, so declare the specs disabled instead —
// jasmine reports them as pending rather than failing, and the runner prints a
// summary naming the reason once the run finishes.
//
// Both wrappers decide at declaration time, which is why they replace
// `describe`/`it` rather than being called from inside a spec: the runner
// swallows a `pending()` raised in a spec body into a pass, and one raised in a
// `beforeEach` does not stop the body from running.
//
// Deciding at declaration time is not enough on its own. The runner restores
// focus before every spec on CI, but that hook runs before the suite's own
// `beforeEach`s, and a host can take focus at any point in a run that lasts
// minutes. A body that then runs unfocused reports whatever it happened to
// assert — a cursor with `opacity: 0`, say — instead of the precondition it
// actually lost, so re-establish focus as late as possible: for a spec that is
// after every hook has run, and for a suite that is the earliest its own
// `beforeEach` chain allows.

const focusTestWindow = require("../../src/focus-test-window");

const skippedDescriptions = [];

function documentIsFocused() {
  if (document.hasFocus()) return true;

  if (process.env.CI) {
    throw new Error("The spec window does not have focus; focus-dependent specs cannot run on CI");
  }

  return false;
}

// Resolves immediately while the window still has focus, and otherwise waits
// for it to come back, throwing with a message that names the precondition.
function requireDocumentFocus() {
  return focusTestWindow();
}

function withDocumentFocus(fn) {
  // Jasmine rejects a spec that both takes `done` and returns a promise, so the
  // callback style has to be preserved rather than wrapped in an async function.
  if (fn.length > 0) {
    return function (done) {
      requireDocumentFocus().then(() => fn.call(this, done), done);
    };
  }

  return async function () {
    await requireDocumentFocus();
    return fn.call(this);
  };
}

jasmine.describeWithDocumentFocus = (description, fn) => {
  if (!documentIsFocused()) {
    skippedDescriptions.push(description);
    return xdescribe(description, fn);
  }

  return describe(description, function () {
    beforeEach(requireDocumentFocus);
    fn.call(this);
  });
};

jasmine.itWithDocumentFocus = (description, fn, timeout) => {
  if (!documentIsFocused()) {
    skippedDescriptions.push(description);
    return xit(description, fn, timeout);
  }

  return it(description, withDocumentFocus(fn), timeout);
};

jasmine.getDocumentFocusSkips = () => skippedDescriptions.slice();
