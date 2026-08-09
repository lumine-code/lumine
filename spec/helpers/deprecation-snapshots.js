const _ = require("@lumine-code/underscore-plus");
const Grim = require("@lumine-code/grim");

let grimDeprecationsSnapshot = null;
let stylesDeprecationsSnapshot = null;

jasmine.snapshotDeprecations = function () {
  grimDeprecationsSnapshot = _.clone(Grim.deprecations);
  return (stylesDeprecationsSnapshot = _.clone(lumine.styles.deprecationsBySourcePath));
};

jasmine.restoreDeprecationsSnapshot = function () {
  Grim.deprecations = grimDeprecationsSnapshot;
  return (lumine.styles.deprecationsBySourcePath = stylesDeprecationsSnapshot);
};
