const path = require("path");

const fixturePackagesPath = path.resolve(__dirname, "../fixtures/packages");
lumine.packages.packageDirPaths.unshift(fixturePackagesPath);
