// jasmine-core decides it was loaded as browser ESM from the presence of a
// `document`, and the editor's specs run in a renderer, where there is one, so
// it says so once per run. Version 6 let the verdict be unset again through
// `jasmine.private`; 7 keeps that closed over and exposes nothing.
//
// There is no supported way left to silence it. Shadowing `document` across the
// load does work in plain Node, but not here: in a renderer it is a
// non-configurable accessor on Window.prototype and `defineProperty` throws. So
// the notice stands, and it is one line rather than a failure.
let Jasmine = require("jasmine");
let jasmine = new Jasmine();

window["jasmine"] = jasmine.jasmine;

module.exports = jasmine;
