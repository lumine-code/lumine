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

const skippedDescriptions = [];

function documentIsFocused() {
  if (document.hasFocus()) return true;

  if (process.env.CI) {
    throw new Error("The spec window does not have focus; focus-dependent specs cannot run on CI");
  }

  return false;
}

jasmine.describeWithDocumentFocus = (description, fn) => {
  if (documentIsFocused()) return describe(description, fn);

  skippedDescriptions.push(description);
  return xdescribe(description, fn);
};

jasmine.itWithDocumentFocus = (description, fn, timeout) => {
  if (documentIsFocused()) return it(description, fn, timeout);

  skippedDescriptions.push(description);
  return xit(description, fn, timeout);
};

jasmine.getDocumentFocusSkips = () => skippedDescriptions.slice();
